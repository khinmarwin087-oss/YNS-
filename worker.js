// ==========================================================================
// မြင်သာကြက်ကင် — Worker API
// Customer POS  ->  /api/send-order        (public)
// Admin Panel   ->  /api/admin/*           (protected by X-Admin-Key header)
// Database      ->  Cloudflare D1 (binding: DB)
// Customer      ->  /api/order-status      (public — voucher + phone နှစ်ခုလုံး ကိုက်မှ ပြန်ပေး)
// Cron Trigger  ->  scheduled()            (မလက်ခံသေးသော အော်ဒါကို Telegram ဖြင့် ထပ်ခါထပ်ခါ သတိပေး)
// Env (optional)->  ADMIN_URL  (ဥပမာ https://yourshop.com/admin  — Telegram မက်ဆေ့ချ်ထဲက link အတွက်)
// ==========================================================================

// CORS / Security headers ကို fetch() ၏ နောက်ဆုံးအဆင့်မှာ တစ်နေရာတည်း ထည့်သည် (အောက်က withSecurity ကိုကြည့်ပါ)
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// လုံခြုံရေး: CORS ကန့်သတ်ချက်၊ Security headers၊ Rate limit (D1 ဖြင့်)၊ Turnstile
//   Env (optional): ALLOWED_ORIGINS = "https://myintharchickenbbq.shop,https://admin.example.com"
//                   TURNSTILE_SITEKEY + TURNSTILE_SECRET = Cloudflare Turnstile (လူစစ်/ဘော့ စစ်)
// ---------------------------------------------------------------------------
function corsOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!origin) return null;
  try {
    const u = new URL(origin);
    if (origin === new URL(request.url).origin) return origin;
    const list = String(env.ALLOWED_ORIGINS || "").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);
    if (list.length) return list.includes(origin) ? origin : null;
    const h = u.hostname;
    if (h === "localhost" || h === "127.0.0.1") return origin;
    if (u.protocol === "https:" && (h === "myintharchickenbbq.shop" || h.endsWith(".myintharchickenbbq.shop") ||
        h.endsWith(".github.io") || h.endsWith(".pages.dev") || h.endsWith(".workers.dev"))) return origin;
    if (env.ADMIN_URL) { try { if (new URL(env.ADMIN_URL).origin === origin) return origin; } catch (_) {} }
  } catch (_) {}
  return null;
}

function withSecurity(res, request, env) {
  const h = new Headers(res.headers);
  const o = corsOrigin(request, env);
  h.append("Vary", "Origin");
  if (o) {
    h.set("Access-Control-Allow-Origin", o);
    h.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key, X-Shop");
    h.set("Access-Control-Max-Age", "86400");
  }
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "SAMEORIGIN");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const pth = new URL(request.url).pathname;
  if (pth.startsWith("/api/") && !pth.startsWith("/api/img/")) h.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

const clientIp = (request) => request.headers.get("CF-Connecting-IP") || "local";
const nowSec = () => Math.floor(Date.now() / 1000);

async function rateHit(env, key, windowSec) {
  if (!env.DB || env.RATE_OFF === "1") return;
  const t = nowSec();
  await env.DB
    .prepare(`INSERT INTO rate_limits (k, n, t) VALUES (?, 1, ?)
              ON CONFLICT(k) DO UPDATE SET n = CASE WHEN ? - t >= ? THEN 1 ELSE n + 1 END,
                                           t = CASE WHEN ? - t >= ? THEN ? ELSE t END`)
    .bind(key, t, t, windowSec, t, windowSec, t)
    .run();
}
async function rateCount(env, key, windowSec) {
  if (!env.DB || env.RATE_OFF === "1") return 0;
  const r = await env.DB.prepare(`SELECT n, t FROM rate_limits WHERE k = ?`).bind(key).first();
  if (!r || nowSec() - r.t >= windowSec) return 0;
  return r.n || 0;
}
// တစ်ကြိမ်ခေါ်တိုင်း ရေတွက်ပြီး limit ကျော်ရင် true
async function rateTake(env, key, limit, windowSec) {
  try {
    await rateHit(env, key, windowSec);
    return (await rateCount(env, key, windowSec)) > limit;
  } catch (_) { return false; }   // DB ပြဿနာကြောင့် ဝယ်သူကို မပိတ်မိစေရန်
}

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const fd = new FormData();
    fd.append("secret", env.TURNSTILE_SECRET);
    fd.append("response", String(token).slice(0, 2048));
    if (ip && ip !== "local") fd.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: fd });
    const d = await r.json();
    return !!d.success;
  } catch (_) { return true; }   // Cloudflare ဘက်ပြဿနာဆိုရင် ဝယ်သူကို မပိတ်ဘဲ rate limit ကပဲ ကာကွယ်
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

// ===========================================================================
// MARKETPLACE (ဆိုင်များစွာ) — ဆိုင်တစ်ဆိုင်စီအတွက် table သီးသန့်
//   ဆိုင် ၁ (မူလဆိုင်) : orders, products, promos, push_subs, settings  (မူလအတိုင်း — ဒေတာ မပြောင်း)
//   ဆိုင် N        : s{N}_orders, s{N}_products, ...  (SQL ထဲက table အမည်ကို scopeDB က အလိုအလျောက် ပြောင်းပေးသည်)
//   ဒါကြောင့် ဆိုင်တစ်ဆိုင်က အခြားဆိုင်ဒေတာကို SQL မှားလည်း မမြင်နိုင်ပါ။
// ===========================================================================
const TENANT_RE = /\b(FROM|JOIN|UPDATE|INTO|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)(\s+)(orders|products|promos|push_subs|settings|images)\b/gi;
function scopeDB(DB, sid) {
  if (sid === 1) return DB;
  const px = (sql) => String(sql).replace(TENANT_RE, (m, a, b, t) => `${a}${b}s${sid}_${t.toLowerCase()}`);
  return { prepare: (sql) => DB.prepare(px(sql)), batch: (st) => DB.batch(st), exec: (sql) => DB.exec(px(sql)) };
}
const SHOP1 = { id: 1, slug: "main", name: "", status: "active", is_open: 1, tg_chat: "" };
function scopedEnv(env, shop) {
  const sid = Number(shop.id) || 1;
  return { ...env, SID: sid, SHOP: shop, RAW: env.RAW || env.DB, DB: scopeDB(env.RAW || env.DB, sid),
           CHAT_ID: sid === 1 ? env.CHAT_ID : (shop.tg_chat || "") };
}
const vPrefix = (env) => ((env.SID || 1) === 1 ? "MS" : "S" + env.SID);

async function sha256hex(str) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const randHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

