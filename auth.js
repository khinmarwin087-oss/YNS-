// auth.js — ဝယ်သူ Login : Telegram bot OTP + Telegram မရှိသူအတွက် Admin အတည်ပြုပေးခြင်း၊ ဝင်ရောက်သူ/Visitor စာရင်း
//
// Telegram က ဖုန်းနံပါတ်နဲ့ chat ကို တိုက်ရိုက် မချိတ်နိုင်လို့ ဒီလို လုပ်သည် —
//   ၁) ဝယ်သူ ဖုန်းထည့် → "Telegram" ရွေး → t.me/<bot>?start=<nonce> ဖွင့်
//   ၂) Bot က "ဖုန်းနံပါတ် မျှဝေရန်" ခလုတ် ပြ → ဝယ်သူ ကိုယ်ပိုင် contact မျှဝေ
//   ၃) ဖုန်းနံပါတ် တူမှ (contact.user_id == ကိုယ်တိုင်) OTP ကို ထို chat ဆီသို့ ပို့
//   ဒုတိယအကြိမ်ကစ ချိတ်ပြီးသား chat ဆီ OTP တန်းပို့
// OTP ကို hash သိမ်း၊ ၅ ကြိမ်မှားလျှင် ပျက်၊ ၅ မိနစ်သက်တမ်း။

const enc = new TextEncoder();
const nowSec = () => Math.floor(Date.now() / 1000);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

// မြန်မာဖုန်း → 959xxxxxxxxx (မမှန်လျှင် "")
export function normMm(v) {
  let d = String(v ?? "").replace(/\D/g, "");
  if (d.startsWith("0959")) d = d.slice(1);
  if (d.startsWith("959")) { /* ok */ } else if (d.startsWith("95")) d = "959" + d.slice(2);
  else if (d.startsWith("09")) d = "95" + d.slice(1);
  else if (d.startsWith("9")) d = "95" + d;
  return /^959\d{7,9}$/.test(d) ? d : "";
}
const dispPhone = (p) => "0" + String(p).slice(2); // 959… → 09…
export const mmtDay = () => new Date(Date.now() + 390 * 60000).toISOString().slice(0, 10);

let ready = false;
export async function ensureAuthSchema(env) {
  if (ready) return;
  const raw = env.RAW || env.DB;
  await raw.prepare(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE NOT NULL, name TEXT DEFAULT '', tg_chat TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`).run();
  await raw.prepare(`CREATE TABLE IF NOT EXISTS otp_codes (phone TEXT PRIMARY KEY, code_hash TEXT DEFAULT '', method TEXT DEFAULT 'sms', expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0, nonce TEXT DEFAULT '', tg_chat TEXT DEFAULT '')`).run();
  await raw.prepare(`CREATE TABLE IF NOT EXISTS login_requests (id TEXT PRIMARY KEY, shop_id INTEGER DEFAULT 1, phone TEXT NOT NULL, name TEXT DEFAULT '', secret_hash TEXT NOT NULL, status TEXT DEFAULT 'pending', created_at INTEGER NOT NULL, decided_at INTEGER DEFAULT 0, decided_by TEXT DEFAULT '')`).run();
  await raw.prepare(`CREATE TABLE IF NOT EXISTS user_shops (user_id INTEGER NOT NULL, shop_id INTEGER NOT NULL, first_day TEXT, last_day TEXT, logins INTEGER DEFAULT 0, PRIMARY KEY (user_id, shop_id))`).run();
  await raw.prepare(`CREATE TABLE IF NOT EXISTS site_visits (shop_id INTEGER NOT NULL, day TEXT NOT NULL, vid TEXT NOT NULL, hits INTEGER DEFAULT 1, PRIMARY KEY (shop_id, day, vid))`).run();
  for (const c of ["google_sub TEXT", "email TEXT DEFAULT ''"]) { try { await raw.prepare(`ALTER TABLE users ADD COLUMN ${c}`).run(); } catch (_) {} }
  for (const c of ["source TEXT", "device TEXT", "page TEXT", "last_at INTEGER DEFAULT 0"]) { try { await raw.prepare(`ALTER TABLE site_visits ADD COLUMN ${c}`).run(); } catch (_) {} }
  try { await raw.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users(google_sub) WHERE google_sub IS NOT NULL`).run(); } catch (_) {}
  ready = true;
}

const secretOf = (env) => String(env.ADMIN_KEY || "");
export const webhookSecret = async (env) => (await hmacHex(secretOf(env), "tg-webhook")).slice(0, 48);

