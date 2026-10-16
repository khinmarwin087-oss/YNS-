// YNS Kitchen Admin — Service Worker
// Admin page ပိတ်ထားသော်လည်း ၊ ဖုန်း screen ပိတ်ထားသော်လည်း အော်ဒါအသစ် push ရောက်လျှင် notification ပြရန်
const CFG = "yns-cfg";

async function readCfg() {
  try { const c = await caches.open(CFG); const r = await c.match("cfg"); return r ? await r.json() : {}; } catch (_) { return {}; }
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});   // Chrome က install လုပ်ခွင့်ပြုရန် handler တစ်ခုလိုသည် (cache မလုပ်ပါ)

// စာမျက်နှာက API လိပ်စာ + admin key ကို ပို့ထားသည် (peek ခေါ်ရန်)
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "cfg") {
    e.waitUntil(caches.open(CFG).then((c) => c.put("cfg", new Response(JSON.stringify(e.data.cfg || {})))));
  }
});

self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    const cfg = await readCfg();
    let info = null;
    if (cfg.api && cfg.key) {
      try {
        const r = await fetch(cfg.api + "/api/admin/push/peek", { headers: { "X-Admin-Key": cfg.key } });
        if (r.ok) info = await r.json();
      } catch (_) {}
    }
    let title = "🔔 YNS Kitchen", body = "အော်ဒါအသစ် ရောက်ရှိလာပါသည်";
    if (info && info.test) { title = "✅ စမ်းသပ်မှု အောင်မြင်ပါသည်"; body = "ဖုန်းသို့ အသိပေးချက် ရောက်ပါပြီ — အော်ဒါဝင်လျှင် ဤအတိုင်း တုန်ပြီး ပြပါမည်"; }
    else if (info && info.overdue > 0) { title = "⚠️ မလက်ခံရသေးသော အော်ဒါ"; body = `အော်ဒါ ${info.overdue} ခု ၁၀ မိနစ်ကျော်ပြီ — ချက်ချင်း လက်ခံပါ`; }
    else if (info && info.new > 0) { title = "🔔 အော်ဒါအသစ် " + info.new + " ခု"; body = "နှိပ်ပြီး ကြည့်ပါ / လက်ခံပါ"; }
    else if (info && info.new === 0) { title = "YNS Kitchen"; body = "အော်ဒါအားလုံး လက်ခံပြီးပါပြီ ✅"; }
    await self.registration.showNotification(title, {
      body,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      tag: "yns-order",          // အဟောင်းကို အစားထိုး (စုပုံမနေစေရန်)
      renotify: true,            // အစားထိုးသော်လည်း ပြန်တုန်/ပြန်မြည်
      requireInteraction: true,  // နှိပ်မှ ပျောက်မည်
      vibrate: [300, 120, 300, 120, 500],
      data: { url: "orders.html#new" },
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "orders.html#new", self.registration.scope).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) { try { await c.focus(); if (c.navigate) await c.navigate(url); return; } catch (_) {} }
    }
    await self.clients.openWindow(url);
  })());
});
