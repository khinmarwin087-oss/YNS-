// IDPS — ဟက်ကာ တိုက်ခိုက်မှု ခြေရာခံ၊ မှတ်တမ်း၊ Telegram သတိပေး၊ IP အလိုအလျောက် ပိတ်
// URL (path + query) ထဲက "သေချာတဲ့" တိုက်ခိုက်ပုံစံများကိုသာ စစ်သည် — ဝယ်သူ ရိုက်သောစာ (body) ကို မစစ်၊ ပုံမှန်စကားလုံးများ (select/update/script.js) ကို မပိတ်
let ready = false;
const okCache = new Map();   // ip → အချိန် (သိမ်းထားသော "မပိတ်ထား" ရလဒ်၊ ၃၀ စက္ကန့်)
const SIGS = [
  ["SQLi", /union(\s|\/\*.*?\*\/|\+|%20)+(all(\s|\+|%20)+)?select/i],
  ["SQLi", /['"`](\s|\+|%20)*(or|and)(\s|\+|%20)+['"`]?\d*['"`]?\s*=\s*['"`]?\d/i],
  ["SQLi", /(;|\b)(drop|truncate|alter)(\s|\+|%20)+(table|database)\b/i],
  ["SQLi", /\b(sleep|benchmark|pg_sleep|load_file)\s*\(|information_schema|sqlite_master|xp_cmdshell/i],
  ["XSS", /<\s*script|<\s*\/\s*script|\bon(error|load|click|mouseover)\s*=|javascript\s*:|<\s*(img|svg|iframe)[^>]*\son\w+\s*=/i],
  ["Traversal", /(\.\.\/|\.\.\\|%2e%2e(%2f|\/|%5c)|%252e%252e)/i],
  ["Probe", /\/(\.env|\.git\/|\.svn|\.aws|wp-login\.php|wp-admin|xmlrpc\.php|phpmyadmin|pma\/|cgi-bin|vendor\/phpunit|etc\/passwd|boot\.ini|actuator|\.DS_Store)/i],
  ["Cmd", /(;|\||`|\$\()\s*(cat|wget|curl|bash|sh|nc|powershell)\b|\/bin\/(ba)?sh/i],
];
export async function ensureIdps(env) {
  if (ready) return;
  const raw = env.RAW || env.DB; if (!raw) return;
  await raw.prepare(`CREATE TABLE IF NOT EXISTS blocked_ips (ip TEXT PRIMARY KEY, reason TEXT, blocked_until INTEGER)`).run();
  await raw.prepare(`CREATE TABLE IF NOT EXISTS threat_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT, path TEXT, type TEXT, details TEXT, ua TEXT, created_at INTEGER)`).run();
  try { await raw.prepare(`CREATE INDEX IF NOT EXISTS idx_threat_ip ON threat_logs(ip, created_at)`).run(); } catch (_) {}
  ready = true;
}
const now = () => Math.floor(Date.now() / 1000);
const safeDecode = (s) => { let o = String(s || ""); for (let i = 0; i < 2; i++) { try { const d = decodeURIComponent(o); if (d === o) break; o = d; } catch (_) { break; } } return o; };
export function detect(url) {
  const hay = safeDecode(url.pathname) + " " + safeDecode(url.search) + " " + url.pathname;
  for (const [type, re] of SIGS) if (re.test(hay)) return type;
  return null;
}
const isRealIp = (ip) => ip && ip !== "local" && ip !== "unknown";

export async function blockIp(env, ip, reason, hours) {
  const raw = env.RAW || env.DB; await ensureIdps(env);
  await raw.prepare(`INSERT INTO blocked_ips (ip, reason, blocked_until) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, blocked_until = excluded.blocked_until`).bind(ip, String(reason).slice(0, 120), now() + Math.round(hours * 3600)).run();
  okCache.delete(ip);
}
export async function logThreat(env, ip, path, type, details, ua, notify) {
  const raw = env.RAW || env.DB; await ensureIdps(env);
  await raw.prepare(`INSERT INTO threat_logs (ip, path, type, details, ua, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(ip, String(path).slice(0, 160), type, String(details || "").slice(0, 300), String(ua || "").slice(0, 160), now()).run();
  const c = (await raw.prepare(`SELECT COUNT(*) c FROM threat_logs WHERE ip = ? AND created_at > ?`).bind(ip, now() - 600).first()).c;
  let blocked = false;
  if (c >= 5 && isRealIp(ip)) { await blockIp(env, ip, type + " ×" + c, 1); blocked = true; }
  if (notify && type === "AdminKey" && (c === 1 || blocked)) await notify(blocked ? `🚫 IP ${ip} ကို ၁ နာရီ ပိတ်လိုက်ပါပြီ\nအကြောင်းရင်း: ${type} (၁၀ မိနစ်အတွင်း ${c} ကြိမ်)` : `🚨 HACKER ALERT\nIP: ${ip}\nအမျိုးအစား: ${type}\nလမ်းကြောင်း: ${String(path).slice(0, 80)}`).catch(() => {});
  return { count: c, blocked };
}
// တောင်းဆိုမှုတိုင်းအတွက် — Response ပြန်လာလျှင် ဆက်မလုပ်ဘဲ ပြန်ပေး
export async function idpsGuard(request, env, notify) {
  try {
    const raw = env.RAW || env.DB; if (!raw) return null;
    const ip = request.headers.get("CF-Connecting-IP") || "local", url = new URL(request.url);
    if (isRealIp(ip)) {
      const t = okCache.get(ip);
      if (!(t && Date.now() - t < 30000)) {
        await ensureIdps(env);
        const b = await raw.prepare(`SELECT blocked_until FROM blocked_ips WHERE ip = ?`).bind(ip).first();
        if (b && b.blocked_until > now()) return new Response("🚫 သင့် IP ကို ယာယီ ပိတ်ဆို့ထားပါသည်။", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
        okCache.set(ip, Date.now()); if (okCache.size > 2000) okCache.clear();
      }
    }
    const type = detect(url);
    if (type) {
      await logThreat(env, ip, url.pathname, type, url.search, request.headers.get("User-Agent"), notify);
      return new Response("🛑 တရားမဝင် တောင်းဆိုမှု", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
  } catch (e) { console.log("idps:", e.message); }
  return null;
}
// Admin API — owner သာ
export async function handleThreats(request, env, path, json) {
  const raw = env.RAW || env.DB; await ensureIdps(env);
  if (path === "/api/admin/threats" && request.method === "GET") {
    const logs = ((await raw.prepare(`SELECT id, ip, path, type, details, created_at FROM threat_logs ORDER BY id DESC LIMIT 100`).all()).results || []);
    const blocked = ((await raw.prepare(`SELECT ip, reason, blocked_until FROM blocked_ips WHERE blocked_until > ? ORDER BY blocked_until DESC`).bind(now()).all()).results || []);
    const day = (await raw.prepare(`SELECT COUNT(*) c, COUNT(DISTINCT ip) i FROM threat_logs WHERE created_at > ?`).bind(now() - 86400).first()) || {};
    const types = ((await raw.prepare(`SELECT type k, COUNT(*) c FROM threat_logs WHERE created_at > ? GROUP BY type ORDER BY c DESC`).bind(now() - 7 * 86400).all()).results || []);
    return json({ ok: true, now: now(), logs, blocked, last24h: { attacks: day.c || 0, ips: day.i || 0 }, types });
  }
  let b = {}; try { b = await request.json(); } catch (_) {}
  const ip = String(b.ip || "").trim().slice(0, 64);
  if (!/^[0-9a-fA-F:.]{3,64}$/.test(ip)) return json({ ok: false, error: "IP မမှန်ပါ" }, 400);
  if (path === "/api/admin/threats/unblock" && request.method === "POST") {
    await raw.prepare(`DELETE FROM blocked_ips WHERE ip = ?`).bind(ip).run(); okCache.set(ip, Date.now());
    return json({ ok: true });
  }
  if (path === "/api/admin/threats/block" && request.method === "POST") {
    const h = Math.min(24 * 30, Math.max(1, Number(b.hours) || 24));
    await blockIp(env, ip, "Admin က ပိတ်ထားသည်", h); return json({ ok: true });
  }
  return null;
}

// နေ့စဉ် အကျဉ်းချုပ် (Telegram တစ်စောင်တည်း) — scanner များအတွက် ချက်ချင်း မသတိပေး
export async function securityDigest(env) {
  const raw = env.RAW || env.DB; await ensureIdps(env);
  const since = now() - 86400;
  const a = (await raw.prepare(`SELECT COUNT(*) c, COUNT(DISTINCT ip) i FROM threat_logs WHERE created_at > ?`).bind(since).first()) || { c: 0, i: 0 };
  if (!a.c) return "";
  const b = (await raw.prepare(`SELECT COUNT(*) c FROM blocked_ips WHERE blocked_until > ?`).bind(now()).first()) || { c: 0 };
  const k = ((await raw.prepare(`SELECT type, COUNT(*) c FROM threat_logs WHERE created_at > ? GROUP BY type ORDER BY c DESC`).bind(since).all()).results || []).map((x) => `${x.type} ${x.c}`).join(", ");
  return `🛡 လုံခြုံရေး (၂၄ နာရီ)\nbot/hacker ကြိုးစားမှု ${a.c} ကြိမ် (IP ${a.i} ခု) — အားလုံး ပိတ်ထားပြီး\n${k}\nယခု ပိတ်ထားသော IP: ${b.c}\nဘာမှ လုပ်စရာမလို၊ Admin → Security မှာ ကြည့်နိုင်`;
}