async function signToken(env, uid) {
  const body = b64u(JSON.stringify({ u: uid, e: Date.now() + 30 * 86400000 }));
  return body + "." + (await hmacHex(secretOf(env), "user-token|" + body));
}
export async function verifyUserToken(env, token) {
  const p = String(token || "").split(".");
  if (p.length !== 2 || !secretOf(env)) return null;
  const good = await hmacHex(secretOf(env), "user-token|" + p[0]);
  let ok = good.length === p[1].length; let d = 0;
  for (let i = 0; i < good.length; i++) d |= good.charCodeAt(i) ^ (p[1].charCodeAt(i) || 0);
  if (!ok || d !== 0) return null;
  try {
    const o = JSON.parse(unb64u(p[0]));
    if (!o || o.e < Date.now()) return null;
    return await (env.RAW || env.DB).prepare(`SELECT id, phone, name FROM users WHERE id = ?`).bind(o.u).first();
  } catch (_) { return null; }
}

async function tgApi(env, method, body) {
  if (!env.BOT_TOKEN) return { ok: false };
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch (_) { return { ok: false }; }
}
let _botName = "";
async function botUsername(env) {
  if (_botName) return _botName;
  const r = await tgApi(env, "getMe", {});
  if (r.ok && r.result && r.result.username) _botName = r.result.username;
  return _botName;
}

const newOtp = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
const otpHash = (env, phone, code) => hmacHex(secretOf(env), `otp|${phone}|${code}`);

async function storeOtp(env, phone, method, extra = {}) {
  const code = newOtp(), h = await otpHash(env, phone, code);
  await env.DB.prepare(`INSERT INTO otp_codes (phone, code_hash, method, expires_at, attempts, nonce, tg_chat) VALUES (?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, method = excluded.method, expires_at = excluded.expires_at, attempts = 0, nonce = excluded.nonce, tg_chat = excluded.tg_chat`)
    .bind(phone, h, method, nowSec() + 300, extra.nonce || "", extra.tg_chat || "").run();
  return code;
}


async function recordLogin(env, userId, shopId) {
  const d = mmtDay(), sid = Number(shopId) || 1;
  await (env.RAW || env.DB).prepare(`INSERT INTO user_shops (user_id, shop_id, first_day, last_day, logins) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(user_id, shop_id) DO UPDATE SET last_day = excluded.last_day, logins = user_shops.logins + 1`).bind(userId, sid, d, d).run();
}
// Google ဖြင့် ဝင်ပြီး ဖုန်းမချိတ်ရသေးသူ — ဖုန်းအတည်ပြုချိန် google ကို ချိတ်ရန် ယာယီ လက်မှတ် (၁၅ မိနစ်)
async function signGl(env, o) { const body = b64u(JSON.stringify({ ...o, e: Date.now() + 15 * 60000 })); return body + "." + (await hmacHex(secretOf(env), "gl|" + body)); }
async function readGl(env, t) {
  try { const [body, sig] = String(t || "").split("."); if (!body || !sig || sig !== (await hmacHex(secretOf(env), "gl|" + body))) return null; const o = JSON.parse(unb64u(body)); return o.e > Date.now() && o.sub ? o : null; } catch { return null; }
}
async function verifyGoogle(env, credential) {
  const cid = String(env.GOOGLE_CLIENT_ID || "").trim();
  if (!cid) return { error: "Google login မဖွင့်ရသေးပါ" };
  try {
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
    const d = await r.json();
    if (!r.ok || d.aud !== cid || !/^(https:\/\/)?accounts\.google\.com$/.test(d.iss || "") || String(d.email_verified) !== "true" || Number(d.exp) * 1000 < Date.now() || !d.sub) return { error: "Google အတည်ပြု၍ မရပါ" };
    return { sub: String(d.sub), email: String(d.email || "").slice(0, 120), name: cleanName(d.name || d.given_name || "") };
  } catch (_) { return { error: "Google နှင့် ဆက်သွယ်၍ မရပါ" }; }
}
// Google သက်သက်အကောင့်၏ ဖုန်းနေရာ 'g…' ကို ဝယ်သူဘက် မပြ
const pubUser = (u) => (u && /^g/.test(String(u.phone)) ? { ...u, phone: "", google: true } : u);
// ဝင်ရောက်သူ၏ ဖုန်းအမျိုးအစား / ဘယ်ကလာလဲ — IP မသိမ်း၊ ဖုန်းအမျိုးအစားနှင့် လာရာနေရာကိုသာ
const deviceOf = (ua) => (/android/i.test(ua) ? "Android" : /iphone|ipad|ipod/i.test(ua) ? "iOS" : "PC/Other");
function sourceOf(ref, src, selfHost) {
  const q = String(src || "").toLowerCase();
  const m = { facebook: "Facebook", fb: "Facebook", messenger: "Messenger", telegram: "Telegram", viber: "Viber", tiktok: "TikTok", instagram: "Instagram", google: "Google", youtube: "YouTube" };
  if (q) { for (const k in m) if (q.includes(k)) return m[k]; return "Other"; }
  let h = ""; try { h = new URL(ref).hostname.toLowerCase(); } catch (_) {}
  if (!h || h === selfHost || h.endsWith("." + selfHost)) return "Direct";
  if (/messenger\./.test(h)) return "Messenger";
  if (/facebook\.|(^|\.)fb\.|fbcdn/.test(h)) return "Facebook";
  if (/(^|\.)t\.me$|telegram/.test(h)) return "Telegram";
  if (/viber/.test(h)) return "Viber";
  if (/tiktok/.test(h)) return "TikTok";
  if (/instagram/.test(h)) return "Instagram";
  if (/youtube|youtu\.be/.test(h)) return "YouTube";
  if (/google\./.test(h)) return "Google";
  return "Other";
}
const cleanName = (v) => String(v ?? "").replace(/[<>]/g, "").trim().slice(0, 60);

