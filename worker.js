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
  for (const [col, def] of [["daily_stock", "INTEGER DEFAULT 0"], ["auto_restock", "INTEGER DEFAULT 1"]]) {
    try {
      await env.DB.prepare(`ALTER TABLE products ADD COLUMN ${col} ${def}`).run();
    } catch (_) { /* ကော်လံ ရှိပြီးသား */ }
  }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT, auth TEXT,
    label TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    last_ok TEXT,
    fail_count INTEGER DEFAULT 0
  )`).run();
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

async function handleSendOrder(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  if ((await getSetting(env, "shop_open", "1")) === "0") {
    const msg = await getSetting(env, "shop_message", "");
    return json({ ok: false, closed: true, error: msg || "ယခု ဆိုင်ပိတ်ထားပါသည်၊ ခေတ္တစောင့်ပေးပါ 🙏" }, 403);
  }

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
    .prepare(`SELECT id, name, price, available, stock, daily_stock FROM products WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all();
  const byId = new Map((found.results || []).map((r) => [r.id, r]));

  const items = [];
  let total = 0;
  for (const [id, qty] of qtyById) {
    const p = byId.get(id);
    if (!p) return json({ ok: false, error: "ပစ္စည်းတစ်ခု မရှိတော့ပါ၊ စာမျက်နှာကို Refresh လုပ်ပါ" }, 400);
    if (!p.available) return json({ ok: false, error: `${p.name} ကုန်သွားပါပြီ` }, 400);
    if (p.daily_stock > 0 && p.stock < qty) {
      return json({ ok: false, error: `${p.name} ကျန်သည်မှာ ${Math.max(0, p.stock)} ခုသာ ရှိပါတော့သည်` }, 400);
    }
    const price = Number(p.price) || 0;
    items.push({ id, name: p.name, price, qty, total: price * qty });
    total += price * qty;
  }

  // stock စစ်ထားသော ပစ္စည်းများကို ဦးအောင် ယူထား (တစ်ပြိုင်တည်း မှာသူများကြောင့် အလွန်မကျစေရန် WHERE stock >= qty)
  const reserved = [];
  for (const [id, qty] of qtyById) {
    const p = byId.get(id);
    if (!(p.daily_stock > 0)) continue;
    const r = await env.DB
      .prepare(
        `UPDATE products SET stock = stock - ?, available = CASE WHEN stock - ? <= 0 THEN 0 ELSE available END
         WHERE id = ? AND stock >= ?`
      )
      .bind(qty, qty, id, qty)
      .run();
    if (!(r.meta && r.meta.changes > 0)) {
      await releaseStock(env, reserved);
      return json({ ok: false, error: `${p.name} ကုန်သွားပါပြီ၊ စာမျက်နှာကို Refresh လုပ်ပါ` }, 400);
    }
    reserved.push({ id, qty });
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
    await releaseStock(env, reserved);
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

  const pushP = pushAll(env).catch((e) => console.log("push error:", e.message));  // Telegram နှင့် တစ်ပြိုင်တည်း
  const tgResult = await sendTelegram(env, text);
  try {
    await env.DB.prepare(`UPDATE orders SET tg_ok = ? WHERE id = ?`).bind(tgResult.ok ? 1 : 0, orderId).run();
  } catch (_) {}
  if (ctx && ctx.waitUntil) ctx.waitUntil(pushP); else await pushP;

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
  const cfg = await remindCfg(env);
  if (!cfg.on) return { sent: 0, skipped: "reminders off" };
  const tgOn = !!(env.BOT_TOKEN && env.CHAT_ID);

  const rows = await env.DB
    .prepare(
      `SELECT id, voucher_code, customer_name, phone, items_json, total, created_at
       FROM orders
       WHERE status = 'New'
         AND created_at <= datetime('now', ?)
         AND created_at >= datetime('now','-1 day')
         AND COALESCE(remind_count, 0) < ?
         AND (reminded_at IS NULL OR reminded_at <= datetime('now', ?))
       ORDER BY id ASC LIMIT 10`
    )
    .bind(`-${cfg.after} minutes`, cfg.max, `-${cfg.every} minutes`)
    .all();

  if ((rows.results || []).length) await pushAll(env).catch((e) => console.log("push error:", e.message)); // ဖုန်းကိုလည်း တစ်ခါ တုန်ခါ

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

    const r = tgOn ? await sendTelegram(env, text) : { ok: false, error: "no telegram" };
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
    .prepare(`SELECT id, name, stock, low_stock_threshold FROM products WHERE daily_stock > 0 AND stock <= low_stock_threshold AND available = 1 ORDER BY stock ASC LIMIT 10`)
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
  let prior = null;
  if (body.status === "Cancelled") {
    prior = await env.DB.prepare(`SELECT status, items_json FROM orders WHERE id = ?`).bind(id).first();
  }
  binds.push(id);
  await env.DB.prepare(`UPDATE orders SET ${fields.join(", ")} WHERE id = ?`).bind(...binds).run();
  if (prior && prior.status !== "Cancelled") {
    try {
      const items = JSON.parse(prior.items_json || "[]");
      if (Array.isArray(items)) await releaseStock(env, items);
    } catch (_) {}
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Inventory — ပစ္စည်းကုန်/ပြန်စ စနစ်
//  daily_stock > 0  : နေ့စဉ် ဤအရေအတွက်ဖြင့် စသည် (အော်ဒါတင်တိုင်း stock လျော့၊ 0 ဖြစ်လျှင် အလိုအလျောက် "ကုန်")
//  daily_stock = 0  : အရေအတွက် မစစ် — "ရှိ/ကုန်" ခလုတ်ဖြင့်သာ ထိန်း
//  auto_restock = 1 : သတ်မှတ်ချိန် (မူလ ညနေ ၃ နာရီ MMT) တွင် ကုန်နေဆဲ ဖြစ်လျှင် ပြန်စ
// ---------------------------------------------------------------------------
async function getSetting(env, k, def) {
  try {
    const r = await env.DB.prepare(`SELECT v FROM settings WHERE k = ?`).bind(k).first();
    return r && r.v !== null && r.v !== undefined ? String(r.v) : def;
  } catch (_) { return def; }
}
async function setSetting(env, k, v) {
  await env.DB.prepare(`INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(k, String(v)).run();
}
function mmtNow() { return new Date(Date.now() + 390 * 60000); }  // getUTC* ဖြင့်ဖတ်လျှင် မြန်မာစံတော်ချိန်

// mode "soldout" = ကုန်နေဆဲ ပစ္စည်းများသာ၊ "all" = auto_restock ဖွင့်ထားသမျှ အားလုံးကို နေ့စဉ်အရေအတွက်သို့ ပြန်စ
async function restockProducts(env, mode) {
  const cond = mode === "all" ? "" : "AND (available = 0 OR (daily_stock > 0 AND stock <= 0))";
  const r = await env.DB
    .prepare(
      `UPDATE products SET available = 1, stock = CASE WHEN daily_stock > 0 THEN daily_stock ELSE stock END
       WHERE auto_restock = 1 ${cond}`
    )
    .run();
  return (r.meta && r.meta.changes) || 0;
}

async function runDailyReset(env) {
  if (!env.DB) return;
  if ((await getSetting(env, "auto_reset", "1")) !== "1") return;
  const hour = Math.min(23, Math.max(0, parseInt(await getSetting(env, "reset_hour", "15"), 10) || 0));
  const now = mmtNow();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < hour) return;
  if ((await getSetting(env, "last_reset", "")) === today) return;
  await setSetting(env, "last_reset", today);       // ထပ်မပြေးစေရန် အရင်မှတ်
  const n = await restockProducts(env, "soldout");
  await setSetting(env, "last_reset_count", n);
  if (n > 0) await sendTelegram(env, `🔄 ပစ္စည်း ${n} မျိုးကို ပြန်စ (stock အသစ်) လုပ်ပြီးပါပြီ`);
}

async function handleInventorySettingsGet(env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  return json({
    ok: true,
    auto_reset: (await getSetting(env, "auto_reset", "1")) === "1",
    reset_hour: parseInt(await getSetting(env, "reset_hour", "15"), 10) || 15,
    last_reset: await getSetting(env, "last_reset", ""),
    last_reset_count: parseInt(await getSetting(env, "last_reset_count", "0"), 10) || 0,
  });
}
async function handleInventorySettingsSet(request, env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  if (b.auto_reset !== undefined) await setSetting(env, "auto_reset", b.auto_reset ? "1" : "0");
  if (b.reset_hour !== undefined) {
    const h = parseInt(b.reset_hour, 10);
    if (!(h >= 0 && h <= 23)) return json({ ok: false, error: "နာရီ ၀ မှ ၂၃ ကြား ထည့်ပါ" }, 400);
    await setSetting(env, "reset_hour", h);
  }
  return handleInventorySettingsGet(env);
}
async function handleInventoryReset(request, env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  let b = {};
  try { b = await request.json(); } catch (_) {}
  const changed = await restockProducts(env, b.mode === "all" ? "all" : "soldout");
  return json({ ok: true, changed });
}

// အော်ဒါကို ပယ်ဖျက်လျှင် ယူထားသော stock ပြန်ထည့်
async function releaseStock(env, items) {
  for (const it of items) {
    const id = parseInt(it.id, 10), qty = parseInt(it.qty, 10);
    if (!(id > 0) || !(qty > 0)) continue;
    await env.DB
      .prepare(
        `UPDATE products SET stock = MIN(stock + ?, daily_stock),
           available = CASE WHEN MIN(stock + ?, daily_stock) > 0 THEN 1 ELSE available END
         WHERE id = ? AND daily_stock > 0`
      )
      .bind(qty, qty, id)
      .run();
  }
}

// ---------------------------------------------------------------------------
// Web Push (VAPID) — Admin page ပိတ်ထားသော်လည်း၊ ဖုန်း screen ပိတ်ထားသော်လည်း အော်ဒါအသစ် notification ရရန်
// payload မပါသော push ကို ပို့ပြီး Service Worker က /api/admin/push/peek မှ အခြေအနေကို ယူပြသည်
// VAPID key ကို ပထမဆုံးအကြိမ် အလိုအလျောက် ထုတ်ပြီး D1 (settings) ထဲ သိမ်းသည် — ကိုယ်တိုင် ဘာမှ ထည့်စရာမလို
// ---------------------------------------------------------------------------
const B64U = {
  enc(buf) {
    const b = new Uint8Array(buf); let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  },
};
const utf8 = (s) => new TextEncoder().encode(s);
let _vapid = null;

async function getVapid(env) {
  if (_vapid) return _vapid;
  let raw = await getSetting(env, "vapid_jwk", "");
  if (!raw) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    await env.DB.prepare(`INSERT OR IGNORE INTO settings (k, v) VALUES ('vapid_jwk', ?)`).bind(JSON.stringify(jwk)).run();
    raw = await getSetting(env, "vapid_jwk", JSON.stringify(jwk)); // တစ်ပြိုင်တည်း ထုတ်မိလျှင် DB ထဲက တစ်ခုကိုသာ သုံး
  }
  const jwk = JSON.parse(raw);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const pub = new Uint8Array(65); pub[0] = 4; pub.set(B64U.dec(jwk.x), 1); pub.set(B64U.dec(jwk.y), 33);
  _vapid = { key, pub: B64U.enc(pub) };
  return _vapid;
}

function pushSubject(env) {
  if (env.PUSH_SUBJECT) return env.PUSH_SUBJECT;
  try { if (env.ADMIN_URL) return new URL(env.ADMIN_URL).origin; } catch (_) {}
  return "mailto:admin@myintharchickenbbq.shop";
}

async function vapidAuth(env, endpoint) {
  const { key, pub } = await getVapid(env);
  const head = B64U.enc(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = B64U.enc(utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: pushSubject(env) })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(head + "." + claims));
  return `vapid t=${head}.${claims}.${B64U.enc(sig)}, k=${pub}`;
}

async function pushOne(env, sub) {
  try {
    const r = await fetch(sub.endpoint, {
      method: "POST",
      headers: { Authorization: await vapidAuth(env, sub.endpoint), TTL: "86400", Urgency: "high" },
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    if (r.status >= 200 && r.status < 300) {
      await env.DB.prepare(`UPDATE push_subs SET last_ok = datetime('now'), fail_count = 0 WHERE id = ?`).bind(sub.id).run();
      return { ok: true };
    }
    if (r.status === 404 || r.status === 410) {   // စက်က subscription ကို ပယ်ဖျက်ပြီး
      await env.DB.prepare(`DELETE FROM push_subs WHERE id = ?`).bind(sub.id).run();
      return { ok: false, gone: true, status: r.status };
    }
    await env.DB.prepare(`UPDATE push_subs SET fail_count = fail_count + 1 WHERE id = ?`).bind(sub.id).run();
    return { ok: false, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function pushAll(env) {
  if (!env.DB) return { total: 0, sent: 0 };
  const subs = (await env.DB.prepare(`SELECT id, endpoint FROM push_subs ORDER BY id DESC LIMIT 20`).all()).results || [];
  const res = await Promise.all(subs.map((s) => pushOne(env, s)));
  return { total: subs.length, sent: res.filter((x) => x.ok).length };
}

async function handlePushKey(env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  const { pub } = await getVapid(env);
  const c = await env.DB.prepare(`SELECT COUNT(*) c FROM push_subs`).first();
  return json({ ok: true, publicKey: pub, count: (c && c.c) || 0 });
}
async function handlePushSubscribe(request, env) {
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const s = b.subscription || {};
  if (!s.endpoint || !/^https:\/\//.test(s.endpoint)) return json({ ok: false, error: "subscription မမှန်ပါ" }, 400);
  await env.DB
    .prepare(
      `INSERT INTO push_subs (endpoint, p256dh, auth, label) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, fail_count = 0`
    )
    .bind(String(s.endpoint).slice(0, 1000), String(s.keys?.p256dh || "").slice(0, 200), String(s.keys?.auth || "").slice(0, 100), String(b.label || "").slice(0, 80))
    .run();
  const c = await env.DB.prepare(`SELECT COUNT(*) c FROM push_subs`).first();
  return json({ ok: true, count: c.c });
}
async function handlePushUnsubscribe(request, env) {
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  if (b.endpoint) await env.DB.prepare(`DELETE FROM push_subs WHERE endpoint = ?`).bind(String(b.endpoint)).run();
  const c = await env.DB.prepare(`SELECT COUNT(*) c FROM push_subs`).first();
  return json({ ok: true, count: c.c });
}
async function handlePushTest(env) {
  await setSetting(env, "push_test_at", Date.now());
  const r = await pushAll(env);
  return json({ ok: r.total > 0 && r.sent > 0, total: r.total, sent: r.sent, error: r.total === 0 ? "ဤ Server မှာ စက်တစ်လုံးမျှ မချိတ်ရသေးပါ" : r.sent === 0 ? "Push ပို့၍ မရပါ (စက်က ပိတ်ထားနိုင်သည်)" : undefined });
}
// Service Worker က push ရောက်တဲ့အခါ ဘာပြရမလဲ သိရန် (admin key လိုသည်)
async function handlePushPeek(env) {
  const n = await env.DB.prepare(`SELECT COUNT(*) c FROM orders WHERE status = 'New'`).first();
  const od = await env.DB.prepare(`SELECT COUNT(*) c FROM orders WHERE status = 'New' AND created_at <= datetime('now','-10 minutes')`).first();
  const t = parseInt(await getSetting(env, "push_test_at", "0"), 10) || 0;
  return json({ ok: true, new: n.c, overdue: od.c, test: Date.now() - t < 90000 });
}

// ---------------------------------------------------------------------------
// App settings (ဆိုင်ဖွင့်/ပိတ်၊ ပြန်သတိပေးချိန်၊ Cron အခြေအနေ)
// ---------------------------------------------------------------------------
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
async function remindCfg(env) {
  return {
    on: (await getSetting(env, "remind_on", "1")) === "1",
    after: clampInt(await getSetting(env, "remind_after", "3"), 1, 60, 3),
    every: clampInt(await getSetting(env, "remind_every", "5"), 1, 60, 5),
    max: clampInt(await getSetting(env, "remind_max", "12"), 1, 50, 12),
  };
}
async function handleAppSettingsGet(env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  const c = await env.DB.prepare(`SELECT COUNT(*) c FROM push_subs`).first();
  return json({
    ok: true,
    remind: await remindCfg(env),
    shop: { open: (await getSetting(env, "shop_open", "1")) === "1", message: await getSetting(env, "shop_message", "") },
    cron: { last: await getSetting(env, "last_cron", "") },
    push: { count: (c && c.c) || 0 },
    telegram: { configured: !!(env.BOT_TOKEN && env.CHAT_ID) },
  });
}
async function handleAppSettingsSet(request, env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  if (b.remind_on !== undefined) await setSetting(env, "remind_on", b.remind_on ? "1" : "0");
  if (b.remind_after !== undefined) await setSetting(env, "remind_after", clampInt(b.remind_after, 1, 60, 3));
  if (b.remind_every !== undefined) await setSetting(env, "remind_every", clampInt(b.remind_every, 1, 60, 5));
  if (b.remind_max !== undefined) await setSetting(env, "remind_max", clampInt(b.remind_max, 1, 50, 12));
  if (b.shop_open !== undefined) await setSetting(env, "shop_open", b.shop_open ? "1" : "0");
  if (b.shop_message !== undefined) await setSetting(env, "shop_message", String(b.shop_message).trim().slice(0, 200));
  return handleAppSettingsGet(env);
}
// ဝယ်သူ app က ဆိုင်ဖွင့်/ပိတ် သိရန် (public)
async function handleShopStatus(env) {
  if (!env.DB) return json({ ok: true, open: true, message: "" });
  return json({ ok: true, open: (await getSetting(env, "shop_open", "1")) === "1", message: await getSetting(env, "shop_message", "") });
}

async function handleProductsList(env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  const rows = await env.DB.prepare(`SELECT * FROM products ORDER BY id DESC`).all();
  return json({ ok: true, products: rows.results || [] });
}

async function handlePublicProducts(env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  const rows = await env.DB
    .prepare(`SELECT id, name, price, category, image, available, stock, daily_stock FROM products ORDER BY id DESC`)
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
  const nm = String(b.name ?? "").trim().slice(0, 100);
  if (!nm) return json({ ok: false, error: "ပစ္စည်းအမည် ထည့်ပါ" }, 400);
  const int = (v, d = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, 99999999) : d; };
  const daily = int(b.daily_stock);
  const result = await env.DB
    .prepare(
      `INSERT INTO products (name, price, category, image, available, stock, low_stock_threshold, daily_stock, auto_restock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      nm,
      int(b.price),
      String(b.category ?? "").trim().slice(0, 50),
      String(b.image ?? "").trim().slice(0, 500),
      b.available === false ? 0 : 1,
      b.stock !== undefined ? int(b.stock) : daily,
      int(b.low_stock_threshold, 10),
      daily,
      b.auto_restock === false ? 0 : 1
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
    daily_stock: b.daily_stock,
    auto_restock: b.auto_restock === undefined ? undefined : b.auto_restock ? 1 : 0,
  };
  for (const k of ["price", "stock", "low_stock_threshold", "daily_stock"]) {
    if (map[k] !== undefined) {
      const n = Math.round(Number(map[k]));
      if (!Number.isFinite(n) || n < 0) return json({ ok: false, error: "ဂဏန်းမှန်ကန်စွာ ထည့်ပါ" }, 400);
      map[k] = Math.min(n, 99999999);
    }
  }
  if (map.name !== undefined) {
    map.name = String(map.name).trim().slice(0, 100);
    if (!map.name) return json({ ok: false, error: "ပစ္စည်းအမည် ထည့်ပါ" }, 400);
  }
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
    ctx.waitUntil(
      (async () => {
        await ensureSchema(env);
        await setSetting(env, "last_cron", new Date().toISOString()).catch(() => {});   // Cron အလုပ်လုပ်နေခြင်း အမှတ်အသား
        await runReminders(env).catch((e) => console.log("reminder error:", e.message));
        await runDailyReset(env).catch((e) => console.log("daily reset error:", e.message));
      })()
    );
  },

  async fetch(request, env, ctx) {
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
      return handleSendOrder(request, env, ctx);
    }

    if (path === "/api/shop-status" && request.method === "GET") return handleShopStatus(env);

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
      if (path === "/api/admin/inventory/settings" && request.method === "GET") return handleInventorySettingsGet(env);
      if (path === "/api/admin/inventory/settings" && request.method === "POST") return handleInventorySettingsSet(request, env);
      if (path === "/api/admin/inventory/reset" && request.method === "POST") return handleInventoryReset(request, env);
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
      if (path === "/api/admin/push/key" && request.method === "GET") return handlePushKey(env);
      if (path === "/api/admin/push/subscribe" && request.method === "POST") return handlePushSubscribe(request, env);
      if (path === "/api/admin/push/unsubscribe" && request.method === "POST") return handlePushUnsubscribe(request, env);
      if (path === "/api/admin/push/test" && request.method === "POST") return handlePushTest(env);
      if (path === "/api/admin/push/peek" && request.method === "GET") return handlePushPeek(env);
      if (path === "/api/admin/app-settings" && request.method === "GET") return handleAppSettingsGet(env);
      if (path === "/api/admin/app-settings" && request.method === "POST") return handleAppSettingsSet(request, env);
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
