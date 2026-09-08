// ==========================================================================
// မြင်သာကြက်ကင် — Worker API
// Customer POS  ->  /api/send-order        (public)
// Admin Panel   ->  /api/admin/*           (protected by X-Admin-Key header)
// Database      ->  Cloudflare D1 (binding: DB)
// ==========================================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function requireAdmin(request, env) {
  const key = request.headers.get("X-Admin-Key") || "";
  const expected = env.ADMIN_KEY || "";
  if (!expected) return false; // if no key configured, lock everything down
  return key === expected;
}

async function ensureSchema(env) {
  // Safe to run on every cold start — CREATE TABLE IF NOT EXISTS is idempotent.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_code TEXT,
      customer_name TEXT,
      phone TEXT,
      items_json TEXT,
      total INTEGER,
      status TEXT DEFAULT 'New',
      payment_status TEXT DEFAULT 'Pending',
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price INTEGER DEFAULT 0,
      category TEXT DEFAULT '',
      image TEXT DEFAULT '',
      available INTEGER DEFAULT 1,
      stock INTEGER DEFAULT 0,
      low_stock_threshold INTEGER DEFAULT 10,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
  ]);
}

// ---------------------------------------------------------------------------
// Public: receive an order from the customer POS, store it in D1, forward to Telegram
// ---------------------------------------------------------------------------
async function handleSendOrder(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (!body || !body.text) {
    return json({ ok: false, error: "Missing text" }, 400);
  }

  // Structured fields are optional so older client versions still work,
  // but without them the order can't be saved to the database.
  const voucherCode = body.vCode || null;
  const customerName = body.name || null;
  const phone = body.phone || null;
  const items = Array.isArray(body.items) ? body.items : null;
  const total = Number.isFinite(body.total) ? body.total : null;

  let orderId = null;
  if (items && total !== null) {
    try {
      const result = await env.DB.prepare(
        `INSERT INTO orders (voucher_code, customer_name, phone, items_json, total, status, payment_status)
         VALUES (?, ?, ?, ?, ?, 'New', 'Pending')`
      )
        .bind(voucherCode, customerName, phone, JSON.stringify(items), total)
        .run();
      orderId = result.meta.last_row_id;
    } catch (e) {
      // Don't block the Telegram notification just because the DB insert failed.
      console.log("DB insert failed:", e.message);
    }
  }

  let tgResult = { ok: false, error: "BOT_TOKEN not configured" };
  if (env.BOT_TOKEN && env.CHAT_ID) {
    try {
      const telegramUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
      const tgResponse = await fetch(telegramUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.CHAT_ID,
          text: body.text,
          parse_mode: "Markdown",
        }),
      });
      tgResult = await tgResponse.json();
    } catch (e) {
      tgResult = { ok: false, error: String(e) };
    }
  }

  return json({ ok: true, order_id: orderId, telegram: tgResult });
}

