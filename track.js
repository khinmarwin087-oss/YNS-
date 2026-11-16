// ဝယ်သူ လှုပ်ရှားမှု Tracking & Analytics — ခွင့်ပြုချက်ပေးသူများသာ၊ IP မသိမ်း၊ စကားဝှက်/ကတ်/ပုံစံထည့်စာ မသိမ်း
import { verifyUserToken, uaInfo, sourceOf } from "./auth.js";
const RETAIN_DAYS = 90;
let ready = false;
const now = () => Math.floor(Date.now() / 1000);
export async function ensureTrackSchema(env) {
  if (ready) return; const raw = env.RAW || env.DB; if (!raw) return;
  await raw.prepare(`CREATE TABLE IF NOT EXISTS track_sessions (shop_id INTEGER, sid TEXT, user_id INTEGER, first_at INTEGER, last_at INTEGER, device TEXT, browser TEXT, os TEXT, city TEXT, source TEXT, entry TEXT, exit_page TEXT, exit_label TEXT, events INTEGER DEFAULT 0, cart_items INTEGER DEFAULT 0, cart_value INTEGER DEFAULT 0, checkout_step TEXT DEFAULT '', ordered INTEGER DEFAULT 0, PRIMARY KEY (shop_id, sid))`).run();
  await raw.prepare(`CREATE TABLE IF NOT EXISTS track_events (id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER, sid TEXT, user_id INTEGER, type TEXT, page TEXT, label TEXT, dur INTEGER DEFAULT 0, scroll INTEGER DEFAULT 0, ts INTEGER)`).run();
  for (const q of [`CREATE INDEX IF NOT EXISTS idx_te_sid ON track_events(shop_id, sid, ts)`, `CREATE INDEX IF NOT EXISTS idx_te_ts ON track_events(shop_id, ts)`, `CREATE INDEX IF NOT EXISTS idx_ts_last ON track_sessions(shop_id, last_at)`, `CREATE INDEX IF NOT EXISTS idx_ts_user ON track_sessions(shop_id, user_id)`]) { try { await raw.prepare(q).run(); } catch (_) {} }
  ready = true;
}
const clip = (s, n) => String(s ?? "").replace(/[<>]/g, "").replace(/\d{7,}/g, "#").trim().slice(0, n);   // ဖုန်း/ကတ် ဂဏန်းရှည်များ ဖုံး
const TYPES = new Set(["view", "item", "cart", "search", "checkout", "order", "page"]);
export async function handleTrack(request, env, shopId, h) {
  if (request.method !== "POST") return h.json({ ok: false }, 405);
  let b; try { b = await request.json(); } catch { return h.json({ ok: true }); }
  const sid = String(b.sid || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
  if (sid.length < 12 || !Array.isArray(b.events) || !b.events.length) return h.json({ ok: true });
  if (await h.rateTake(env, "trk:" + sid, 150, 60)) return h.json({ ok: true });
  if (await h.rateTake(env, "trkip:" + h.clientIp(request), 600, 60)) return h.json({ ok: true });
  await ensureTrackSchema(env); const raw = env.RAW || env.DB;
  const u = await verifyUserToken(env, String(request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")).catch(() => null);
  const uid = u ? u.id : null, ua = request.headers.get("User-Agent") || "", info = uaInfo(ua), t0 = now();
  const city = String((request.cf && request.cf.city) || "").replace(/[<>]/g, "").slice(0, 40);
  const src = sourceOf(String(b.ref || "").slice(0, 300), String(b.src || "").slice(0, 40), new URL(request.url).hostname.toLowerCase());
  const evs = b.events.slice(0, 30).map((e) => ({ t: TYPES.has(e.t) ? e.t : "view", p: clip(e.p, 60) || "home", l: clip(e.l, 80), d: Math.max(0, Math.min(86400, parseInt(e.d, 10) || 0)), s: Math.max(0, Math.min(100, parseInt(e.s, 10) || 0)), n: Math.max(0, Math.min(500, parseInt(e.n, 10) || 0)), v: Math.max(0, Math.min(1e9, parseInt(e.v, 10) || 0)) }));
  const last = evs[evs.length - 1];
  await raw.prepare(`INSERT INTO track_sessions (shop_id, sid, user_id, first_at, last_at, device, browser, os, city, source, entry, exit_page, exit_label, events) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)
    ON CONFLICT(shop_id, sid) DO UPDATE SET last_at = excluded.last_at, user_id = COALESCE(excluded.user_id, track_sessions.user_id), exit_page = excluded.exit_page, exit_label = excluded.exit_label`)
    .bind(shopId, sid, uid, t0, t0, info.dtype, info.browser, info.os, city, src, evs[0].p, last.p, last.l).run();
  const stmts = evs.map((e, i) => raw.prepare(`INSERT INTO track_events (shop_id, sid, user_id, type, page, label, dur, scroll, ts) VALUES (?,?,?,?,?,?,?,?,?)`).bind(shopId, sid, uid, e.t, e.p, e.l, e.d, e.s, t0 + i));
  let sets = "events = events + ?", args = [evs.length];
  for (const e of evs) {
    if (e.t === "cart") { sets += ", cart_items = ?, cart_value = ?"; args.push(e.n, e.v); }
    if (e.t === "checkout") { sets += ", checkout_step = ?"; args.push(e.l.slice(0, 20)); }
    if (e.t === "order") { sets += ", ordered = 1, cart_items = 0, cart_value = 0, checkout_step = ''"; }
  }
  stmts.push(raw.prepare(`UPDATE track_sessions SET ${sets} WHERE shop_id = ? AND sid = ?`).bind(...args, shopId, sid));
  if (uid) stmts.push(raw.prepare(`UPDATE track_events SET user_id = ? WHERE shop_id = ? AND sid = ? AND user_id IS NULL`).bind(uid, shopId, sid));   // Guest → Login ချိတ်
  await raw.batch(stmts);
  return h.json({ ok: true });
}
export async function trackCleanup(env) {
  const raw = env.RAW || env.DB; await ensureTrackSchema(env); const cut = now() - RETAIN_DAYS * 86400;
  await raw.prepare(`DELETE FROM track_events WHERE ts < ?`).bind(cut).run(); await raw.prepare(`DELETE FROM track_sessions WHERE last_at < ?`).bind(cut).run();
}
// ---- Admin ----
const csvCell = (v) => { v = String(v ?? ""); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
const localPhones = (p) => { p = String(p || ""); if (/^g/.test(p) || !p) return []; return ["0" + p.slice(2), p, "+" + p]; };
async function userInfo(env, raw, ids) {
  const out = {}; if (!ids.length) return out;
  const us = (await raw.prepare(`SELECT id, phone, name, email FROM users WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results || [];
  for (const u of us) {
    const ph = localPhones(u.phone); let o = { n: 0, sum: 0, last: null };
    if (ph.length) { const r = await env.DB.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) sum, MAX(created_at) last FROM orders WHERE phone IN (${ph.map(() => "?").join(",")}) AND status != 'Cancelled'`).bind(...ph).first().catch(() => null); if (r) o = r; }
    out[u.id] = { id: u.id, name: u.name || "", phone: /^g/.test(String(u.phone)) ? "" : u.phone, email: u.email || "", orders: o.n || 0, ltv: o.sum || 0, last: o.last || null, segment: o.n > 0 ? "Returning" : "New" };
  }
  return out;
}
export async function handleTrackAdmin(request, env, path, shopId, h) {
  await ensureTrackSchema(env); const raw = env.RAW || env.DB, url = new URL(request.url), q = url.searchParams;
  const days = Math.min(90, Math.max(1, parseInt(q.get("days"), 10) || 7)), since = now() - days * 86400;
  if (path === "/api/admin/analytics/live") {
    const rows = (await raw.prepare(`SELECT sid, user_id, device, city, exit_page p, exit_label l, last_at, cart_items FROM track_sessions WHERE shop_id = ? AND last_at > ? ORDER BY last_at DESC LIMIT 50`).bind(shopId, now() - 300).all()).results || [];
    const ui = await userInfo(env, raw, [...new Set(rows.map((r) => r.user_id).filter(Boolean))]);
    return h.json({ ok: true, now: now(), live: rows.map((r) => ({ sid: r.sid, user: r.user_id ? (ui[r.user_id]?.name || ui[r.user_id]?.email || "Member") : "", device: r.device, city: r.city, page: r.p, label: r.l, ago: now() - r.last_at, cart: r.cart_items })) });
  }
  if (path === "/api/admin/analytics/sessions") {
    const f = q.get("filter") || "all", dev = ["Mobile", "Desktop", "Tablet"].includes(q.get("device")) ? q.get("device") : "";
    let where = `shop_id = ? AND last_at > ?`; const a = [shopId, since];
    if (f === "user") where += " AND user_id IS NOT NULL"; else if (f === "guest") where += " AND user_id IS NULL";
    else if (f === "abandoned") where += " AND cart_items > 0 AND ordered = 0 AND last_at < ?", a.push(now() - 1800);
    if (dev) { where += " AND device = ?"; a.push(dev); }
    const rows = (await raw.prepare(`SELECT * FROM track_sessions WHERE ${where} ORDER BY last_at DESC LIMIT 150`).bind(...a).all()).results || [];
    const ui = await userInfo(env, raw, [...new Set(rows.map((r) => r.user_id).filter(Boolean))]);
    return h.json({ ok: true, sessions: rows.map((r) => ({ sid: r.sid, at: r.last_at, first: r.first_at, device: r.device, browser: r.browser, os: r.os, city: r.city, source: r.source, entry: r.entry, exit: r.exit_page, exitLabel: r.exit_label, events: r.events, cart: r.cart_items, cartValue: r.cart_value, step: r.checkout_step, ordered: !!r.ordered, user: r.user_id ? ui[r.user_id] || { id: r.user_id } : null, segment: r.user_id ? (ui[r.user_id]?.segment || "New") : "Guest" })) });
  }
  if (path === "/api/admin/analytics/session") {
    const sid = String(q.get("sid") || "").replace(/[^a-zA-Z0-9]/g, "");
    const s = await raw.prepare(`SELECT * FROM track_sessions WHERE shop_id = ? AND sid = ?`).bind(shopId, sid).first();
    if (!s) return h.json({ ok: false }, 404);
    const ev = (await raw.prepare(`SELECT type, page, label, dur, scroll, ts FROM track_events WHERE shop_id = ? AND sid = ? ORDER BY ts, id LIMIT 300`).bind(shopId, sid).all()).results || [];
    const ui = s.user_id ? (await userInfo(env, raw, [s.user_id]))[s.user_id] : null;
    return h.json({ ok: true, session: { device: s.device, browser: s.browser, os: s.os, city: s.city, source: s.source, step: s.checkout_step, cart: s.cart_items, cartValue: s.cart_value, ordered: !!s.ordered, exit: s.exit_page }, user: ui, events: ev });
  }
  if (path === "/api/admin/analytics/funnel") {
    const cnt = async (a, z) => {
      const c = async (where) => (await raw.prepare(`SELECT COUNT(DISTINCT sid) c FROM track_events WHERE shop_id = ? AND ts > ? AND ts <= ? AND ${where}`).bind(shopId, a, z).first()).c || 0;
      const v = (await raw.prepare(`SELECT COUNT(*) c FROM track_sessions WHERE shop_id = ? AND last_at > ? AND last_at <= ?`).bind(shopId, a, z).first()).c || 0;
      return { visits: v, item: await c(`(type = 'item' OR page = 'item')`), cart: await c(`type = 'cart'`), checkout: await c(`type = 'checkout'`), order: await c(`type = 'order'`) };
    };
    const all = (await raw.prepare(`SELECT COUNT(*) c, SUM(CASE WHEN user_id IS NOT NULL THEN 1 ELSE 0 END) u, SUM(CASE WHEN cart_items > 0 AND ordered = 0 AND last_at < ? THEN 1 ELSE 0 END) ab FROM track_sessions WHERE shop_id = ? AND last_at > ?`).bind(now() - 1800, shopId, since).first()) || {};
    const steps = ((await raw.prepare(`SELECT checkout_step k, COUNT(*) c FROM track_sessions WHERE shop_id = ? AND last_at > ? AND ordered = 0 AND checkout_step != '' GROUP BY checkout_step ORDER BY c DESC`).bind(shopId, since).all()).results || []);
    const exits = ((await raw.prepare(`SELECT exit_page k, COUNT(*) c FROM track_sessions WHERE shop_id = ? AND last_at > ? GROUP BY exit_page ORDER BY c DESC LIMIT 8`).bind(shopId, since).all()).results || []);
    const pages = ((await raw.prepare(`SELECT page k, COUNT(*) c, CAST(AVG(NULLIF(dur,0)) AS INTEGER) d, CAST(AVG(NULLIF(scroll,0)) AS INTEGER) s FROM track_events WHERE shop_id = ? AND ts > ? AND type = 'page' GROUP BY page ORDER BY c DESC LIMIT 8`).bind(shopId, since).all()).results || []);
    const topPages = ((await raw.prepare(`SELECT page k, COUNT(*) c FROM track_events WHERE shop_id = ? AND ts > ? AND type IN ('view','item') GROUP BY page ORDER BY c DESC LIMIT 6`).bind(shopId, since).all()).results || []);
    const devices = ((await raw.prepare(`SELECT COALESCE(device,'Other') k, COUNT(*) c FROM track_sessions WHERE shop_id = ? AND last_at > ? GROUP BY k ORDER BY c DESC`).bind(shopId, since).all()).results || []);
    const searches = ((await raw.prepare(`SELECT label k, COUNT(*) c FROM track_events WHERE shop_id = ? AND ts > ? AND type = 'search' AND label != '' GROUP BY label ORDER BY c DESC LIMIT 8`).bind(shopId, since).all()).results || []);
    const dq = `date(ts,'unixepoch','+390 minutes')`;
    const dl = ((await raw.prepare(`SELECT ${dq} d, type t, COUNT(DISTINCT sid) c FROM track_events WHERE shop_id = ? AND ts > ? AND type IN ('item','cart','order') GROUP BY d, t`).bind(shopId, since).all()).results || []);
    const dv = ((await raw.prepare(`SELECT date(last_at,'unixepoch','+390 minutes') d, COUNT(*) c FROM track_sessions WHERE shop_id = ? AND last_at > ? GROUP BY d`).bind(shopId, since).all()).results || []);
    const daily = {}; for (const r of dv) (daily[r.d] = daily[r.d] || {}).visits = r.c; for (const r of dl) (daily[r.d] = daily[r.d] || {})[r.t] = r.c;
    return h.json({ ok: true, days, funnel: await cnt(since, now() + 60), prev: await cnt(since - days * 86400, since), users: all.u || 0, abandoned: all.ab || 0, steps, exits, pages, topPages, devices, searches, daily });
  }
  if (path === "/api/admin/analytics/export") {
    const kind = q.get("kind") === "sessions" ? "sessions" : "events", rows = [];
    if (kind === "events") { rows.push(["time (MMT)", "session", "user_id", "type", "page", "label", "seconds", "scroll%"]); for (const e of (await raw.prepare(`SELECT * FROM track_events WHERE shop_id = ? AND ts > ? ORDER BY ts LIMIT 20000`).bind(shopId, since).all()).results || []) rows.push([new Date(e.ts * 1000 + 23400000).toISOString().replace("T", " ").slice(0, 19), e.sid, e.user_id || "", e.type, e.page, e.label, e.dur, e.scroll]); }
    else { const ss = (await raw.prepare(`SELECT * FROM track_sessions WHERE shop_id = ? AND last_at > ? ORDER BY last_at LIMIT 20000`).bind(shopId, since).all()).results || []; const ui = await userInfo(env, raw, [...new Set(ss.map((r) => r.user_id).filter(Boolean))]); rows.push(["last seen (MMT)", "session", "segment", "name", "phone", "orders", "LTV", "device", "browser", "os", "city", "source", "entry", "exit", "events", "cart items", "cart value", "checkout step", "ordered"]); for (const s of ss) { const u = ui[s.user_id] || {}; rows.push([new Date(s.last_at * 1000 + 23400000).toISOString().replace("T", " ").slice(0, 19), s.sid, s.user_id ? u.segment || "New" : "Guest", u.name || "", u.phone || "", u.orders || 0, u.ltv || 0, s.device, s.browser, s.os, s.city, s.source, s.entry, s.exit_page, s.events, s.cart_items, s.cart_value, s.checkout_step, s.ordered ? "yes" : "no"]); } }
    return new Response("﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${kind}-${days}d.csv"`, "Cache-Control": "no-store" } });
  }
  return null;
}
