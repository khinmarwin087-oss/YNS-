// ==========================================================================
// မြင်သာကြက်ကင် — Worker API
// Customer POS  ->  /api/send-order        (public)
// Admin Panel   ->  /api/admin/*           (protected by X-Admin-Key header)
// Database      ->  Cloudflare D1 (binding: DB)
// Customer      ->  /api/order-status      (public — voucher + phone နှစ်ခုလုံး ကိုက်မှ ပြန်ပေး)
// Cron Trigger  ->  scheduled()            (မလက်ခံသေးသော အော်ဒါကို Telegram ဖြင့် ထပ်ခါထပ်ခါ သတိပေး)
// Env (optional)->  ADMIN_URL  (ဥပမာ https://yourshop.com/admin  — Telegram မက်ဆေ့ချ်ထဲက link အတွက်)
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
  if (!expected) return false;
  if (key.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

let schemaReady = false;
async function ensureSchema(env) {
  if (!env.DB || schemaReady) return;
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
  const extraCols = [
    ["pickup_date", "TEXT DEFAULT ''"],
    ["pickup_time", "TEXT DEFAULT ''"],
    ["tg_ok", "INTEGER"],                    // Telegram သို့ ပို့မြောက်/မမြောက် (1/0)
    ["remind_count", "INTEGER DEFAULT 0"],   // သတိပေးချက် ပို့ပြီးအကြိမ်ရေ
    ["reminded_at", "TEXT"],                 // နောက်ဆုံး သတိပေးချိန်
  ];
  for (const [col, def] of extraCols) {
    try {
      await env.DB.prepare(`ALTER TABLE orders ADD COLUMN ${col} ${def}`).run();
    } catch (_) { /* ကော်လံ ရှိပြီးသား */ }
  }
  schemaReady = true;
}

function escMd(s) {
  // Telegram legacy Markdown ကို မပျက်စေရန် အထူးအက္ခရာများ escape လုပ်ခြင်း
  return String(s ?? "").replace(/([_*`\[])/g, "\\$1");
}

async function sendTelegram(env, text) {
  if (!env.BOT_TOKEN || !env.CHAT_ID) return { ok: false, error: "BOT_TOKEN / CHAT_ID မသတ်မှတ်ရသေးပါ" };
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  const post = async (extra) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.CHAT_ID, text, disable_web_page_preview: true, ...extra }),
    });
    return r.json();
  };
  try {
    let res = await post({ parse_mode: "Markdown" });
    if (!res.ok) res = await post({}); // Markdown error ဖြစ်ရင် plain text နဲ့ ထပ်ပို့
    return res.ok ? { ok: true } : { ok: false, error: res.description || "Telegram error" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function adminLink(env, id) {
  const base = String(env.ADMIN_URL || "").trim().replace(/\/+$/, "");
  return base ? `${base}/orders.html#o${id}` : "";
}

async function handleSendOrder(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);

  const name = String(body?.name ?? "").trim().slice(0, 100);
  const phone = String(body?.phone ?? "").trim().slice(0, 100);
  const date = String(body?.date ?? "").trim().slice(0, 30);
  const time = String(body?.time ?? "").trim().slice(0, 10);
  if (!name || !phone) return json({ ok: false, error: "အမည်နှင့် ဖုန်းနံပါတ် လိုအပ်ပါသည်" }, 400);

  // client က id + qty သာ ပို့ရမယ် — စျေးနှုန်းကို DB ကနေ server မှာပဲ တွက်မယ်
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const qtyById = new Map();
  for (const it of rawItems) {
    const id = parseInt(it?.id, 10);
    const qty = parseInt(it?.qty, 10);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty <= 0 || qty > 99) {
      return json({ ok: false, error: "ပစ္စည်းအချက်အလက် မှားနေပါသည်" }, 400);
    }
    qtyById.set(id, Math.min(99, (qtyById.get(id) || 0) + qty));
  }
  if (!qtyById.size || qtyById.size > 50) {
    return json({ ok: false, error: "ခြင်းတောင်းထဲတွင် ပစ္စည်း မရှိပါ" }, 400);
  }

  const ids = [...qtyById.keys()];
  const found = await env.DB
    .prepare(`SELECT id, name, price, available FROM products WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all();
  const byId = new Map((found.results || []).map((r) => [r.id, r]));

  const items = [];
  let total = 0;
  for (const [id, qty] of qtyById) {
    const p = byId.get(id);
    if (!p) return json({ ok: false, error: "ပစ္စည်းတစ်ခု မရှိတော့ပါ၊ စာမျက်နှာကို Refresh လုပ်ပါ" }, 400);
    if (!p.available) return json({ ok: false, error: `${p.name} မရနိုင်သေးပါ` }, 400);
    const price = Number(p.price) || 0;
    items.push({ id, name: p.name, price, qty, total: price * qty });
    total += price * qty;
  }

  let orderId;
  try {
    const result = await env.DB
      .prepare(
        `INSERT INTO orders (voucher_code, customer_name, phone, items_json, total, status, payment_status, pickup_date, pickup_time)
         VALUES (NULL, ?, ?, ?, ?, 'New', 'Pending', ?, ?)`
      )
      .bind(name, phone, JSON.stringify(items), total, date, time)
      .run();
    orderId = result.meta.last_row_id;
  } catch (e) {
    console.log("DB insert failed:", e.message);
    return json({ ok: false, error: "အော်ဒါ သိမ်းမရပါ၊ ပြန်ကြိုးစားပါ" }, 500);
  }

  // ဘောက်ချာနံပါတ်ကို order id နဲ့ တည်ဆောက် (ထပ်နေနိုင်ခြေ မရှိ)
  const vCode = `#MS-${String(orderId).padStart(4, "0")}`;
  try {
    await env.DB.prepare(`UPDATE orders SET voucher_code = ? WHERE id = ?`).bind(vCode, orderId).run();
  } catch (e) {
    console.log("Voucher update failed:", e.message);
  }

  const lines = items.map((i) => `▪️ ${escMd(i.name)} (${i.qty} ခု)`);
  const text =
    `🍗 *မြင်သာကြက်ကင် - အော်ဒါအသစ်*\n` +
    `🧾 *ဘောက်ချာနံပါတ်:* \`${vCode}\`\n` +
    `👤 *အမည်:* ${escMd(name)}\n` +
    `📞 *ဖုန်း/ID:* ${escMd(phone)}\n` +
    `📅 *နေ့ရက်:* ${escMd(date)}\n` +
    `🕒 *အချိန်:* ${escMd(time)}\n` +
    `━━━━━━━━━━━━━━\n${lines.join("\n")}\n━━━━━━━━━━━━━━\n` +
    `💰 *စုစုပေါင်း:* *${total.toLocaleString("en-US")} MMK*` +
    (adminLink(env, orderId) ? `\n🔗 ${adminLink(env, orderId)}` : "");

  const tgResult = await sendTelegram(env, text);
  try {
    await env.DB.prepare(`UPDATE orders SET tg_ok = ? WHERE id = ?`).bind(tgResult.ok ? 1 : 0, orderId).run();
  } catch (_) {}

  return json({ ok: true, order_id: orderId, vCode, total, items, telegram: { ok: !!tgResult.ok } });
}

// ---------------------------------------------------------------------------
// Customer: ကိုယ့်အော်ဒါ ဘယ်အဆင့်ရောက်ပြီလဲ ကြည့်ရန်
// voucher နံပါတ် + ဖုန်း/ID နှစ်ခုလုံး ကိုက်မှသာ ပြန်ပေးသည် (တခြားသူ၏ အော်ဒါ မမြင်ရအောင်)
// ---------------------------------------------------------------------------
async function handleOrderStatus(request, env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const list = Array.isArray(body?.orders) ? body.orders.slice(0, 10) : [];
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[\s\-()+]/g, "");
  const out = {};

  for (const o of list) {
    const code = String(o?.vCode ?? "").trim();
    const ph = norm(o?.phone);
    if (!code || !ph) continue;
    const rows = await env.DB
      .prepare(
        `SELECT phone, status, payment_status, total, pickup_date, pickup_time, created_at
         FROM orders WHERE voucher_code = ? ORDER BY id DESC LIMIT 5`
      )
      .bind(code)
      .all();
    const hit = (rows.results || []).find((r) => norm(r.phone) === ph);
    if (hit) {
      out[code] = {
        status: hit.status,
        payment_status: hit.payment_status,
        total: hit.total,
        pickup_date: hit.pickup_date || "",
        pickup_time: hit.pickup_time || "",
        created_at: hit.created_at,
      };
    }
  }
  return json({ ok: true, orders: out });
}

// ---------------------------------------------------------------------------
// Cron: မလက်ခံသေးသော (New) အော်ဒါကို ၃ မိနစ်ကျော်ပြီးလျှင် Telegram ဖြင့် ၅ မိနစ်တစ်ခါ သတိပေး
// (အများဆုံး ၁၂ ကြိမ် = ၁ နာရီ)  — အော်ဒါကို လက်ခံ/ပယ်ဖျက်လိုက်တာနဲ့ ရပ်သွားသည်
// ---------------------------------------------------------------------------
async function runReminders(env) {
  if (!env.DB) return { sent: 0 };
  await ensureSchema(env);
  if (!env.BOT_TOKEN || !env.CHAT_ID) return { sent: 0, skipped: "telegram not configured" };

  const rows = await env.DB
    .prepare(
      `SELECT id, voucher_code, customer_name, phone, items_json, total, created_at
       FROM orders
       WHERE status = 'New'
         AND created_at <= datetime('now','-3 minutes')
         AND created_at >= datetime('now','-1 day')
         AND COALESCE(remind_count, 0) < 12
         AND (reminded_at IS NULL OR reminded_at <= datetime('now','-5 minutes'))
       ORDER BY id ASC LIMIT 10`
    )
    .all();

  let sent = 0;
  for (const o of rows.results || []) {
    const t = Date.parse(String(o.created_at).replace(" ", "T") + "Z");
    const mins = Number.isFinite(t) ? Math.max(1, Math.round((Date.now() - t) / 60000)) : 0;
    let names = "";
    try {
      const items = JSON.parse(o.items_json || "[]");
      names = items.slice(0, 4).map((i) => `${escMd(i.name)} ×${i.qty}`).join(", ") + (items.length > 4 ? ` +${items.length - 4}` : "");
    } catch (_) {}
    const link = adminLink(env, o.id);
    const text =
      `⏰ *မလက်ခံရသေးသော အော်ဒါ* — ${mins} မိနစ်ကြာပြီ\n` +
      `🧾 \`${o.voucher_code || "#" + o.id}\`\n` +
      `👤 ${escMd(o.customer_name)} · ${escMd(o.phone)}\n` +
      (names ? `🍗 ${names}\n` : "") +
      `💰 *${Number(o.total || 0).toLocaleString("en-US")} MMK*` +
      (link ? `\n🔗 ${link}` : "");

    const r = await sendTelegram(env, text);
    if (r.ok) sent++;
    await env.DB
      .prepare(
        `UPDATE orders
         SET reminded_at = datetime('now'),
             remind_count = COALESCE(remind_count, 0) + 1,
             tg_ok = CASE WHEN ? = 1 THEN 1 ELSE tg_ok END
         WHERE id = ?`
      )
      .bind(r.ok ? 1 : 0, o.id)
      .run();
  }
  return { sent, checked: (rows.results || []).length };
}

async function handleStats(request, env) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: "Database not configured" }, 500);

  const totalsToday = await db
    .prepare(
      `SELECT COALESCE(SUM(total),0) as revenue, COUNT(*) as orders
       FROM orders WHERE date(created_at,'+390 minutes') = date('now','+390 minutes') AND status != 'Cancelled'`
    )
    .first() || { revenue: 0, orders: 0 };

  const totalsYesterday = await db
    .prepare(
      `SELECT COALESCE(SUM(total),0) as revenue, COUNT(*) as orders
       FROM orders WHERE date(created_at,'+390 minutes') = date('now','+390 minutes','-1 day') AND status != 'Cancelled'`
    )
    .first() || { revenue: 0, orders: 0 };

  const totalsAllTime = await db
    .prepare(
      `SELECT COALESCE(SUM(total),0) as revenue, COUNT(*) as orders
       FROM orders WHERE status != 'Cancelled'`
    )
    .first() || { revenue: 0, orders: 0 };

  const newOrdersToday = await db
    .prepare(`SELECT COUNT(*) as c FROM orders WHERE date(created_at,'+390 minutes') = date('now','+390 minutes') AND status = 'New'`)
    .first() || { c: 0 };
  const newOrdersYesterday = await db
    .prepare(`SELECT COUNT(*) as c FROM orders WHERE date(created_at,'+390 minutes') = date('now','+390 minutes','-1 day') AND status = 'New'`)
    .first() || { c: 0 };

  const customersTotal = await db
    .prepare(`SELECT COUNT(DISTINCT phone) as c FROM orders WHERE phone IS NOT NULL AND phone != ''`)
    .first() || { c: 0 };
  const customersLastWeek = await db
    .prepare(
      `SELECT COUNT(DISTINCT phone) as c FROM orders
       WHERE phone IS NOT NULL AND phone != '' AND date(created_at,'+390 minutes') < date('now','+390 minutes','-7 day')`
    )
    .first() || { c: 0 };

  const statusCounts = await db
    .prepare(`SELECT status, COUNT(*) as c FROM orders GROUP BY status`)
    .all();
  const statusMap = { New: 0, Processing: 0, Ready: 0, Completed: 0, Cancelled: 0 };
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
      `SELECT date(created_at,'+390 minutes') as day, COALESCE(SUM(total),0) as revenue
       FROM orders WHERE status != 'Cancelled' AND date(created_at,'+390 minutes') >= date('now','+390 minutes','-6 day')
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
                SUM(CAST(je.value ->> '$.qty' AS INTEGER) * CAST(REPLACE(je.value ->> '$.price', ',', '') AS INTEGER)) as revenue
         FROM orders o, json_each(o.items_json) je
         WHERE o.status != 'Cancelled'
         GROUP BY name ORDER BY qty DESC LIMIT 5`
      )
      .all();
    topProducts = tp.results || [];
  } catch (e) {
    topProducts = [];
  }

  const overdue = await db
    .prepare(`SELECT COUNT(*) as c FROM orders WHERE status = 'New' AND created_at <= datetime('now','-10 minutes')`)
    .first() || { c: 0 };
  const tgFailed = await db
    .prepare(`SELECT COUNT(*) as c FROM orders WHERE status = 'New' AND tg_ok = 0`)
    .first() || { c: 0 };

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
    overdue: overdue.c,
    telegram: { configured: !!(env.BOT_TOKEN && env.CHAT_ID), failed: tgFailed.c },
  });
}