// ---------------------------------------------------------------------------
export async function handleAuth(request, env, path, h) {
  const { json, rateTake, clientIp, safeEq } = h; const shopId = Number(h.shopId) || 1;
  await ensureAuthSchema(env);

  if (path === "/api/auth/send-otp" && request.method === "POST") {
    let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const phone = normMm(b.phone);
    if (!phone) return json({ ok: false, error: "မြန်မာဖုန်းနံပါတ် မှန်အောင်ဖြည့်ပါ (ဥပမာ 09xxxxxxxxx)" }, 400);
    if (await rateTake(env, "otpP:" + phone, 1, 60)) return json({ ok: false, error: "၁ မိနစ်အတွင်း ထပ်တောင်း၍ မရပါ" }, 429);
    if (await rateTake(env, "otpH:" + phone, 6, 3600)) return json({ ok: false, error: "ဤနံပါတ်အတွက် တစ်နာရီအတွင်း အကြိမ်များနေပါသည်" }, 429);
    if (await rateTake(env, "otpI:" + clientIp(request), 12, 3600)) return json({ ok: false, error: "တောင်းဆိုမှု များနေပါသည် — ခဏနေမှ ထပ်ကြိုးစားပါ" }, 429);

    if (b.method === "sms") return json({ ok: false, error: "SMS ဖြင့် ဝင်ခြင်း မရှိတော့ပါ — Telegram သုံးပါ၊ Telegram မရှိလျှင် Admin အတည်ပြုခိုင်းနိုင်ပါသည်" }, 400);

    // Telegram
    const bot = await botUsername(env);
    if (!bot) return json({ ok: false, error: "Telegram bot မချိတ်ရသေးပါ — Admin အတည်ပြုခိုင်းပါ" }, 503);
    const u = await env.DB.prepare(`SELECT tg_chat FROM users WHERE phone = ?`).bind(phone).first();
    if (u && u.tg_chat) {   // ချိတ်ပြီးသား chat ဆီ တန်းပို့
      const code = await storeOtp(env, phone, "telegram", { tg_chat: u.tg_chat });
      const r = await tgApi(env, "sendMessage", { chat_id: u.tg_chat, text: `🔐 Login OTP: ${code}\n(၅ မိနစ်အတွင်း အသုံးပြုပါ)` });
      if (r.ok) return json({ ok: true, method: "telegram", message: "Telegram သို့ ကုဒ်ပို့ပြီးပါပြီ" });
    }
    const nonce = randHex(12);
    await storeOtp(env, phone, "telegram", { nonce });   // code ကို contact အတည်ပြုပြီးမှ ပြန်ထုတ်
    await env.DB.prepare(`UPDATE otp_codes SET code_hash = '', expires_at = ? WHERE phone = ?`).bind(nowSec() + 600, phone).run();
    return json({ ok: true, method: "telegram", link: `https://t.me/${bot}?start=${nonce}`, message: "Telegram ဖွင့်ပြီး Start နှိပ်ပါ" });
  }

  if (path === "/api/auth/verify-otp" && request.method === "POST") {
    let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const phone = normMm(b.phone), code = String(b.code ?? "").replace(/\D/g, "");
    if (!phone || code.length !== 6) return json({ ok: false, error: "ကုဒ် ၆ လုံး ဖြည့်ပါ" }, 400);
    if (await rateTake(env, "otpV:" + clientIp(request), 30, 3600)) return json({ ok: false, error: "ကြိုးစားမှု များနေပါသည်" }, 429);
    const rec = await env.DB.prepare(`SELECT code_hash, expires_at, attempts, tg_chat FROM otp_codes WHERE phone = ?`).bind(phone).first();
    if (!rec || !rec.code_hash || rec.expires_at < nowSec()) return json({ ok: false, error: "ကုဒ် မရှိ သို့မဟုတ် သက်တမ်းကုန်ပါပြီ — အသစ်တောင်းပါ" }, 400);
    if (rec.attempts >= 5) { await env.DB.prepare(`DELETE FROM otp_codes WHERE phone = ?`).bind(phone).run(); return json({ ok: false, error: "အကြိမ်ရေ ကျော်သွားပါပြီ — ကုဒ်အသစ်တောင်းပါ" }, 429); }
    if (!safeEq(rec.code_hash, await otpHash(env, phone, code))) {
      await env.DB.prepare(`UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?`).bind(phone).run();
      return json({ ok: false, error: "ကုဒ် မှားနေပါသည်" }, 400);
    }
    await env.DB.prepare(`DELETE FROM otp_codes WHERE phone = ?`).bind(phone).run();
    await env.DB.prepare(`INSERT INTO users (phone, tg_chat) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET tg_chat = CASE WHEN excluded.tg_chat != '' THEN excluded.tg_chat ELSE users.tg_chat END`).bind(phone, rec.tg_chat || "").run();
    const user = await env.DB.prepare(`SELECT id, phone, name FROM users WHERE phone = ?`).bind(phone).first();
    const gl = b.gl ? await readGl(env, b.gl) : null;   // Google ကို ဤဖုန်းနှင့် ချိတ် (ဖုန်းကို OTP ဖြင့် အတည်ပြုပြီးမှသာ)
    if (gl) {
      const has = await env.DB.prepare(`SELECT google_sub FROM users WHERE id = ?`).bind(user.id).first();
      const taken = await env.DB.prepare(`SELECT id FROM users WHERE google_sub = ?`).bind(gl.sub).first();
      if (!(has && has.google_sub) && !taken) {
        await env.DB.prepare(`UPDATE users SET google_sub = ?, email = ?, name = CASE WHEN name = '' THEN ? ELSE name END WHERE id = ?`).bind(gl.sub, gl.email || "", gl.name || "", user.id).run();
        user.name = user.name || gl.name || "";
      }
    }
    await recordLogin(env, user.id, shopId);
    return json({ ok: true, token: await signToken(env, user.id), user });
  }

  if (path === "/api/auth/config" && request.method === "GET") return json({ ok: true, google: String(env.GOOGLE_CLIENT_ID || "").trim() });
  if (path === "/api/auth/google" && request.method === "POST") {
    let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (await rateTake(env, "gg:" + clientIp(request), 30, 3600)) return json({ ok: false, error: "ခဏစောင့်ပါ" }, 429);
    const g = await verifyGoogle(env, String(b.credential || ""));
    if (g.error) return json({ ok: false, error: g.error }, 400);
    const raw = env.RAW || env.DB;
    const user = await raw.prepare(`SELECT id, phone, name FROM users WHERE google_sub = ?`).bind(g.sub).first();
    let u = user;
    if (!u) {   // Google သက်သက်ဖြင့် ပထမဆုံးဝင် — ဖုန်း/Telegram မလို (ဖုန်းနေရာတွင် Google ID သုံး)
      await raw.prepare(`INSERT INTO users (phone, name, google_sub, email) VALUES (?, ?, ?, ?)`).bind("g" + g.sub, g.name || "", g.sub, g.email || "").run();
      u = await raw.prepare(`SELECT id, phone, name FROM users WHERE google_sub = ?`).bind(g.sub).first();
    }
    await recordLogin(env, u.id, shopId);
    return json({ ok: true, token: await signToken(env, u.id), user: pubUser(u), email: g.email });
  }
  // Telegram မရှိသူ — Admin အတည်ပြုပေးရန် တောင်းဆို
  if (path === "/api/auth/request-manual" && request.method === "POST") {
    let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const phone = normMm(b.phone), name = cleanName(b.name);
    if (!phone) return json({ ok: false, error: "မြန်မာဖုန်းနံပါတ် မှန်အောင်ဖြည့်ပါ (ဥပမာ 09xxxxxxxxx)" }, 400);
    if (!name) return json({ ok: false, error: "အမည် ဖြည့်ပါ — Admin က သင်ဘယ်သူလဲ သိနိုင်ရန်" }, 400);
    if (await rateTake(env, "lrP:" + phone, 3, 3600)) return json({ ok: false, error: "ဤနံပါတ်အတွက် တောင်းဆိုမှု များနေပါသည် — ခဏနေမှ ပြန်ကြိုးစားပါ" }, 429);
    if (await rateTake(env, "lrI:" + clientIp(request), 8, 3600)) return json({ ok: false, error: "တောင်းဆိုမှု များနေပါသည်" }, 429);
    const raw = env.RAW || env.DB, id = randHex(8), secret = randHex(16);
    await raw.prepare(`DELETE FROM login_requests WHERE phone = ? AND shop_id = ? AND status = 'pending'`).bind(phone, shopId).run();
    await raw.prepare(`INSERT INTO login_requests (id, shop_id, phone, name, secret_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
      .bind(id, shopId, phone, name, await hmacHex(secretOf(env), "lr|" + id + "|" + secret), nowSec()).run();
    if (h.notify) { try { await h.notify(`🔐 Login အတည်ပြုရန် တောင်းဆိုမှု\nအမည်: ${name}\nဖုန်း: ${dispPhone(phone)}\nAdmin → ပင်မစာမျက်နှာမှာ အတည်ပြု/ပယ်ပါ`); } catch (_) {} }
    return json({ ok: true, id, secret });
  }
  if (path === "/api/auth/manual-status" && request.method === "GET") {
    const u = new URL(request.url), id = (u.searchParams.get("id") || "").replace(/[^a-f0-9]/g, ""), secret = (u.searchParams.get("secret") || "").replace(/[^a-f0-9]/g, "");
    if (!id || !secret) return json({ ok: false }, 400);
    if (await rateTake(env, "lrS:" + clientIp(request), 240, 3600)) return json({ ok: false, error: "ခဏစောင့်ပါ" }, 429);
    const raw = env.RAW || env.DB;
    const r = await raw.prepare(`SELECT * FROM login_requests WHERE id = ?`).bind(id).first();
    if (!r || !safeEq(r.secret_hash, await hmacHex(secretOf(env), "lr|" + id + "|" + secret))) return json({ ok: false, status: "none" }, 404);
    const now = nowSec();
    if (r.status === "pending") return json({ ok: true, status: now - r.created_at > 6 * 3600 ? "expired" : "pending" });
    if (r.status === "rejected") return json({ ok: true, status: "rejected" });
    if (r.status === "used") return json({ ok: true, status: "used" });
    if (r.status === "approved" && now - r.decided_at < 900) {
      const ch = await raw.prepare(`UPDATE login_requests SET status = 'used' WHERE id = ? AND status = 'approved'`).bind(id).run();
      if (!(ch.meta && ch.meta.changes > 0)) return json({ ok: true, status: "used" });
      await raw.prepare(`INSERT INTO users (phone, name) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET name = CASE WHEN users.name = '' THEN excluded.name ELSE users.name END`).bind(r.phone, r.name).run();
      const user = await raw.prepare(`SELECT id, phone, name FROM users WHERE phone = ?`).bind(r.phone).first();
      await recordLogin(env, user.id, r.shop_id);
      return json({ ok: true, status: "approved", token: await signToken(env, user.id), user });
    }
    return json({ ok: true, status: "expired" });
  }
  // Website ဝင်ရောက်သူ — မည်သူမည်ဝါ မသိဘဲ စက်တစ်လုံးချင်း (အမည်မသိ ID) ရေတွက်
  if (path === "/api/auth/visit" && request.method === "POST") {
    let b; try { b = await request.json(); } catch { return json({ ok: true }); }
    let vid = String(b.vid || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
    const fp = String(b.fp || "").slice(0, 300);
    if (vid.length < 8 && !fp) return json({ ok: true });
    if (await rateTake(env, "vis:" + clientIp(request), 120, 3600)) return json({ ok: true });
    // Private window တွင် localStorage အသစ်ဖြစ်၍ ID မတူတော့ — စက်၏ လက္ခဏာ + network ကို လျှို့ဝှက် hash လုပ်ပြီး စက်တစ်လုံးကို တစ်ယောက်တည်း ရေတွက် (မူရင်း IP/လက္ခဏာ မသိမ်း)
    if (fp) vid = (await hmacHex(secretOf(env), "v|" + fp + "|" + clientIp(request) + "|" + (request.headers.get("User-Agent") || ""))).slice(0, 24);
    const selfHost = new URL(request.url).hostname.toLowerCase();
    const src = sourceOf(String(b.ref || "").slice(0, 300), String(b.src || "").slice(0, 40), selfHost), dev = deviceOf(request.headers.get("User-Agent") || ""), pg = String(b.page || "home").replace(/[^\w\-./]/g, "").slice(0, 40) || "home";
    await (env.RAW || env.DB).prepare(`INSERT INTO site_visits (shop_id, day, vid, hits, source, device, page, last_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(shop_id, day, vid) DO UPDATE SET hits = hits + 1, last_at = excluded.last_at`).bind(shopId, mmtDay(), vid, src, dev, pg, nowSec()).run();
    return json({ ok: true });
  }

  if (path === "/api/auth/me" && request.method === "GET") {
    const user = await verifyUserToken(env, (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""));
    return user ? json({ ok: true, user: pubUser(user) }) : json({ ok: false }, 401);
  }
  if (path === "/api/auth/name" && request.method === "POST") {
    const user = await verifyUserToken(env, (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""));
    if (!user) return json({ ok: false }, 401);
    let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
    const name = String(b.name ?? "").replace(/[<>]/g, "").trim().slice(0, 60);
    await env.DB.prepare(`UPDATE users SET name = ? WHERE id = ?`).bind(name, user.id).run();
    return json({ ok: true, name });
  }

  // Telegram webhook — secret header စစ်
  if (path === "/api/tg/webhook" && request.method === "POST") {
    if (!safeEq(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", await webhookSecret(env))) return json({ ok: false }, 403);
    let u; try { u = await request.json(); } catch { return json({ ok: true }); }
    const m = u && u.message; if (!m || !m.chat || m.chat.type !== "private") return json({ ok: true });
    const chat = String(m.chat.id), say = (text, extra = {}) => tgApi(env, "sendMessage", { chat_id: chat, text, ...extra });
    const t = String(m.text || "");
    const st = t.match(/^\/start\s+([a-f0-9]{24})$/);
    if (st) {
      const r = await env.DB.prepare(`UPDATE otp_codes SET tg_chat = ? WHERE nonce = ? AND expires_at > ?`).bind(chat, st[1], nowSec()).run();
      if (!(r.meta && r.meta.changes > 0)) { await say("ကုဒ် သက်တမ်းကုန်သွားပါပြီ — ဝက်ဘ်ဆိုက်မှာ ပြန်တောင်းပါ"); return json({ ok: true }); }
      await say("မင်္ဂလာပါ 👋 ဖုန်းနံပါတ် အတည်ပြုရန် အောက်က ခလုတ်ကို နှိပ်ပါ", { reply_markup: { keyboard: [[{ text: "📱 ဖုန်းနံပါတ် မျှဝေမည်", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
    } else if (m.contact) {
      const c = m.contact, rec = await env.DB.prepare(`SELECT phone FROM otp_codes WHERE tg_chat = ? AND nonce != '' AND expires_at > ?`).bind(chat, nowSec()).first();
      if (!rec) { await say("အရင်ဆုံး ဝက်ဘ်ဆိုက်မှာ Telegram ကုဒ်တောင်းပါ"); return json({ ok: true }); }
      if (String(c.user_id) !== String(m.from && m.from.id)) {
        await say("❌ ကိုယ်ပိုင် Telegram နံပါတ်ကိုသာ မျှဝေနိုင်ပါသည် (တခြားသူ၏ contact မရပါ)", { reply_markup: { remove_keyboard: true } }); return json({ ok: true });
      }
      if (normMm(c.phone_number) !== rec.phone) {
        await env.DB.prepare(`DELETE FROM otp_codes WHERE phone = ? AND code_hash = ''`).bind(rec.phone).run();
        await say(`❌ ဤ Telegram အကောင့်ရဲ့ ဖုန်းနံပါတ်က ဝက်ဘ်ဆိုက်မှာ ထည့်ခဲ့တဲ့ နံပါတ် (0${rec.phone.slice(2)}) မဟုတ်ပါ။\nသူများနံပါတ်နဲ့ OTP တောင်း၍ မရပါ။ ကိုယ်ပိုင်နံပါတ်ကို ဝက်ဘ်ဆိုက်မှာ ပြန်ထည့်ပါ။`, { reply_markup: { remove_keyboard: true } }); return json({ ok: true });
      }
      const code = await storeOtp(env, rec.phone, "telegram", { tg_chat: chat });
      await say(`🔐 Login OTP: ${code}\n(၅ မိနစ်အတွင်း ဝက်ဘ်ဆိုက်မှာ ထည့်ပါ)`, { reply_markup: { remove_keyboard: true } });
    } else if (/^\/start\b/.test(t)) {
      await say("မင်္ဂလာပါ 👋 Login ဝင်ရန် ဝက်ဘ်ဆိုက်မှာ ဖုန်းနံပါတ်ထည့်ပြီး \"Telegram\" ကို ရွေးကာ \"ကုဒ် ရယူမည်\" ကို နှိပ်ပါ။ ပေါ်လာတဲ့ link ကနေမှ ဒီ bot ကို ဝင်ရပါမယ်။");
    } else {
      await say("ဤ bot သည် Login ကုဒ် ပို့ရန်သာ ဖြစ်ပါသည်။ ဝက်ဘ်ဆိုက်မှာ \"Telegram\" ရွေးပြီး ကုဒ်တောင်းပါ။");
    }
    return json({ ok: true });
  }
  return null;
}

// ပိုင်ရှင်က တစ်ကြိမ် ခေါ် — Telegram webhook ချိတ် (+ အခြေအနေ စစ်)
async function tgInfo(env) {
  const r = await tgApi(env, "getWebhookInfo", {});
  const w = (r && r.result) || {};
  return { url: w.url || "", pending: w.pending_update_count || 0, last_error: w.last_error_message || "", last_error_at: w.last_error_date || 0 };
}
export async function setupTgWebhook(env, origin, onlyStatus) {
  if (!env.BOT_TOKEN) return { ok: false, error: "BOT_TOKEN မသတ်မှတ်ရသေးပါ (Worker Variables/Secrets)" };
  let r = { ok: true };
  if (!onlyStatus) r = await tgApi(env, "setWebhook", { url: origin + "/api/tg/webhook", secret_token: await webhookSecret(env), allowed_updates: ["message"], drop_pending_updates: true });
  const bot = await botUsername(env);
  const info = await tgInfo(env);
  return { ok: !!r.ok && !!bot, bot, webhook: info, expected: origin + "/api/tg/webhook", error: r.description || (bot ? "" : "BOT_TOKEN မှားနေသည် (getMe မရ)") };
}

// Admin ဘက် — Login တောင်းဆိုမှု၊ ဝင်ရောက်သူစာရင်း (ဆိုင်တစ်ဆိုင်ချင်း)
export async function handleAuthAdmin(request, env, path, shopId, h) {
  const { json } = h; shopId = Number(shopId) || 1;
  await ensureAuthSchema(env);
  const raw = env.RAW || env.DB, now = nowSec();
  if (path === "/api/admin/login-requests" && request.method === "GET") {
    const pend = ((await raw.prepare(`SELECT id, phone, name, created_at FROM login_requests WHERE shop_id = ? AND status = 'pending' AND created_at > ? ORDER BY created_at DESC LIMIT 50`).bind(shopId, now - 6 * 3600).all()).results || [])
      .map((r) => ({ id: r.id, phone: dispPhone(r.phone), name: r.name, ago: Math.max(0, Math.floor((now - r.created_at) / 60)) }));
    const done = ((await raw.prepare(`SELECT id, phone, name, status, decided_at FROM login_requests WHERE shop_id = ? AND status != 'pending' ORDER BY decided_at DESC LIMIT 15`).bind(shopId).all()).results || [])
      .map((r) => ({ id: r.id, phone: dispPhone(r.phone), name: r.name, status: r.status === "rejected" ? "rejected" : "approved", ago: Math.max(0, Math.floor((now - r.decided_at) / 60)) }));
    return json({ ok: true, pending: pend, done });
  }
  const m = path.match(/^\/api\/admin\/login-requests\/([a-f0-9]{16})$/);
  if (m && request.method === "POST") {
    let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
    const st = b.action === "approve" ? "approved" : b.action === "reject" ? "rejected" : "";
    if (!st) return json({ ok: false, error: "action မမှန်ပါ" }, 400);
    const r = await raw.prepare(`UPDATE login_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND shop_id = ? AND status = 'pending'`).bind(st, now, h.who || "admin", m[1], shopId).run();
    if (!(r.meta && r.meta.changes > 0)) return json({ ok: false, error: "တောင်းဆိုမှု မတွေ့ပါ သို့မဟုတ် ဆုံးဖြတ်ပြီးသား" }, 404);
    return json({ ok: true, status: st });
  }
  if (path === "/api/admin/visitors" && request.method === "GET") {
    const u = new URL(request.url), days = [1, 7, 30].includes(Number(u.searchParams.get("days"))) ? Number(u.searchParams.get("days")) : 1;
    const d0 = (n) => new Date(Date.now() + 390 * 60000 - n * 86400000).toISOString().slice(0, 10);
    const today = d0(0), yest = d0(1), from = d0(days - 1);
    const one = async (sql, ...b) => (await raw.prepare(sql).bind(...b).first()) || {};
    const t = await one(`SELECT COUNT(*) u, COALESCE(SUM(hits),0) v FROM site_visits WHERE shop_id = ? AND day = ?`, shopId, today);
    const y = await one(`SELECT COUNT(*) u, COALESCE(SUM(hits),0) v FROM site_visits WHERE shop_id = ? AND day = ?`, shopId, yest);
    const grp = async (col) => ((await raw.prepare(`SELECT COALESCE(${col}, 'မသိ') k, COUNT(DISTINCT vid) c FROM site_visits WHERE shop_id = ? AND day >= ? GROUP BY k ORDER BY c DESC`).bind(shopId, from).all()).results || []).map((r) => ({ k: r.k, c: r.c }));
    const recent = ((await raw.prepare(`SELECT source, device, page, hits, last_at FROM site_visits WHERE shop_id = ? ORDER BY last_at DESC, rowid DESC LIMIT 15`).bind(shopId).all()).results || [])
      .map((r) => ({ source: r.source || "မသိ", device: r.device || "မသိ", page: r.page || "home", hits: r.hits, ago: r.last_at ? Math.max(0, Math.floor((now - r.last_at) / 60)) : null }));
    const series = ((await raw.prepare(`SELECT day, COUNT(*) u FROM site_visits WHERE shop_id = ? AND day >= ? GROUP BY day ORDER BY day`).bind(shopId, d0(6)).all()).results || []).map((r) => ({ day: r.day, u: r.u }));
    const n = (v) => Number(v) || 0;
    return json({ ok: true, days, today: { unique: n(t.u), views: n(t.v) }, yesterday: { unique: n(y.u), views: n(y.v) }, sources: await grp("source"), devices: await grp("device"), recent, series });
  }
  if (path === "/api/admin/web-stats" && request.method === "GET") {
    const day = mmtDay(), wk = new Date(Date.now() + 390 * 60000 - 6 * 86400000).toISOString().slice(0, 10), mo = new Date(Date.now() + 390 * 60000 - 29 * 86400000).toISOString().slice(0, 10);
    const one = async (sql, ...b) => (await raw.prepare(sql).bind(...b).first()) || {};
    const mem = await one(`SELECT COUNT(*) total, SUM(first_day = ?) newToday, SUM(last_day = ?) loginToday, SUM(last_day >= ?) loginWeek, SUM(first_day >= ?) newWeek FROM user_shops WHERE shop_id = ?`, day, day, wk, wk, shopId);
    const vt = await one(`SELECT COUNT(*) u, COALESCE(SUM(hits),0) h FROM site_visits WHERE shop_id = ? AND day = ?`, shopId, day);
    const vw = await one(`SELECT COUNT(DISTINCT vid) u FROM site_visits WHERE shop_id = ? AND day >= ?`, shopId, wk);
    const vm = await one(`SELECT COUNT(DISTINCT vid) u FROM site_visits WHERE shop_id = ? AND day >= ?`, shopId, mo);
    const va = await one(`SELECT COUNT(DISTINCT vid) u FROM site_visits WHERE shop_id = ?`, shopId);
    const series = ((await raw.prepare(`SELECT day, COUNT(*) u FROM site_visits WHERE shop_id = ? AND day >= ? GROUP BY day ORDER BY day`).bind(shopId, wk).all()).results || []).map((r) => ({ day: r.day, visitors: r.u }));
    const pend = await one(`SELECT COUNT(*) c FROM login_requests WHERE shop_id = ? AND status = 'pending' AND created_at > ?`, shopId, now - 6 * 3600);
    const n = (v) => Number(v) || 0;
    return json({ ok: true, members: { total: n(mem.total), newToday: n(mem.newToday), newWeek: n(mem.newWeek), loginToday: n(mem.loginToday), loginWeek: n(mem.loginWeek) },
      visitors: { today: n(vt.u), hitsToday: n(vt.h), week: n(vw.u), month: n(vm.u), all: n(va.u), series }, pending: n(pend.c) });
  }
  return null;
}