// ---------------------------------------------------------------------------
// Admin: dashboard stats
// ---------------------------------------------------------------------------
async function handleStats(request, env) {
  const db = env.DB;

  const totalsToday = await db
    .prepare(
      `SELECT COALESCE(SUM(total),0) as revenue, COUNT(*) as orders
       FROM orders WHERE date(created_at) = date('now') AND status != 'Cancelled'`
    )
    .first();

  const totalsYesterday = await db
    .prepare(
      `SELECT COALESCE(SUM(total),0) as revenue, COUNT(*) as orders
       FROM orders WHERE date(created_at) = date('now','-1 day') AND status != 'Cancelled'`
    )
    .first();

  const totalsAllTime = await db
    .prepare(
      `SELECT COALESCE(SUM(total),0) as revenue, COUNT(*) as orders
       FROM orders WHERE status != 'Cancelled'`
    )
    .first();

  const newOrdersToday = await db
    .prepare(`SELECT COUNT(*) as c FROM orders WHERE date(created_at) = date('now') AND status = 'New'`)
    .first();
  const newOrdersYesterday = await db
    .prepare(`SELECT COUNT(*) as c FROM orders WHERE date(created_at) = date('now','-1 day') AND status = 'New'`)
    .first();

  const customersTotal = await db
    .prepare(`SELECT COUNT(DISTINCT phone) as c FROM orders WHERE phone IS NOT NULL AND phone != ''`)
    .first();
  const customersLastWeek = await db
    .prepare(
      `SELECT COUNT(DISTINCT phone) as c FROM orders
       WHERE phone IS NOT NULL AND phone != '' AND date(created_at) < date('now','-7 day')`
    )
    .first();

  const statusCounts = await db
    .prepare(
      `SELECT status, COUNT(*) as c FROM orders GROUP BY status`
    )
    .all();
  const statusMap = { New: 0, Processing: 0, Completed: 0, Cancelled: 0 };
  for (const row of statusCounts.results || []) {
    if (statusMap[row.status] !== undefined) statusMap[row.status] = row.c;
  }

  const paymentCounts = await db
    .prepare(`SELECT payment_status, COUNT(*) as c FROM orders GROUP BY payment_status`)
    .all();
  const paymentMap = { Paid: 0, Pending: 0, Failed: 0 };
  let paymentTotal = 0;
  for (const row of paymentCounts.results || []) {
    if (paymentMap[row.payment_status] !== undefined) paymentMap[row.payment_status] = row.c;
    paymentTotal += row.c;
  }
  const paymentPct = {};
  for (const k of Object.keys(paymentMap)) {
    paymentPct[k] = paymentTotal ? Math.round((paymentMap[k] / paymentTotal) * 100) : 0;
  }

  const lowStock = await db
    .prepare(`SELECT id, name, stock, low_stock_threshold FROM products WHERE stock <= low_stock_threshold AND available = 1 ORDER BY stock ASC LIMIT 10`)
    .all();

  const revenueSeries = await db
    .prepare(
      `SELECT date(created_at) as day, COALESCE(SUM(total),0) as revenue
       FROM orders WHERE status != 'Cancelled' AND date(created_at) >= date('now','-6 day')
       GROUP BY day ORDER BY day ASC`
    )
    .all();

  const recentOrders = await db
    .prepare(
      `SELECT id, voucher_code, customer_name, phone, total, status, payment_status, created_at
       FROM orders ORDER BY id DESC LIMIT 6`
    )
    .all();

  let topProducts = [];
  try {
    const tp = await db
      .prepare(
        `SELECT je.value ->> '$.name' as name,
                SUM(CAST(je.value ->> '$.qty' AS INTEGER)) as qty,
                SUM(CAST(je.value ->> '$.qty' AS INTEGER) * CAST(je.value ->> '$.price' AS INTEGER)) as revenue
         FROM orders o, json_each(o.items_json) je
         WHERE o.status != 'Cancelled'
         GROUP BY name ORDER BY qty DESC LIMIT 5`
      )
      .all();
    topProducts = tp.results || [];
  } catch (e) {
    topProducts = [];
  }

  function pctChange(now, prev) {
    if (!prev) return now > 0 ? 100 : 0;
    return Math.round(((now - prev) / prev) * 1000) / 10;
  }

  return json({
    ok: true,
    revenue: { today: totalsToday.revenue, allTime: totalsAllTime.revenue, changePct: pctChange(totalsToday.revenue, totalsYesterday.revenue) },
    orders: { today: totalsToday.orders, allTime: totalsAllTime.orders, changePct: pctChange(totalsToday.orders, totalsYesterday.orders) },
    newOrders: { today: newOrdersToday.c, changePct: pctChange(newOrdersToday.c, newOrdersYesterday.c) },
    customers: { total: customersTotal.c, changePct: pctChange(customersTotal.c, customersLastWeek.c) },
    statusCounts: statusMap,
    paymentPct,
    lowStock: lowStock.results || [],
    revenueSeries: revenueSeries.results || [],
    recentOrders: recentOrders.results || [],
    topProducts,
  });
}

