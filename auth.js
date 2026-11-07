// auth.js — ဝယ်သူ Login (ဖုန်း OTP) : SMS (SMSPoh) နှင့် Telegram bot နှစ်မျိုး
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
const smsPhone = (p) => "0" + p.slice(2); // 959… → 09…

let ready = false;
export async function ensureAuthSchema(env) {
  if (ready) return;
  const raw = env.RAW || env.DB;
  await raw.prepare(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE NOT NULL, name TEXT DEFAULT '', tg_chat TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`).run();
  await raw.prepare(`CREATE TABLE IF NOT EXISTS otp_codes (phone TEXT PRIMARY KEY, code_hash TEXT DEFAULT '', method TEXT DEFAULT 'sms', expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0, nonce TEXT DEFAULT '', tg_chat TEXT DEFAULT '')`).run();
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

async function sendSms(env, phone, otp) {
  if (!env.SMSPOH_API_KEY) return false;
  try {
    const res = await fetch("https://v3.smspoh.com/api/rest/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SMSPOH_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: smsPhone(phone), from: env.SMSPOH_SENDER_ID || "SMSPohTest", message: `သင့် Login OTP ကုဒ်မှာ ${otp} ဖြစ်ပါသည်။ (၅ မိနစ်အတွင်း အသုံးပြုပါ)` }),
    });
    return res.ok;
  } catch (_) { return false; }
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

// ---------------------------------------------------------------------------
export async function handleAuth(request, env, path, h) {
  const { json, rateTake, clientIp, safeEq } = h;
  await ensureAuthSchema(env);

  if (path === "/api/auth/send-otp" && request.method === "POST") {
    let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const phone = normMm(b.phone), method = b.method === "telegram" ? "telegram" : "sms";
    if (!phone) return json({ ok: false, error: "မြန်မာဖုန်းနံပါတ် မှန်အောင်ဖြည့်ပါ (ဥပမာ 09xxxxxxxxx)" }, 400);
    if (await rateTake(env, "otpP:" + phone, 1, 60)) return json({ ok: false, error: "၁ မိနစ်အတွင်း ထပ်တောင်း၍ မရပါ" }, 429);
    if (await rateTake(env, "otpH:" + phone, 6, 3600)) return json({ ok: false, error: "ဤနံပါတ်အတွက် တစ်နာရီအတွင်း အကြိမ်များနေပါသည်" }, 429);
    if (await rateTake(env, "otpI:" + clientIp(request), 12, 3600)) return json({ ok: false, error: "တောင်းဆိုမှု များနေပါသည် — ခဏနေမှ ထပ်ကြိုးစားပါ" }, 429);

    if (method === "sms") {
      if (await rateTake(env, "otpSMS:day", 300, 86400)) return json({ ok: false, error: "ယနေ့ SMS ကန့်သတ်ချက် ပြည့်သွားပါပြီ — Telegram သုံးပါ" }, 429);
      const code = await storeOtp(env, phone, "sms");
      if (!(await sendSms(env, phone, code))) return json({ ok: false, error: "SMS ပို့၍ မရပါ — Telegram နဲ့ ဝင်ကြည့်ပါ" }, 502);
      return json({ ok: true, method: "sms", message: "SMS ပို့ပြီးပါပြီ" });
    }

    // Telegram
    const bot = await botUsername(env);
    if (!bot) return json({ ok: false, error: "Telegram bot မချိတ်ရသေးပါ — SMS သုံးပါ" }, 503);
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
    return json({ ok: true, token: await signToken(env, user.id), user });
  }

  if (path === "/api/auth/me" && request.method === "GET") {
    const user = await verifyUserToken(env, (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""));
    return user ? json({ ok: true, user }) : json({ ok: false }, 401);
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
      if (String(c.user_id) !== String(m.from && m.from.id) || normMm(c.phone_number) !== rec.phone) {
        await say("ဖုန်းနံပါတ် မကိုက်ပါ — ကိုယ်ပိုင် နံပါတ်ကိုသာ မျှဝေပါ", { reply_markup: { remove_keyboard: true } }); return json({ ok: true });
      }
      const code = await storeOtp(env, rec.phone, "telegram", { tg_chat: chat });
      await say(`🔐 Login OTP: ${code}\n(၅ မိနစ်အတွင်း ဝက်ဘ်ဆိုက်မှာ ထည့်ပါ)`, { reply_markup: { remove_keyboard: true } });
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