async function handleAnalytics(request, env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  const url = new URL(request.url);
  const days = [7, 30, 90, 365].includes(parseInt(url.searchParams.get("days"), 10)) ? parseInt(url.searchParams.get("days"), 10) : 30;
  const db = env.DB;
  const L = "date(created_at,'+390 minutes')";                       // မြန်မာစံတော်ချိန် ရက်စွဲ
  const NOW = "date('now','+390 minutes')";
  const cur = `${L} >= date('now','+390 minutes','-${days - 1} day')`;
  const prev = `${L} >= date('now','+390 minutes','-${days * 2 - 1} day') AND ${L} < date('now','+390 minutes','-${days - 1} day')`;
  const sumQ = async (cond) => (await db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN status!='Cancelled' THEN total END),0) revenue,
            COUNT(CASE WHEN status!='Cancelled' THEN 1 END) orders,
            COUNT(CASE WHEN status='Cancelled' THEN 1 END) cancelled,
            COUNT(DISTINCT CASE WHEN status!='Cancelled' AND phone!='' THEN phone END) customers
     FROM orders WHERE ${cond}`).first()) || { revenue: 0, orders: 0, cancelled: 0, customers: 0 };

  const current = await sumQ(cur);
  const previous = await sumQ(prev);

  const daily = (await db.prepare(
    `SELECT ${L} day, COALESCE(SUM(total),0) revenue, COUNT(*) orders
     FROM orders WHERE status!='Cancelled' AND ${cur} GROUP BY day ORDER BY day`).all()).results || [];

  const hourly = (await db.prepare(
    `SELECT CAST(strftime('%H', created_at,'+390 minutes') AS INTEGER) hour, COUNT(*) orders, COALESCE(SUM(total),0) revenue
     FROM orders WHERE status!='Cancelled' AND ${cur} GROUP BY hour ORDER BY hour`).all()).results || [];

  const weekday = (await db.prepare(
    `SELECT CAST(strftime('%w', created_at,'+390 minutes') AS INTEGER) dow, COUNT(*) orders, COALESCE(SUM(total),0) revenue
     FROM orders WHERE status!='Cancelled' AND ${cur} GROUP BY dow ORDER BY dow`).all()).results || [];

  const payment = (await db.prepare(
    `SELECT payment_status, COUNT(*) orders, COALESCE(SUM(total),0) revenue
     FROM orders WHERE status!='Cancelled' AND ${cur} GROUP BY payment_status`).all()).results || [];

  // ဝယ်သူအသစ် (ဤကာလအတွင်း ပထမဆုံးမှာသူ) နှင့် ပြန်ဝယ်သူ
  const cust = (await db.prepare(
    `SELECT SUM(CASE WHEN first_day >= date('now','+390 minutes','-${days - 1} day') THEN 1 ELSE 0 END) new_c,
            SUM(CASE WHEN first_day <  date('now','+390 minutes','-${days - 1} day') THEN 1 ELSE 0 END) returning_c
     FROM (SELECT phone, MIN(${L}) first_day FROM orders WHERE phone!='' AND status!='Cancelled' GROUP BY phone)
     WHERE phone IN (SELECT phone FROM orders WHERE phone!='' AND status!='Cancelled' AND ${cur})`).first()) || {};

  let topProducts = [];
  try {
    topProducts = (await db.prepare(
      `SELECT je.value ->> '$.name' name,
              SUM(CAST(je.value ->> '$.qty' AS INTEGER)) qty,
              SUM(CAST(je.value ->> '$.qty' AS INTEGER) * CAST(REPLACE(je.value ->> '$.price', ',', '') AS INTEGER)) revenue
       FROM orders o, json_each(o.items_json) je
       WHERE o.status!='Cancelled' AND date(o.created_at,'+390 minutes') >= date('now','+390 minutes','-${days - 1} day')
       GROUP BY name HAVING name IS NOT NULL ORDER BY qty DESC LIMIT 8`).all()).results || [];
  } catch (_) { topProducts = []; }

  return json({
    ok: true, days, today: (await db.prepare(`SELECT ${NOW} d`).first()).d,
    current, previous, daily, hourly, weekday, payment,
    customers: { new: cust.new_c || 0, returning: cust.returning_c || 0 },
    topProducts,
  });
}

async function handleOrdersList(request, env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
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

  const countRow = await env.DB.prepare(`SELECT COUNT(*) as c FROM orders ${where}`).bind(...binds).first() || { c: 0 };
  const rows = await env.DB
    .prepare(`SELECT * FROM orders ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...binds, pageSize, offset)
    .all();

  return json({ ok: true, total: countRow.c, page, pageSize, orders: rows.results || [] });
}