// ---------------------------------------------------------------------------
// Admin: orders list (search / filter / pagination)
// ---------------------------------------------------------------------------
async function handleOrdersList(request, env) {
  const url = new URL(request.url);
  const search = (url.searchParams.get("search") || "").trim();
  const status = url.searchParams.get("status") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(50, Math.max(5, parseInt(url.searchParams.get("pageSize") || "10", 10)));
  const offset = (page - 1) * pageSize;

  let where = "WHERE 1=1";
  const binds = [];
  if (search) {
    where += ` AND (voucher_code LIKE ? OR customer_name LIKE ? OR phone LIKE ?)`;
    binds.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status) {
    where += ` AND status = ?`;
    binds.push(status);
  }

  const countRow = await env.DB.prepare(`SELECT COUNT(*) as c FROM orders ${where}`).bind(...binds).first();
  const rows = await env.DB
    .prepare(`SELECT * FROM orders ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...binds, pageSize, offset)
    .all();

  return json({ ok: true, total: countRow.c, page, pageSize, orders: rows.results || [] });
}

async function handleOrderUpdate(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const fields = [];
  const binds = [];
  if (body.status) {
    fields.push("status = ?");
    binds.push(body.status);
  }
  if (body.payment_status) {
    fields.push("payment_status = ?");
    binds.push(body.payment_status);
  }
  if (!fields.length) return json({ ok: false, error: "Nothing to update" }, 400);
  binds.push(id);
  await env.DB.prepare(`UPDATE orders SET ${fields.join(", ")} WHERE id = ?`).bind(...binds).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Admin: products CRUD
// ---------------------------------------------------------------------------
async function handleProductsList(env) {
  const rows = await env.DB.prepare(`SELECT * FROM products ORDER BY id DESC`).all();
  return json({ ok: true, products: rows.results || [] });
}

async function handleProductCreate(request, env) {
  let b;
  try {
    b = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  if (!b.name) return json({ ok: false, error: "Missing name" }, 400);
  const result = await env.DB
    .prepare(
      `INSERT INTO products (name, price, category, image, available, stock, low_stock_threshold)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      b.name,
      b.price ?? 0,
      b.category ?? "",
      b.image ?? "",
      b.available === false ? 0 : 1,
      b.stock ?? 0,
      b.low_stock_threshold ?? 10
    )
    .run();
  return json({ ok: true, id: result.meta.last_row_id });
}

async function handleProductUpdate(request, env, id) {
  let b;
  try {
    b = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const map = {
    name: b.name,
    price: b.price,
    category: b.category,
    image: b.image,
    available: b.available === undefined ? undefined : b.available ? 1 : 0,
    stock: b.stock,
    low_stock_threshold: b.low_stock_threshold,
  };
  const fields = [];
  const binds = [];
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      binds.push(v);
    }
  }
  if (!fields.length) return json({ ok: false, error: "Nothing to update" }, 400);
  binds.push(id);
  await env.DB.prepare(`UPDATE products SET ${fields.join(", ")} WHERE id = ?`).bind(...binds).run();
  return json({ ok: true });
}

async function handleProductDelete(env, id) {
  await env.DB.prepare(`DELETE FROM products WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Admin: customers (aggregated from orders)
// ---------------------------------------------------------------------------
async function handleCustomers(env) {
  const rows = await env.DB
    .prepare(
      `SELECT phone, MAX(customer_name) as name, COUNT(*) as orders, SUM(total) as spent, MAX(created_at) as last_order
       FROM orders WHERE phone IS NOT NULL AND phone != ''
       GROUP BY phone ORDER BY spent DESC LIMIT 100`
    )
    .all();
  return json({ ok: true, customers: rows.results || [] });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    try {
      if (env.DB) await ensureSchema(env);
    } catch (e) {
      console.log("Schema init error:", e.message);
    }

    // Public endpoint used by the customer-facing POS
    if (path === "/api/send-order") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleSendOrder(request, env);
    }

    // Everything else under /api/admin/* requires the admin key
    if (path.startsWith("/api/admin/")) {
      if (!requireAdmin(request, env)) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      if (path === "/api/admin/stats" && request.method === "GET") {
        return handleStats(request, env);
      }
      if (path === "/api/admin/orders" && request.method === "GET") {
        return handleOrdersList(request, env);
      }
      const orderMatch = path.match(/^\/api\/admin\/orders\/(\d+)$/);
      if (orderMatch && (request.method === "PATCH" || request.method === "PUT")) {
        return handleOrderUpdate(request, env, orderMatch[1]);
      }
      if (path === "/api/admin/products" && request.method === "GET") {
        return handleProductsList(env);
      }
      if (path === "/api/admin/products" && request.method === "POST") {
        return handleProductCreate(request, env);
      }
      const productMatch = path.match(/^\/api\/admin\/products\/(\d+)$/);
      if (productMatch && (request.method === "PUT" || request.method === "PATCH")) {
        return handleProductUpdate(request, env, productMatch[1]);
      }
      if (productMatch && request.method === "DELETE") {
        return handleProductDelete(env, productMatch[1]);
      }
      if (path === "/api/admin/customers" && request.method === "GET") {
        return handleCustomers(env);
      }
      // A cheap way for the admin panel to verify a key without hitting real data
      if (path === "/api/admin/ping" && request.method === "GET") {
        return json({ ok: true });
      }

      return json({ ok: false, error: "Not found" }, 404);
    }

    // Everything else: serve static files (the customer POS + admin panel)
    return env.ASSETS.fetch(request);
  },
};