let globalReady = false;
async function ensureGlobal(env) {
  if (!env.DB || globalReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rate_limits (k TEXT PRIMARY KEY, n INTEGER DEFAULT 0, t INTEGER DEFAULT 0)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT DEFAULT '',
    description TEXT DEFAULT '',
    logo TEXT DEFAULT '',
    cover TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    address TEXT DEFAULT '',
    owner_name TEXT DEFAULT '',
    key_hash TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    is_open INTEGER DEFAULT 1,
    tg_chat TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO shops (id, slug, name, category, status, is_open) VALUES (1, 'main', 'မြင်သာကြက်ကင်', 'ကြက်ကင်', 'active', 1)`).run();
  globalReady = true;
}

async function getShop(env, ref) {
  const raw = env.RAW || env.DB;
  const r = String(ref ?? "").trim().toLowerCase();
  if (!r || r.length > 40) return null;
  try {
    return (/^\d+$/.test(r)
      ? await raw.prepare(`SELECT * FROM shops WHERE id = ?`).bind(Number(r)).first()
      : await raw.prepare(`SELECT * FROM shops WHERE slug = ?`).bind(r).first()) || null;
  } catch (_) { return null; }
}

// ဝယ်သူဘက် (public) — ?shop=slug မပါလျှင် မူလဆိုင် (ဆိုင် ၁) ဖြစ်ပြီး အရင်အတိုင်း အလုပ်လုပ်သည်
async function publicShopEnv(request, env, url) {
  const ref = url.searchParams.get("shop") || "";
  if (!ref) return scopedEnv(env, SHOP1);
  const row = await getShop(env, ref);
  if (!row || row.status !== "active") return null;
  return scopedEnv(env, row);
}

// Admin ဘက် — Owner key (ADMIN_KEY) သို့မဟုတ် ဆိုင်ပိုင်ရှင် key (v<id>.<secret>)
async function adminIdentity(request, env) {
  const key = request.headers.get("X-Admin-Key") || "";
  if (!key) return null;
  if (requireAdmin(request, env)) {
    const want = String(request.headers.get("X-Shop") || "").trim();
    if (want && want !== "1" && want !== "main") {
      const sh = await getShop(env, want);
      return sh ? { role: "owner", shop: sh } : { role: "owner", missing: true };
    }
    return { role: "owner", shop: (await getShop(env, 1)) || SHOP1 };
  }
  const m = key.match(/^v(\d{1,6})\.([0-9a-f]{24,64})$/);
  if (!m || Number(m[1]) === 1) return null;
  let shop = null;
  try { shop = await env.DB.prepare(`SELECT * FROM shops WHERE id = ?`).bind(Number(m[1])).first(); } catch (_) {}
  if (!shop || !shop.key_hash) return null;
  if (!safeEq(await sha256hex(m[2]), shop.key_hash)) return null;
  return { role: "vendor", shop };
}

const SHOP_PUBLIC_COLS = "id, slug, name, category, description, logo, cover, phone, address, is_open";
async function handleShopList(env, request) {
  if (!env.DB) return json({ ok: true, shops: [] });
  if (await rateTake(env, "shl:" + clientIp(request), 120, 600)) return json({ ok: false, error: "ခဏစောင့်ပါ" }, 429);
  const rows = (await env.DB.prepare(`SELECT ${SHOP_PUBLIC_COLS} FROM shops WHERE status = 'active' ORDER BY id`).all()).results || [];
  for (const r of rows) {
    if (r.id === 1) {   // မူလဆိုင် — ဖွင့်/ပိတ်ကို settings ကနေ တိုက်ရိုက်ယူ
      try { const o = await env.DB.prepare(`SELECT v FROM settings WHERE k = 'shop_open'`).first(); r.is_open = o && String(o.v) === "0" ? 0 : 1; } catch (_) {}
    }
  }
  return json({ ok: true, shops: rows });
}

const URL_OK = (v) => { v = String(v ?? "").trim(); return /^https?:\/\/[^\s<>"']{4,480}$/i.test(v) ? v : ""; };
function shopFields(b, allowAdmin) {
  const f = {};
  if (b.name !== undefined) { const n = cleanText(b.name, 60); if (n) f.name = n; }
  if (b.category !== undefined) f.category = cleanText(b.category, 40);
  if (b.description !== undefined) f.description = cleanText(b.description, 240);
  if (b.logo !== undefined) f.logo = URL_OK(b.logo);
  if (b.cover !== undefined) f.cover = URL_OK(b.cover);
  if (b.phone !== undefined) f.phone = cleanText(b.phone, 30);
  if (b.address !== undefined) f.address = cleanText(b.address, 120);
  if (b.tg_chat !== undefined) f.tg_chat = /^-?\d{3,20}$/.test(String(b.tg_chat).trim()) ? String(b.tg_chat).trim() : "";
  if (allowAdmin) {
    if (b.owner_name !== undefined) f.owner_name = cleanText(b.owner_name, 60);
    if (b.status !== undefined && ["active", "suspended"].includes(b.status)) f.status = b.status;
  }
  return f;
}
async function saveShopFields(env, id, f) {
  const keys = Object.keys(f);
  if (!keys.length) return;
  await env.DB.prepare(`UPDATE shops SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => f[k]), id).run();
}

// ဆိုင်ပိုင်ရှင် (သို့) Owner — မိမိဆိုင်၏ ပရိုဖိုင်
async function handleShopProfile(request, env) {
  const raw = env.RAW;
  if (request.method === "GET") {
    const r = await raw.prepare(`SELECT ${SHOP_PUBLIC_COLS}, status, tg_chat FROM shops WHERE id = ?`).bind(env.SID).first();
    return json({ ok: true, shop: r });
  }
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
  const f = shopFields(b || {}, false);
  if (env.SID === 1) delete f.tg_chat;   // မူလဆိုင်က Worker ၏ CHAT_ID ကို သုံးသည်
  await saveShopFields({ DB: raw }, env.SID, f);
  const r = await raw.prepare(`SELECT ${SHOP_PUBLIC_COLS}, status, tg_chat FROM shops WHERE id = ?`).bind(env.SID).first();
  return json({ ok: true, shop: r });
}

// Owner သာ — ဆိုင်များ စီမံခြင်း
const RESERVED_SLUGS = new Set(["main", "admin", "api", "shops", "shop", "index", "www"]);
async function handleShopsAdmin(request, env, path) {
  const m = path.match(/^\/api\/admin\/shops(?:\/(\d+))?(?:\/(key))?$/);
  if (!m) return json({ ok: false, error: "Not found" }, 404);
  const id = m[1] ? Number(m[1]) : null, sub = m[2];
  const raw = env;

  if (!id && request.method === "GET") {
    const rows = (await raw.DB.prepare(`SELECT id, slug, name, category, description, logo, cover, phone, address, owner_name, status, is_open, tg_chat, created_at FROM shops ORDER BY id`).all()).results || [];
    for (const r of rows) {
      r.orders = 0; r.revenue = 0; r.today = 0;
      try {
        const se = scopedEnv(raw, r);
        const a = await se.DB.prepare(`SELECT COUNT(*) c, COALESCE(SUM(total),0) t FROM orders WHERE status != 'Cancelled'`).first();
        const d = await se.DB.prepare(`SELECT COALESCE(SUM(total),0) t FROM orders WHERE status != 'Cancelled' AND date(created_at,'+390 minutes') = date('now','+390 minutes')`).first();
        r.orders = a?.c || 0; r.revenue = a?.t || 0; r.today = d?.t || 0;
      } catch (_) {}
    }
    return json({ ok: true, shops: rows });
  }

  if (!id && request.method === "POST") {
    let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
    const f = shopFields(b || {}, true);
    if (!f.name) return json({ ok: false, error: "ဆိုင်အမည် လိုအပ်ပါသည်" }, 400);
    let slug = String(b.slug || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "").slice(0, 30);
    if (!slug) slug = "shop" + randHex(3);
    if (slug.length < 3 || RESERVED_SLUGS.has(slug)) return json({ ok: false, error: "Link အမည် (slug) မရနိုင်ပါ — အင်္ဂလိပ်စာလုံး/ဂဏန်း ၃ လုံးအထက် ထည့်ပါ" }, 400);
    if (await raw.DB.prepare(`SELECT 1 x FROM shops WHERE slug = ?`).bind(slug).first()) return json({ ok: false, error: "ဤ Link အမည် ရှိပြီးသားပါ" }, 400);
    const secret = randHex(16);
    const hash = await sha256hex(secret);
    const r = await raw.DB.prepare(`INSERT INTO shops (slug, name, category, description, logo, cover, phone, address, owner_name, key_hash, status, is_open, tg_chat)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'active', 1, ?)`)
      .bind(slug, f.name, f.category || "", f.description || "", f.logo || "", f.cover || "", f.phone || "", f.address || "", f.owner_name || "", hash, f.tg_chat || "").run();
    const nid = r.meta.last_row_id;
    const row = await raw.DB.prepare(`SELECT * FROM shops WHERE id = ?`).bind(nid).first();
    await ensureSchema(scopedEnv(raw, row));
    delete row.key_hash;
    return json({ ok: true, shop: row, key: `v${nid}.${secret}` });
  }

  if (id && sub === "key" && request.method === "POST") {
    if (id === 1) return json({ ok: false, error: "မူလဆိုင်သည် Owner Key ကို သုံးသည်" }, 400);
    const row = await getShop(raw, id);
    if (!row) return json({ ok: false, error: "ဆိုင် မတွေ့ပါ" }, 404);
    const secret = randHex(16);
    await raw.DB.prepare(`UPDATE shops SET key_hash = ? WHERE id = ?`).bind(await sha256hex(secret), id).run();
    return json({ ok: true, key: `v${id}.${secret}` });
  }

  if (id && (request.method === "PATCH" || request.method === "PUT")) {
    let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
    const row = await getShop(raw, id);
    if (!row) return json({ ok: false, error: "ဆိုင် မတွေ့ပါ" }, 404);
    const f = shopFields(b || {}, true);
    if (id === 1) { delete f.status; delete f.tg_chat; }
    await saveShopFields(raw, id, f);
    const r = await getShop(raw, id); delete r.key_hash;
    return json({ ok: true, shop: r });
  }
  return json({ ok: false, error: "Not found" }, 404);
}