async function handleOrderUpdate(request, env, id) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const STATUSES = ["New", "Processing", "Ready", "Completed", "Cancelled"];
  const PAYMENTS = ["Paid", "Pending", "Failed"];
  if (body.status && !STATUSES.includes(body.status)) return json({ ok: false, error: "Invalid status" }, 400);
  if (body.payment_status && !PAYMENTS.includes(body.payment_status)) return json({ ok: false, error: "Invalid payment_status" }, 400);
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

async function handleProductsList(env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  const rows = await env.DB.prepare(`SELECT * FROM products ORDER BY id DESC`).all();
  return json({ ok: true, products: rows.results || [] });
}

async function handlePublicProducts(env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  const rows = await env.DB
    .prepare(`SELECT id, name, price, category, image, available FROM products ORDER BY id DESC`)
    .all();
  return json({ ok: true, products: rows.results || [] });
}

async function handleProductCreate(request, env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
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
  return json({ ok: true, id: result.meta ? result.meta.last_row_id : null });
}

async function handleProductUpdate(request, env, id) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
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
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  await env.DB.prepare(`DELETE FROM products WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

async function handleCustomers(env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  const rows = await env.DB
    .prepare(
      `SELECT phone, MAX(customer_name) as name, COUNT(*) as orders, SUM(total) as spent, MAX(created_at) as last_order
       FROM orders WHERE phone IS NOT NULL AND phone != ''
       GROUP BY phone ORDER BY spent DESC LIMIT 100`
    )
    .all();
  return json({ ok: true, customers: rows.results || [] });
}

export default {
  // Cloudflare Cron Trigger (Triggers → Cron → * * * * *)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env).catch((e) => console.log("reminder error:", e.message)));
  },

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

    if (path === "/api/send-order") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleSendOrder(request, env);
    }

    if (path === "/api/order-status") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleOrderStatus(request, env);
    }

    // Customer App မှ Products များ ကြည့်နိုင်ရန် Public API ဖွင့်ပေးခြင်း
    if (path === "/api/products" && request.method === "GET") {
      return handlePublicProducts(env);
    }

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
      if (path === "/api/admin/test-telegram" && request.method === "POST") {
        const r = await sendTelegram(env, "✅ YNS Kitchen — Telegram သတိပေးချက် စမ်းသပ်မှု အောင်မြင်ပါသည်။");
        return json({ ok: !!r.ok, error: r.ok ? undefined : r.error || "Telegram ပို့၍ မရပါ", configured: !!(env.BOT_TOKEN && env.CHAT_ID) });
      }
      if (path === "/api/admin/analytics" && request.method === "GET") {
        return handleAnalytics(request, env);
      }
      if (path === "/api/admin/ping" && request.method === "GET") {
        return json({ ok: true });
      }

      return json({ ok: false, error: "Not found" }, 404);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return json({ ok: false, error: "Assets binding not found" }, 404);
  },
};
