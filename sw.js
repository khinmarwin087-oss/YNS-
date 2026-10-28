// မြင်သာ — ဝယ်သူ App (PWA) Service Worker
// - မီနူး/ဆိုင်အချက်အလက်: အင်တာနက်ရှိလျှင် အသစ်ယူ၊ မရှိ/နှေးလျှင် နောက်ဆုံးမှတ်ထားသည်ကို ပြ
// - ပုံများ / font: cache ထဲက ချက်ချင်းပြ
// - အော်ဒါတင်ခြင်း၊ admin၊ POST များကို လုံးဝ မထိ (အမြဲ live)
const V = "v1";
const SHELL = "mc-shell-" + V, RUNTIME = "mc-rt-" + V, IMG = "mc-img-" + V;   // "mc-" = customer ၊ admin sw ၏ "yns-cfg" ကို မထိစေရန်
const OFFLINE = "/offline.html";
const PRECACHE = [OFFLINE, "/icons/icon-192.png", "/icons/icon-512.png", "/icons/favicon-32.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("mc-") && ![SHELL, RUNTIME, IMG].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("message", (e) => { if (e.data === "SKIP_WAITING") self.skipWaiting(); });

const okRes = (r) => r && (r.ok || r.type === "opaque");

async function trim(name, max) {
  const c = await caches.open(name), keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}
async function navigate(req) {
  try {
    const res = await fetch(req);
    if (res.ok && !res.redirected) { const c = await caches.open(SHELL); c.put(req, res.clone()); }
    return res;
  } catch (_) {
    const c = await caches.open(SHELL);
    return (await c.match(req)) || (await c.match(req, { ignoreSearch: true })) || (await c.match(OFFLINE)) || Response.error();
  }
}
async function networkFirst(req, name, ms) {
  const c = await caches.open(name);
  const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; });
  try { return await Promise.race([net, new Promise((_, j) => setTimeout(() => j(0), ms))]); }
  catch (_) { const hit = await c.match(req); if (hit) { net.catch(() => {}); return hit; } return net; }
}
async function cacheFirst(req, name, max) {
  const c = await caches.open(name), hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (okRes(r)) { c.put(req, r.clone()); trim(name, max); }
  return r;
}
async function swr(req, name) {
  const c = await caches.open(name), hit = await c.match(req);
  const net = fetch(req).then((r) => { if (okRes(r)) c.put(req, r.clone()); return r; }).catch(() => hit);
  return hit || net;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url), p = url.pathname, same = url.origin === location.origin;
  if (same && p.startsWith("/admin")) return;                                              // admin ကို မထိ
  if (same && req.mode === "navigate") return e.respondWith(navigate(req));
  // API သည် တခြား origin (workers.dev) ဖြစ်နိုင်သဖြင့် origin မရွေး လမ်းကြောင်းဖြင့် ဖမ်းသည် — မီနူး/ဆိုင်အချက်အလက်သာ၊ အခြား API အားလုံး live
  if (/^\/api\/(products|shop-status|shops)$/.test(p)) return e.respondWith(networkFirst(req, RUNTIME, 4000));
  if (/^\/api\/img\/\d+$/.test(p)) return e.respondWith(cacheFirst(req, IMG, 150));
  if (same && (p === "/manifest.webmanifest" || /^\/icons\//.test(p))) return e.respondWith(swr(req, RUNTIME));
  if (!same && /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)$/.test(url.hostname)) return e.respondWith(swr(req, RUNTIME));
});