// ===========================================================================
// ပုံ upload (D1 ထဲသိမ်း၊ Cloudflare cache ဖြင့် ပြန်ပေး) + ဆိုင်မျက်နှာစာ စာသားများ
// ===========================================================================
const IMG_MAX_BYTES = 450000;   // browser က ကျုံ့ပြီးသား (≈ 100–250KB) ပို့ရမည်
function imgMagicOk(mime, b64head) {
  try {
    const bin = atob(b64head.slice(0, 24));
    const h = [...bin].map((c) => c.charCodeAt(0));
    if (mime === "image/jpeg") return h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff;
    if (mime === "image/png") return h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47;
    if (mime === "image/webp") return bin.slice(0, 4) === "RIFF" && bin.slice(8, 12) === "WEBP";
  } catch (_) {}
  return false;
}
async function handleUpload(request, env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  if (parseInt(request.headers.get("content-length") || "0", 10) > 700000) return json({ ok: false, error: "ပုံ ကြီးလွန်းပါသည်" }, 413);
  if (await rateTake(env, "up:" + (env.SID || 1), 150, 3600)) return json({ ok: false, error: "ပုံတင်သည့် အကြိမ်ရေ များလွန်းပါသည်၊ ခဏစောင့်ပါ" }, 429);
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
  const data = String(b?.data || "");
  const comma = data.indexOf(",");
  const head = data.slice(0, comma), b64 = data.slice(comma + 1);
  const mm = /^data:(image\/(?:jpeg|png|webp));base64$/.exec(head);
  if (comma < 0 || !mm || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return json({ ok: false, error: "JPG / PNG / WEBP ပုံသာ တင်နိုင်ပါသည်" }, 400);
  const bytes = Math.floor((b64.length * 3) / 4);
  if (bytes > IMG_MAX_BYTES) return json({ ok: false, error: "ပုံ ကြီးလွန်းပါသည် (ကျုံ့၍မရပါ)" }, 413);
  if (!imgMagicOk(mm[1], b64)) return json({ ok: false, error: "ပုံဖိုင် မမှန်ပါ" }, 400);
  const r = await env.DB.prepare(`INSERT INTO images (mime, data, bytes) VALUES (?, ?, ?)`).bind(mm[1], b64, bytes).run();
  const id = r.meta.last_row_id;
  const url = `${new URL(request.url).origin}/api/img/${id}` + ((env.SID || 1) === 1 ? "" : `?shop=${encodeURIComponent((env.SHOP && env.SHOP.slug) || "")}`);
  return json({ ok: true, id, url, bytes });
}
async function handleImage(request, env, id, ctx) {
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  const key = new Request(request.url, { method: "GET" });
  if (cache) { const hit = await cache.match(key).catch(() => null); if (hit) return hit; }
  const r = await env.DB.prepare(`SELECT mime, data FROM images WHERE id = ?`).bind(id).first();
  if (!r) return json({ ok: false, error: "Not found" }, 404);
  const bin = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
  const res = new Response(bin, { headers: { "Content-Type": r.mime, "Cache-Control": "public, max-age=31536000, immutable" } });
  if (cache) { const p = cache.put(key, res.clone()).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(p); }
  return res;
}

const IMG_URL = (v) => { v = String(v ?? "").trim(); return /^https?:\/\/[^\s<>"']{4,500}$/i.test(v) ? v : ""; };
async function contentCfg(env) {
  let slides = [];
  try { const a = JSON.parse(await getSetting(env, "banner_slides", "[]")); if (Array.isArray(a)) slides = a; } catch (_) {}
  return {
    kicker: await getSetting(env, "banner_kicker", ""),
    title: await getSetting(env, "banner_title", ""),
    btn: await getSetting(env, "banner_btn", ""),
    slides: slides.slice(0, 6).map((x) => ({ img: IMG_URL(x?.img), title: cleanText(x?.title, 60), sub: cleanText(x?.sub, 100) })),
    notice_on: (await getSetting(env, "notice_on", "0")) === "1",
    notice_text: await getSetting(env, "notice_text", ""),
    notice_closed: await getSetting(env, "notice_closed", ""),
  };
}
async function saveContent(env, b) {
  if (b.banner_kicker !== undefined) await setSetting(env, "banner_kicker", cleanText(b.banner_kicker, 40));
  if (b.banner_title !== undefined) await setSetting(env, "banner_title", cleanText(b.banner_title, 60));
  if (b.banner_btn !== undefined) await setSetting(env, "banner_btn", cleanText(b.banner_btn, 30));
  if (Array.isArray(b.banner_slides)) {
    const clean = b.banner_slides.slice(0, 6).map((x) => ({ img: IMG_URL(x?.img), title: cleanText(x?.title, 60), sub: cleanText(x?.sub, 100) })).filter((x) => x.img || x.title);
    await setSetting(env, "banner_slides", JSON.stringify(clean));
  }
  if (b.notice_on !== undefined) await setSetting(env, "notice_on", b.notice_on ? "1" : "0");
  if (b.notice_text !== undefined) await setSetting(env, "notice_text", cleanText(b.notice_text, 160));
  if (b.notice_closed !== undefined) await setSetting(env, "notice_closed", cleanText(b.notice_closed, 160));
}
async function handleCategoryRename(request, env) {
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
  const from = cleanText(b?.from, 40), to = cleanText(b?.to, 40);
  if (!to) return json({ ok: false, error: "အမျိုးအစား အမည်အသစ် ထည့်ပါ" }, 400);
  const r = await env.DB.prepare(`UPDATE products SET category = ? WHERE category = ?`).bind(to, from).run();
  return json({ ok: true, changed: r.meta?.changes ?? 0 });
}

const readySids = new Set();
async function ensureSchema(env) {
  const sid = env.SID || 1;
  if (!env.DB || readySids.has(sid)) return;
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
    ["packs_json", "TEXT DEFAULT ''"],       // ထုပ်ခွဲပေးရန် (ထုပ် ၁၊ ထုပ် ၂ ...)
    ["discount", "INTEGER DEFAULT 0"],       // Promo / ဖောက်သည်ဟောင်း လျှော့ဈေး
    ["promo_code", "TEXT DEFAULT ''"],
    ["customer_note", "TEXT DEFAULT ''"],   // ဝယ်သူ၏ မှတ်ချက် (ထုပ်ပိုးပုံ၊ အချဉ်ရည်၊ စပ်/မစပ် ...)
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
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rate_limits (k TEXT PRIMARY KEY, n INTEGER DEFAULT 0, t INTEGER DEFAULT 0)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS promos (
    code TEXT PRIMARY KEY,
    kind TEXT DEFAULT 'percent',
    value INTEGER DEFAULT 0,
    max_discount INTEGER DEFAULT 0,
    min_total INTEGER DEFAULT 0,
    phone TEXT DEFAULT '',
    max_uses INTEGER DEFAULT 0,
    per_phone INTEGER DEFAULT 1,
    expires TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT, auth TEXT,
    label TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    last_ok TEXT,
    fail_count INTEGER DEFAULT 0
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mime TEXT, data TEXT, bytes INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  readySids.add(sid);
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

// ---------------------------------------------------------------------------
// ဖုန်းနံပါတ် ချိန်ညှိ၊ မှတ်ချက် သန့်ရှင်း၊ Promo / ဖောက်သည်ဟောင်း လျှော့ဈေး
// ---------------------------------------------------------------------------
const normPhone = (s) => String(s ?? "").toLowerCase().replace(/[\s\-()+]/g, "");
const PHONE_NORM_SQL = "replace(replace(replace(replace(replace(lower(phone),' ',''),'-',''),'(',''),')',''),'+','')";
const cleanText = (s, n) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const mmtDate = () => mmtNow().toISOString().slice(0, 10);   // YYYY-MM-DD (မြန်မာစံတော်ချိန်)

async function loyaltyCfg(env) {
  return {
    on: (await getSetting(env, "loyal_on", "0")) === "1",
    every: clampInt(await getSetting(env, "loyal_every", "5"), 2, 100, 5),
    percent: clampInt(await getSetting(env, "loyal_percent", "10"), 0, 100, 10),   // 0 = ရာခိုင်နှုန်း မသုံး
    fixed: clampInt(await getSetting(env, "loyal_fixed", "0"), 0, 99999999, 0),     // 0 = ငွေပမာဏ မသုံး
    max: clampInt(await getSetting(env, "loyal_max", "0"), 0, 99999999, 0),
    since: await getSetting(env, "loyal_since", ""),   // ဤအချိန်နောက်ပိုင်း အော်ဒါများကိုသာ ရေတွက် (UTC "YYYY-MM-DD HH:MM:SS")
  };
}

function loyalText(L) {
  const a = [];
  if (L.percent > 0) a.push(`${L.percent}%`);
  if (L.fixed > 0) a.push(`${Number(L.fixed).toLocaleString("en-US")} Ks`);
  return a.join(" + ");
}

async function priorOrders(env, pn, since) {
  if (!pn) return 0;
  const r = await env.DB
    .prepare(`SELECT COUNT(*) c FROM orders WHERE COALESCE(status,'') != 'Cancelled' AND ${PHONE_NORM_SQL} = ?` + (since ? ` AND created_at >= ?` : ""))
    .bind(...(since ? [pn, since] : [pn]))
    .first();
  return (r && r.c) || 0;
}

async function evalPromo(env, code, pn, subtotal) {
  const p = await env.DB.prepare(`SELECT * FROM promos WHERE code = ?`).bind(code).first();
  if (!p || !p.active) return { error: "ကုဒ် မမှန်ပါ" };
  if (!pn) return { error: "ကုဒ်သုံးရန် ဖုန်းနံပါတ်ကို အရင်ဖြည့်ပါ" };
  if (p.expires && p.expires < mmtDate()) return { error: "ဤကုဒ်၏ သက်တမ်း ကုန်သွားပါပြီ" };
  if (p.phone && p.phone !== pn) return { error: "ဤကုဒ်သည် သတ်မှတ်ထားသော ဖုန်းနံပါတ်အတွက်သာ ဖြစ်ပါသည်" };
  if (p.min_total > 0 && subtotal < p.min_total) {
    return { error: `ဤကုဒ်ကို အနည်းဆုံး ${Number(p.min_total).toLocaleString("en-US")} Ks မှာမှ သုံးနိုင်ပါသည်` };
  }
  if (p.max_uses > 0) {
    const u = await env.DB.prepare(`SELECT COUNT(*) c FROM orders WHERE promo_code = ? AND COALESCE(status,'') != 'Cancelled'`).bind(code).first();
    if (u && u.c >= p.max_uses) return { error: "ဤကုဒ်၏ အသုံးပြုခွင့် ပြည့်သွားပါပြီ" };
  }
  if (p.per_phone > 0) {
    const u = await env.DB
      .prepare(`SELECT COUNT(*) c FROM orders WHERE promo_code = ? AND COALESCE(status,'') != 'Cancelled' AND ${PHONE_NORM_SQL} = ?`)
      .bind(code, pn)
      .first();
    if (u && u.c >= p.per_phone) return { error: "ဤကုဒ်ကို အသုံးပြုပြီး ဖြစ်ပါသည်" };
  }
  let d = p.kind === "amount" ? p.value : Math.floor((subtotal * p.value) / 100);
  if (p.kind !== "amount" && p.max_discount > 0) d = Math.min(d, p.max_discount);
  d = Math.max(0, Math.min(d, subtotal));
  if (d <= 0) return { error: "ဤကုဒ်ဖြင့် လျှော့ဈေး မရနိုင်ပါ" };
  const label = p.kind === "amount" ? `${Number(p.value).toLocaleString("en-US")} Ks လျှော့` : `${p.value}% လျှော့`;
  return { discount: d, code: p.code, label };
}

// Promo ကုဒ် နှင့် ဖောက်သည်ဟောင်း အလိုအလျောက်လျှော့ — ပိုများသည့်တစ်ခုကိုသာ သုံး
async function computeDiscount(env, { code, phone, subtotal }) {
  const pn = normPhone(phone);
  const res = { discount: 0, code: "", label: "", auto: false, error: "" };
  let best = null;

  const L = await loyaltyCfg(env);
  if (L.on && pn) {
    const nth = (await priorOrders(env, pn, L.since)) + 1;
    if (nth % L.every === 0) {
      let d = Math.floor((subtotal * L.percent) / 100);
      if (L.max > 0) d = Math.min(d, L.max);
      d = Math.min(d + L.fixed, subtotal);
      if (d > 0) best = { discount: d, code: "LOYAL", label: `အော်ဒါ ${nth} ကြိမ်မြောက် ${loyalText(L)} လျှော့`, auto: true };
    }
  }

  const c = String(code ?? "").trim().toUpperCase().slice(0, 30);
  if (c) {
    const r = await evalPromo(env, c, pn, subtotal);
    if (r.error) { res.error = r.error; return res; }
    if (!best || r.discount >= best.discount) best = { ...r, auto: false };
  }
  return best ? { ...res, ...best } : res;
}

const WORKER_VERSION = 15;   // Settings စာမျက်နှာက Worker အသစ် တင်ပြီးမပြီး စစ်ရန်

async function handleSendOrder(request, env, ctx) {
  const ip = clientIp(request);
  if (parseInt(request.headers.get("content-length") || "0", 10) > 60000) {
    return json({ ok: false, error: "ပို့သောအချက်အလက် ကြီးလွန်းပါသည်" }, 413);
  }
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  if (await rateTake(env, "ord:" + ip, 20, 600)) {
    return json({ ok: false, error: "အော်ဒါတင်သည့် အကြိမ်ရေ များလွန်းနေပါသည်၊ ခဏစောင့်ပြီးမှ ပြန်ကြိုးစားပါ 🙏" }, 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!(await verifyTurnstile(env, body?.cf_token, ip))) {
    return json({ ok: false, error: "လူစစ်ဖြစ်ကြောင်း စစ်ဆေးမှု မအောင်မြင်ပါ၊ စာမျက်နှာကို Refresh လုပ်ပြီး ထပ်ကြိုးစားပါ", captcha: true }, 403);
  }
  if ((await getSetting(env, "shop_open", "1")) === "0") {
    const msg = await getSetting(env, "shop_message", "");
    return json({ ok: false, closed: true, error: msg || "ယခု ဆိုင်ပိတ်ထားပါသည်၊ ခေတ္တစောင့်ပေးပါ 🙏" }, 403);
  }

  const name = cleanText(body?.name, 60);
  const phone = cleanText(body?.phone, 40);
  const date = cleanText(body?.date, 30);
  const time = cleanText(body?.time, 10);
  const orderNote = String(body?.note ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 300);
  if (!name || !phone) return json({ ok: false, error: "အမည်နှင့် ဖုန်းနံပါတ် လိုအပ်ပါသည်" }, 400);
  if (phone.length < 3) return json({ ok: false, error: "ဖုန်းနံပါတ် မှားနေပါသည်" }, 400);
  if (await rateTake(env, "ordph:" + (env.SID || 1) + ":" + normPhone(phone), 5, 600)) {
    return json({ ok: false, error: "ဤဖုန်းနံပါတ်ဖြင့် အော်ဒါ အကြိမ်ရေ များလွန်းနေပါသည်၊ ၁၀ မိနစ်ခန့်စောင့်ပါ 🙏" }, 429);
  }

  // client က id + qty သာ ပို့ရမယ် — စျေးနှုန်းကို DB ကနေ server မှာပဲ တွက်မယ်
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const qtyById = new Map();
  const noteById = new Map();
  for (const it of rawItems) {
    const id = parseInt(it?.id, 10);
    const qty = parseInt(it?.qty, 10);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty <= 0 || qty > 99) {
      return json({ ok: false, error: "ပစ္စည်းအချက်အလက် မှားနေပါသည်" }, 400);
    }
    qtyById.set(id, Math.min(99, (qtyById.get(id) || 0) + qty));
    const nt = cleanText(it?.note, 60);
    if (nt) noteById.set(id, nt);
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
    const row = { id, name: p.name, price, qty, total: price * qty };
    if (noteById.has(id)) row.note = noteById.get(id);
    items.push(row);
    total += price * qty;
  }
  const subtotal = total;

  // ထုပ်ခွဲပေးရန် — ထုပ်တစ်ခုချင်းစီထဲက ပစ္စည်းရေ စုစုပေါင်းသည် မှာယူသည့်ရေနှင့် အတိအကျ ကိုက်ရမည်
  let packs = [];
  if (Array.isArray(body.packs) && body.packs.length) {
    if (body.packs.length > 30) return json({ ok: false, error: "ထုပ် အရေအတွက် များလွန်းပါသည်" }, 400);
    const usedQty = new Map();
    for (const pk of body.packs) {
      const merged = new Map();
      for (const it of Array.isArray(pk?.items) ? pk.items : []) {
        const id = parseInt(it?.id, 10);
        const q = parseInt(it?.qty, 10);
        if (!qtyById.has(id) || !Number.isInteger(q) || q <= 0 || q > 99) {
          return json({ ok: false, error: "ထုပ်ခွဲမှု အချက်အလက် မှားနေပါသည်" }, 400);
        }
        merged.set(id, (merged.get(id) || 0) + q);
        usedQty.set(id, (usedQty.get(id) || 0) + q);
      }
      if (!merged.size) continue;   // အလွတ်ထုပ်ကို ကျော်
      packs.push({
        items: [...merged].map(([id, qty]) => ({ id, name: byId.get(id).name, qty })),
        sauce: ["with", "separate"].includes(pk?.sauce) ? pk.sauce : "none",
        note: cleanText(pk?.note, 80),
      });
    }
    for (const [id, q] of qtyById) {
      if ((usedQty.get(id) || 0) !== q) {
        return json({ ok: false, error: `ထုပ်ခွဲထားသော ${byId.get(id).name} အရေအတွက် မကိုက်ပါ` }, 400);
      }
    }
    packs = packs.map((p, i) => ({ no: i + 1, ...p }));
  }

  // Promo ကုဒ် / ဖောက်သည်ဟောင်း လျှော့ဈေး
  const disc = await computeDiscount(env, { code: body.promo, phone, subtotal });
  if (disc.error) return json({ ok: false, error: disc.error, promo_error: true }, 400);
  total = subtotal - disc.discount;

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
        `INSERT INTO orders (voucher_code, customer_name, phone, items_json, total, status, payment_status, pickup_date, pickup_time, packs_json, discount, promo_code, customer_note)
         VALUES (NULL, ?, ?, ?, ?, 'New', 'Pending', ?, ?, ?, ?, ?, ?)`
      )
      .bind(name, phone, JSON.stringify(items), total, date, time, packs.length ? JSON.stringify(packs) : "", disc.discount, disc.code, orderNote)
      .run();
    orderId = result.meta.last_row_id;
  } catch (e) {
    console.log("DB insert failed:", e.message);
    await releaseStock(env, reserved);
    return json({ ok: false, error: "အော်ဒါ သိမ်းမရပါ၊ ပြန်ကြိုးစားပါ" }, 500);
  }

  // ဘောက်ချာနံပါတ်ကို order id နဲ့ တည်ဆောက် (ထပ်နေနိုင်ခြေ မရှိ)
  const vCode = `#${vPrefix(env)}-${String(orderId).padStart(4, "0")}`;
  try {
    await env.DB.prepare(`UPDATE orders SET voucher_code = ? WHERE id = ?`).bind(vCode, orderId).run();
  } catch (e) {
    console.log("Voucher update failed:", e.message);
  }

  const lines = items.map((i) => `▪️ ${escMd(i.name)} (${i.qty} ခု)` + (i.note ? ` — 📝 ${escMd(i.note)}` : ""));
  const SAUCE = { with: "🥣 အချဉ်ရည်ပါ (တစ်ခါတည်းစမ်း)", separate: "🥣 အချဉ်ရည် သက်သက်ထုပ်", none: "" };
  const packLines = packs.map(
    (p) =>
      `📦 *ထုပ် ${p.no}:* ` +
      p.items.map((x) => `${escMd(x.name)} ×${x.qty}`).join(", ") +
      (SAUCE[p.sauce] ? ` · ${SAUCE[p.sauce]}` : "") +
      (p.note ? ` · 📝 ${escMd(p.note)}` : "")
  );
  const text =
    `🍗 *မြင်သာကြက်ကင် - အော်ဒါအသစ်*\n` +
    `🧾 *ဘောက်ချာနံပါတ်:* \`${vCode}\`\n` +
    `👤 *အမည်:* ${escMd(name)}\n` +
    `📞 *ဖုန်း/ID:* ${escMd(phone)}\n` +
    `📅 *နေ့ရက်:* ${escMd(date)}\n` +
    `🕒 *အချိန်:* ${escMd(time)}\n` +
    `━━━━━━━━━━━━━━\n${lines.join("\n")}\n━━━━━━━━━━━━━━\n` +
    (orderNote ? `📝 *မှတ်ချက်:* ${escMd(orderNote)}\n━━━━━━━━━━━━━━\n` : "") +
    (packLines.length ? `*ထုပ်ခွဲပေးရန်*\n${packLines.join("\n")}\n━━━━━━━━━━━━━━\n` : "") +
    (disc.discount > 0 ? `🎟 *${escMd(disc.code)}* ${escMd(disc.label)}: -${disc.discount.toLocaleString("en-US")} MMK\n` : "") +
    `💰 *စုစုပေါင်း:* *${total.toLocaleString("en-US")} MMK*` +
    (adminLink(env, orderId) ? `\n🔗 ${adminLink(env, orderId)}` : "");

  const pushP = pushAll(env).catch((e) => console.log("push error:", e.message));  // Telegram နှင့် တစ်ပြိုင်တည်း
  const tgResult = await sendTelegram(env, text);
  try {
    await env.DB.prepare(`UPDATE orders SET tg_ok = ? WHERE id = ?`).bind(tgResult.ok ? 1 : 0, orderId).run();
  } catch (_) {}
  if (ctx && ctx.waitUntil) ctx.waitUntil(pushP); else await pushP;

  return json({
    ok: true, v: WORKER_VERSION, order_id: orderId, vCode, total, subtotal, items, packs, note: orderNote,
    discount: disc.discount, promo_code: disc.code, promo_label: disc.label,
    telegram: { ok: !!tgResult.ok },
  });
}

// ---------------------------------------------------------------------------
// Customer: ကိုယ့်အော်ဒါ ဘယ်အဆင့်ရောက်ပြီလဲ ကြည့်ရန်
// voucher နံပါတ် + ဖုန်း/ID နှစ်ခုလုံး ကိုက်မှသာ ပြန်ပေးသည် (တခြားသူ၏ အော်ဒါ မမြင်ရအောင်)
// ---------------------------------------------------------------------------
async function handleOrderStatus(request, env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  if (await rateTake(env, "st:" + clientIp(request), 60, 600)) return json({ ok: false, error: "ခဏစောင့်ပြီးမှ ထပ်ကြိုးစားပါ" }, 429);
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
// ---------------------------------------------------------------------------
// ဆိုင်ဆက်သွယ်ရန် (ဖုန်း / Viber / Messenger / ဖွင့်ချိန်)
// ---------------------------------------------------------------------------
function intlPhone(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "95" + d.slice(1);
  return d ? "+" + d : "";
}
function messengerUrl(s) {
  const v = String(s || "").trim();
  if (!v) return "";
  if (/^https:\/\/(m\.me|www\.facebook\.com|facebook\.com|fb\.com|www\.messenger\.com|messenger\.com)\//i.test(v)) return v;
  const u = v.replace(/^@/, "").replace(/[^A-Za-z0-9.\-_]/g, "");
  return u ? "https://m.me/" + u : "";
}
async function contactCfg(env) {
  const phone = await getSetting(env, "shop_phone", "");
  const viber = await getSetting(env, "shop_viber", "");
  const messenger = await getSetting(env, "shop_messenger", "");
  const vNum = intlPhone(viber || phone);
  return {
    phone, viber, messenger,
    hours: await getSetting(env, "shop_hours", ""),
    open_time: await getSetting(env, "shop_open_time", ""),
    close_time: await getSetting(env, "shop_close_time", ""),
    tel: phone ? "tel:" + phone.replace(/[^\d+]/g, "") : "",
    viber_url: vNum ? "viber://chat?number=" + encodeURIComponent(vNum) : "",
    messenger_url: messengerUrl(messenger),
  };
}

async function handleAppSettingsGet(env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  const c = await env.DB.prepare(`SELECT COUNT(*) c FROM push_subs`).first();
  return json({
    ok: true,
    version: WORKER_VERSION,
    remind: await remindCfg(env),
    shop: { open: (await getSetting(env, "shop_open", "1")) === "1", message: await getSetting(env, "shop_message", "") },
    contact: await contactCfg(env),
    loyal: await loyaltyCfg(env),
    content: await contentCfg(env),
    cron: { last: await getSetting({ DB: env.RAW || env.DB }, "last_cron", "") },
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
  if (b.shop_open !== undefined) {
    await setSetting(env, "shop_open", b.shop_open ? "1" : "0");
    try { await (env.RAW || env.DB).prepare(`UPDATE shops SET is_open = ? WHERE id = ?`).bind(b.shop_open ? 1 : 0, env.SID || 1).run(); } catch (_) {}
  }
  if (b.shop_message !== undefined) await setSetting(env, "shop_message", String(b.shop_message).trim().slice(0, 200));
  if (b.shop_phone !== undefined) await setSetting(env, "shop_phone", cleanText(b.shop_phone, 30));
  if (b.shop_viber !== undefined) await setSetting(env, "shop_viber", cleanText(b.shop_viber, 30));
  if (b.shop_messenger !== undefined) await setSetting(env, "shop_messenger", cleanText(b.shop_messenger, 200));
  if (b.shop_hours !== undefined) await setSetting(env, "shop_hours", cleanText(b.shop_hours, 80));
  for (const k of ["shop_open_time", "shop_close_time"]) {
    if (b[k] !== undefined) await setSetting(env, k, /^\d{2}:\d{2}$/.test(String(b[k])) ? String(b[k]) : "");
  }
  if (b.loyal_on !== undefined) await setSetting(env, "loyal_on", b.loyal_on ? "1" : "0");
  if (b.loyal_every !== undefined) await setSetting(env, "loyal_every", clampInt(b.loyal_every, 2, 100, 5));
  if (b.loyal_percent !== undefined) await setSetting(env, "loyal_percent", clampInt(b.loyal_percent, 0, 100, 10));
  if (b.loyal_fixed !== undefined) await setSetting(env, "loyal_fixed", clampInt(b.loyal_fixed, 0, 99999999, 0));
  if (b.loyal_max !== undefined) await setSetting(env, "loyal_max", clampInt(b.loyal_max, 0, 99999999, 0));
  if (b.loyal_reset) await setSetting(env, "loyal_since", new Date().toISOString().replace("T", " ").slice(0, 19));   // ယခုမှစ၍ ပြန်ရေတွက်
  if (b.loyal_reset === "clear") await setSetting(env, "loyal_since", "");
  await saveContent(env, b);
  return handleAppSettingsGet(env);
}
// ဝယ်သူ app က ဆိုင်ဖွင့်/ပိတ်၊ ဆက်သွယ်ရန်၊ ဖောက်သည်လျှော့ဈေး သိရန် (public)
async function handleShopStatus(env) {
  if (!env.DB) return json({ ok: true, open: true, message: "" });
  const L = await loyaltyCfg(env);
  let sh = env.SHOP;
  if (!sh || !sh.name) sh = (await getShop(env, env.SID || 1)) || sh || SHOP1;
  return json({
    ok: true,
    v: WORKER_VERSION,
    shop: { id: sh.id, slug: sh.slug, name: sh.name || "", category: sh.category || "", description: sh.description || "", logo: sh.logo || "", cover: sh.cover || "", address: sh.address || "", phone: sh.phone || "" },
    open: (await getSetting(env, "shop_open", "1")) === "1",
    message: await getSetting(env, "shop_message", ""),
    contact: await contactCfg(env),
    loyal: { on: L.on, every: L.every, percent: L.percent, fixed: L.fixed, text: loyalText(L) },
    turnstile: env.TURNSTILE_SECRET && env.TURNSTILE_SITEKEY ? env.TURNSTILE_SITEKEY : "",
    content: await contentCfg(env),
  });
}

// ---------------------------------------------------------------------------
// Promo ကုဒ်စစ်ရန် (ဝယ်သူ — public) : ခြင်းတောင်းထဲက ပစ္စည်းများဖြင့် server မှ ပြန်တွက်ပေးသည်
// ---------------------------------------------------------------------------
async function handlePromoCheck(request, env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  if (await rateTake(env, "pc:" + clientIp(request), 40, 600)) return json({ ok: false, error: "ကုဒ်စစ်ခြင်း အကြိမ်ရေ များလွန်းပါသည်၊ ခဏစောင့်ပါ" }, 429);
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const qty = new Map();
  for (const it of Array.isArray(b.items) ? b.items.slice(0, 50) : []) {
    const id = parseInt(it?.id, 10), q = parseInt(it?.qty, 10);
    if (Number.isInteger(id) && id > 0 && Number.isInteger(q) && q > 0 && q <= 99) qty.set(id, Math.min(99, (qty.get(id) || 0) + q));
  }
  let subtotal = 0;
  if (qty.size) {
    const ids = [...qty.keys()];
    const rows = await env.DB.prepare(`SELECT id, price FROM products WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
    for (const r of rows.results || []) subtotal += (Number(r.price) || 0) * qty.get(r.id);
  }
  const phone = String(b.phone ?? "").trim().slice(0, 100);
  const pn = normPhone(phone);
  const L = await loyaltyCfg(env);
  let loyal = null;
  if (L.on && pn) {
    const done = await priorOrders(env, pn, L.since);
    loyal = { every: L.every, percent: L.percent, fixed: L.fixed, text: loyalText(L), toGo: (L.every - ((done + 1) % L.every)) % L.every };
  }
  const d = await computeDiscount(env, { code: b.code, phone, subtotal });
  if (d.error) return json({ ok: false, error: d.error, loyal });
  return json({ ok: true, subtotal, discount: d.discount, total: subtotal - d.discount, code: d.code, label: d.label, auto: d.auto, loyal });
}

// ---------------------------------------------------------------------------
// Admin: Promo ကုဒ်များ စီမံခြင်း
// ---------------------------------------------------------------------------
function genPromoCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return "YNS-" + [...buf].map((x) => A[x % A.length]).join("");
}
async function handlePromoList(env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  const rows = await env.DB
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM orders o WHERE o.promo_code = p.code AND COALESCE(o.status,'') != 'Cancelled') AS used
       FROM promos p ORDER BY p.created_at DESC, p.code`
    )
    .all();
  return json({ ok: true, today: mmtDate(), promos: rows.results || [] });
}
async function handlePromoCreate(request, env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const kind = b.kind === "amount" ? "amount" : "percent";
  const value = Math.round(Number(b.value));
  if (!Number.isFinite(value) || value < 1 || (kind === "percent" && value > 100) || value > 99999999) {
    return json({ ok: false, error: kind === "percent" ? "လျှော့ရာခိုင်နှုန်း ၁ မှ ၁၀၀ ကြား ထည့်ပါ" : "လျှော့ငွေပမာဏ ထည့်ပါ" }, 400);
  }
  const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const expires = /^\d{4}-\d{2}-\d{2}$/.test(String(b.expires || "")) ? String(b.expires) : "";
  const row = {
    kind, value,
    max_discount: int(b.max_discount, 0, 99999999, 0),
    min_total: int(b.min_total, 0, 99999999, 0),
    phone: normPhone(b.phone).slice(0, 40),
    max_uses: int(b.max_uses, 0, 1000000, 0),
    per_phone: int(b.per_phone, 0, 1000, 1),
    expires,
    note: cleanText(b.note, 80),
  };
  let code = String(b.code || "").trim().toUpperCase();
  const custom = !!code;
  if (custom && !/^[A-Z0-9_-]{3,20}$/.test(code)) return json({ ok: false, error: "ကုဒ်သည် English စာလုံး/ဂဏန်း ၃ မှ ၂၀ လုံးသာ ဖြစ်ရမည်" }, 400);
  for (let tries = 0; tries < 6; tries++) {
    if (!custom) code = genPromoCode();
    try {
      await env.DB
        .prepare(`INSERT INTO promos (code, kind, value, max_discount, min_total, phone, max_uses, per_phone, expires, active, note) VALUES (?,?,?,?,?,?,?,?,?,1,?)`)
        .bind(code, row.kind, row.value, row.max_discount, row.min_total, row.phone, row.max_uses, row.per_phone, row.expires, row.note)
        .run();
      return json({ ok: true, code });
    } catch (e) {
      if (custom) return json({ ok: false, error: "ဤကုဒ်နာမည် ရှိပြီးသားပါ" }, 400);
    }
  }
  return json({ ok: false, error: "ကုဒ်ထုတ်၍ မရပါ၊ ပြန်ကြိုးစားပါ" }, 500);
}
async function handlePromoUpdate(request, env, code) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const f = [], v = [];
  const int = (x, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(x)) || 0));
  if (b.active !== undefined) { f.push("active = ?"); v.push(b.active ? 1 : 0); }
  if (b.note !== undefined) { f.push("note = ?"); v.push(cleanText(b.note, 80)); }
  if (b.expires !== undefined) { f.push("expires = ?"); v.push(/^\d{4}-\d{2}-\d{2}$/.test(String(b.expires)) ? String(b.expires) : ""); }
  if (b.max_uses !== undefined) { f.push("max_uses = ?"); v.push(int(b.max_uses, 0, 1000000)); }
  if (b.per_phone !== undefined) { f.push("per_phone = ?"); v.push(int(b.per_phone, 0, 1000)); }
  if (b.min_total !== undefined) { f.push("min_total = ?"); v.push(int(b.min_total, 0, 99999999)); }
  if (!f.length) return json({ ok: false, error: "Nothing to update" }, 400);
  v.push(String(code).toUpperCase());
  await env.DB.prepare(`UPDATE promos SET ${f.join(", ")} WHERE code = ?`).bind(...v).run();
  return json({ ok: true });
}
async function handlePromoDelete(env, code) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  await env.DB.prepare(`DELETE FROM promos WHERE code = ?`).bind(String(code).toUpperCase()).run();
  return json({ ok: true });
}


// ---------------------------------------------------------------------------
// ဆိုင်ရှေ့ ရောင်းချမှု (POS) — admin က ချက်ချင်း အော်ဒါဖန်တီး + ဘောက်ချာထုတ်ရန်
// body: { items:[{id,qty}], custom:[{name,amount,qty}], name, phone, note, paid, pickup_time, status }
// ---------------------------------------------------------------------------
async function handlePosOrder(request, env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  const qtyById = new Map();
  for (const it of Array.isArray(b.items) ? b.items : []) {
    const id = parseInt(it?.id, 10), qty = parseInt(it?.qty, 10);
    if (!(id > 0) || !(qty > 0) || qty > 99) return json({ ok: false, error: "ပစ္စည်းအချက်အလက် မှားနေပါသည်" }, 400);
    qtyById.set(id, Math.min(99, (qtyById.get(id) || 0) + qty));
  }
  const custom = [];
  for (const c of Array.isArray(b.custom) ? b.custom.slice(0, 30) : []) {
    const amount = parseInt(c?.amount, 10), qty = parseInt(c?.qty, 10) || 1;
    if (!(amount > 0) || amount > 99999999 || qty < 1 || qty > 99) return json({ ok: false, error: "ငွေပမာဏ မှားနေပါသည်" }, 400);
    custom.push({ id: 0, name: cleanText(c?.name, 60) || "အခြား", price: amount, qty, total: amount * qty, custom: true });
  }
  if (!qtyById.size && !custom.length) return json({ ok: false, error: "ပစ္စည်း မရှိပါ" }, 400);

  const items = [];
  let total = 0;
  const byId = new Map();
  if (qtyById.size) {
    const ids = [...qtyById.keys()];
    const found = await env.DB.prepare(`SELECT id, name, price, available, stock, daily_stock FROM products WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
    for (const r of found.results || []) byId.set(r.id, r);
    for (const [id, qty] of qtyById) {
      const p = byId.get(id);
      if (!p) return json({ ok: false, error: "ပစ္စည်းတစ်ခု မရှိတော့ပါ၊ Refresh လုပ်ပါ" }, 400);
      if (p.daily_stock > 0 && p.stock < qty) return json({ ok: false, error: `${p.name} ကျန်သည်မှာ ${Math.max(0, p.stock)} ခုသာ ရှိပါတော့သည်` }, 400);
      const price = Number(p.price) || 0;
      items.push({ id, name: p.name, price, qty, total: price * qty });
      total += price * qty;
    }
  }
  for (const c of custom) { items.push(c); total += c.total; }

  const reserved = [];
  for (const [id, qty] of qtyById) {
    const p = byId.get(id);
    if (!(p.daily_stock > 0)) continue;
    const r = await env.DB.prepare(`UPDATE products SET stock = stock - ?, available = CASE WHEN stock - ? <= 0 THEN 0 ELSE available END WHERE id = ? AND stock >= ?`).bind(qty, qty, id, qty).run();
    if (!(r.meta && r.meta.changes > 0)) { await releaseStock(env, reserved); return json({ ok: false, error: `${p.name} ကုန်သွားပါပြီ` }, 400); }
    reserved.push({ id, qty });
  }

  const name = cleanText(b.name, 100) || "ဆိုင်တွင်ဝယ်သူ";
  const phone = cleanText(b.phone, 100) || "ဆိုင်တွင်";
  const note = String(b.note ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim().slice(0, 300);
  const time = /^\d{2}:\d{2}$/.test(String(b.pickup_time || "")) ? String(b.pickup_time) : "";
  const status = ["New", "Processing", "Ready", "Completed"].includes(b.status) ? b.status : "Processing";
  const pay = b.paid ? "Paid" : "Pending";
  let orderId;
  try {
    const r = await env.DB.prepare(
      `INSERT INTO orders (voucher_code, customer_name, phone, items_json, total, status, payment_status, pickup_date, pickup_time, packs_json, discount, promo_code, customer_note)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, '', ?)`
    ).bind(name, phone, JSON.stringify(items), total, status, pay, "ဆိုင်တွင်", time, note).run();
    orderId = r.meta.last_row_id;
  } catch (e) {
    await releaseStock(env, reserved);
    return json({ ok: false, error: "အော်ဒါ သိမ်းမရပါ" }, 500);
  }
  const vCode = `#${vPrefix(env)}-${String(orderId).padStart(4, "0")}`;
  try { await env.DB.prepare(`UPDATE orders SET voucher_code = ? WHERE id = ?`).bind(vCode, orderId).run(); } catch (_) {}
  const row = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(orderId).first();
  return json({ ok: true, order: row });
}

// ဆိုင်မှာ တိုက်ရိုက်ရောင်းခြင်း (Admin POS) — website မသုံးဘဲ ဘောက်ချာ/နံပါတ်ချက်ချင်းထုတ်
async function handleWalkin(request, env) {
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const qtyById = new Map();
  for (const it of Array.isArray(b.items) ? b.items : []) {
    const id = parseInt(it?.id, 10), q = parseInt(it?.qty, 10);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(q) || q <= 0 || q > 99) return json({ ok: false, error: "ပစ္စည်းအချက်အလက် မှားနေပါသည်" }, 400);
    qtyById.set(id, Math.min(99, (qtyById.get(id) || 0) + q));
  }
  if (!qtyById.size || qtyById.size > 50) return json({ ok: false, error: "ပစ္စည်း မရွေးရသေးပါ" }, 400);
  const ids = [...qtyById.keys()];
  const found = await env.DB.prepare(`SELECT id, name, price, available, stock, daily_stock FROM products WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
  const byId = new Map((found.results || []).map((r) => [r.id, r]));
  const items = []; let total = 0;
  for (const [id, qty] of qtyById) {
    const p = byId.get(id);
    if (!p) return json({ ok: false, error: "ပစ္စည်းတစ်ခု မရှိတော့ပါ" }, 400);
    if (p.daily_stock > 0 && p.stock < qty) return json({ ok: false, error: `${p.name} ကျန်သည်မှာ ${Math.max(0, p.stock)} ခုသာ ရှိပါသည်` }, 400);
    const price = Number(p.price) || 0;
    items.push({ id, name: p.name, price, qty, total: price * qty }); total += price * qty;
  }
  const reserved = [];
  for (const [id, qty] of qtyById) {
    const p = byId.get(id); if (!(p.daily_stock > 0)) continue;
    const r = await env.DB.prepare(`UPDATE products SET stock = stock - ?, available = CASE WHEN stock - ? <= 0 THEN 0 ELSE available END WHERE id = ? AND stock >= ?`).bind(qty, qty, id, qty).run();
    if (!(r.meta && r.meta.changes > 0)) { await releaseStock(env, reserved); return json({ ok: false, error: `${p.name} ကုန်သွားပါပြီ` }, 400); }
    reserved.push({ id, qty });
  }
  const name = cleanText(b.name, 60) || "ဆိုင်မှာဝယ်";
  const day = "ဆိုင်မှာ " + mmtDate();
  const mm = mmtNow(), hhmm = mm.toISOString().slice(11, 16);
  const paid = b.paid === false ? "Pending" : "Paid";
  let orderId, queue;
  try {
    const c = await env.DB.prepare(`SELECT COUNT(*) c FROM orders WHERE pickup_date = ?`).bind(day).first();
    queue = ((c && c.c) || 0) + 1;
    const r = await env.DB.prepare(
      `INSERT INTO orders (voucher_code, customer_name, phone, items_json, total, status, payment_status, pickup_date, pickup_time, packs_json, discount, promo_code, customer_note)
       VALUES (NULL, ?, '', ?, ?, 'Processing', ?, ?, ?, '', 0, '', ?)`
    ).bind(name, JSON.stringify(items), total, paid, day, hhmm, cleanText(b.note, 200)).run();
    orderId = r.meta.last_row_id;
  } catch (e) {
    await releaseStock(env, reserved);
    return json({ ok: false, error: "သိမ်းမရပါ၊ ပြန်ကြိုးစားပါ" }, 500);
  }
  const vCode = `#${vPrefix(env)}-${String(orderId).padStart(4, "0")}`;
  try { await env.DB.prepare(`UPDATE orders SET voucher_code = ? WHERE id = ?`).bind(vCode, orderId).run(); } catch (_) {}
  return json({ ok: true, order_id: orderId, vCode, queue, total, items, payment_status: paid, name, time: hhmm, date: mmtDate(), note: cleanText(b.note, 200) });
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

const HANDLER = {
  // Cloudflare Cron Trigger (Triggers → Cron → * * * * *)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await ensureGlobal(env);
        const main = scopedEnv(env, SHOP1);
        await ensureSchema(main);
        await setSetting(main, "last_cron", new Date().toISOString()).catch(() => {});   // Cron အလုပ်လုပ်နေခြင်း အမှတ်အသား
        let shops = [];
        try { shops = (await env.DB.prepare(`SELECT * FROM shops WHERE status = 'active' ORDER BY id`).all()).results || []; } catch (_) {}
        if (!shops.some((x) => x.id === 1)) shops.unshift(SHOP1);
        for (const sh of shops) {   // ဆိုင်တစ်ဆိုင်စီ သတိပေးချက် / နေ့စဉ် stock ပြန်စ
          const se = scopedEnv(env, sh);
          try {
            await ensureSchema(se);
            await runReminders(se).catch((e) => console.log("reminder error:", sh.id, e.message));
            await runDailyReset(se).catch((e) => console.log("daily reset error:", sh.id, e.message));
          } catch (e) { console.log("shop cron error:", sh.id, e.message); }
        }
        await env.DB.prepare(`DELETE FROM rate_limits WHERE t < ?`).bind(nowSec() - 86400).run().catch(() => {});
      })()
    );
  },

  async fetch(request, env, ctx) {
    let res;
    if (request.method === "OPTIONS") {
      res = new Response(null, { status: 204 });
    } else {
      try {
        res = await HANDLER.route(request, env, ctx);
      } catch (e) {
        console.log("unhandled error:", e && e.message);
        res = json({ ok: false, error: "Server error" }, 500);
      }
    }
    return withSecurity(res, request, env);
  },

  async route(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (env.DB) await ensureGlobal(env);
    } catch (e) {
      console.log("Schema init error:", e.message);
    }

    if (path === "/api/shops" && request.method === "GET") return handleShopList(env, request);

    if ((["/api/send-order", "/api/shop-status", "/api/promo/check", "/api/order-status", "/api/products"].includes(path) || /^\/api\/img\/\d+$/.test(path)) && env.DB) {
      const senv = await publicShopEnv(request, env, url);
      if (!senv) return json({ ok: false, error: "ဆိုင် မတွေ့ပါ သို့မဟုတ် ခေတ္တပိတ်ထားပါသည်" }, 404);
      try { await ensureSchema(senv); } catch (e) { console.log("Schema init error:", e.message); }
      env = senv;
    }

    const imgM = path.match(/^\/api\/img\/(\d+)$/);
    if (imgM && request.method === "GET") return handleImage(request, env, Number(imgM[1]), ctx);

    if (path === "/api/send-order") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleSendOrder(request, env, ctx);
    }

    if (path === "/api/shop-status" && request.method === "GET") return handleShopStatus(env);
    if (path === "/api/promo/check" && request.method === "POST") return handlePromoCheck(request, env);

    if (path === "/api/order-status") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleOrderStatus(request, env);
    }

    // Customer App မှ Products များ ကြည့်နိုင်ရန် Public API ဖွင့်ပေးခြင်း
    if (path === "/api/products" && request.method === "GET") {
      return handlePublicProducts(env);
    }

    if (path.startsWith("/api/admin/")) {
      // Admin key ခန့်မှန်းတိုက်ခိုက်ခြင်း တားဆီးရန် — မှားတာ ၈ ကြိမ်ရင် ၁၅ မိနစ် ပိတ်
      const ipKey = "adm:" + clientIp(request);
      if ((await rateCount(env, ipKey, 900).catch(() => 0)) >= 8) {
        return json({ ok: false, error: "မှားယွင်းမှု များလွန်းသဖြင့် ၁၅ မိနစ် ခေတ္တပိတ်ထားပါသည်" }, 429);
      }
      const ident = await adminIdentity(request, env);
      if (!ident) {
        await rateHit(env, ipKey, 900).catch(() => {});
        return json({ ok: false, error: "Unauthorized" }, 401);
      }
      if (ident.missing) return json({ ok: false, error: "ဆိုင် မတွေ့ပါ" }, 404);

      // Owner သာ — ဆိုင်များ စီမံခြင်း
      if (path === "/api/admin/shops" || path.startsWith("/api/admin/shops/")) {
        if (ident.role !== "owner") return json({ ok: false, error: "ပိုင်ရှင်သာ လုပ်ခွင့်ရှိပါသည်" }, 403);
        return handleShopsAdmin(request, env, path);
      }
      if (ident.role === "vendor" && ident.shop.status !== "active") {
        return json({ ok: false, error: "ဤဆိုင်ကို ခေတ္တပိတ်ထားပါသည်၊ မြင်သာ Marketplace ပိုင်ရှင်ထံ ဆက်သွယ်ပါ" }, 403);
      }
      // ဤနေရာမှစ၍ လုပ်ဆောင်ချက်အားလုံးသည် ရွေးထားသော ဆိုင်၏ ဒေတာကိုသာ ထိမည်
      const rootEnv = env;
      env = scopedEnv(rootEnv, ident.shop);
      try { await ensureSchema(env); } catch (e) { console.log("Schema init error:", e.message); }
      if (path === "/api/admin/shop-profile" && (request.method === "GET" || request.method === "POST")) {
        return handleShopProfile(request, env);
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
      if (path === "/api/admin/pos-order" && request.method === "POST") {
        return handlePosOrder(request, env);
      }
      if (path === "/api/admin/walkin" && request.method === "POST") {
        return handleWalkin(request, env);
      }
      if (path === "/api/admin/upload" && request.method === "POST") return handleUpload(request, env);
      if (path === "/api/admin/categories/rename" && request.method === "POST") return handleCategoryRename(request, env);
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
      if (path === "/api/admin/promos" && request.method === "GET") return handlePromoList(env);
      if (path === "/api/admin/promos" && request.method === "POST") return handlePromoCreate(request, env);
      const promoMatch = path.match(/^\/api\/admin\/promos\/([A-Za-z0-9_-]{3,20})$/);
      if (promoMatch && (request.method === "PUT" || request.method === "PATCH")) return handlePromoUpdate(request, env, promoMatch[1]);
      if (promoMatch && request.method === "DELETE") return handlePromoDelete(env, promoMatch[1]);
      if (path === "/api/admin/ping" && request.method === "GET") {
        return json({
          ok: true,
          key_strong: ident.role === "owner" ? String(env.ADMIN_KEY || "").length >= 16 : true,
          role: ident.role,
          shop: { id: ident.shop.id, slug: ident.shop.slug, name: ident.shop.name || "" },
        });
      }

      return json({ ok: false, error: "Not found" }, 404);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return json({ ok: false, error: "Assets binding not found" }, 404);
  },
};

export default HANDLER;
