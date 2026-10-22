// admin/js/main.js

const API_BASE = "https://yns.khinmarwin087.workers.dev";
const ADMIN_KEY_STORAGE = "yns_admin_key";
const ME_STORAGE = "yns_me";            // { role: 'owner'|'vendor', shop: {id,slug,name} }
const VIEW_SHOP_STORAGE = "yns_view_shop"; // Owner က တခြားဆိုင်ကို ဝင်ကြည့်နေလျှင် ထိုဆိုင် id

function getMe() { try { return JSON.parse(localStorage.getItem(ME_STORAGE) || "null") || {}; } catch (_) { return {}; } }
function curShopName() {   // ယခု စီမံနေသော ဆိုင်အမည် (ဘောက်ချာ ပရင့်တွင်သုံး)
  try {
    if (getViewShop()) return localStorage.getItem(VIEW_SHOP_STORAGE + "_name") || "";
    const me = getMe(); return (me.shop && me.shop.name) || "";
  } catch (_) { return ""; }
}
function getViewShop() { try { return localStorage.getItem(VIEW_SHOP_STORAGE) || ""; } catch (_) { return ""; } }
function setViewShop(id, name) {
  try {
    if (id && String(id) !== "1") { localStorage.setItem(VIEW_SHOP_STORAGE, String(id)); localStorage.setItem(VIEW_SHOP_STORAGE + "_name", name || ""); }
    else { localStorage.removeItem(VIEW_SHOP_STORAGE); localStorage.removeItem(VIEW_SHOP_STORAGE + "_name"); }
  } catch (_) {}
}

// 1. Get Stored Admin Key
function getAdminKey() {
  return localStorage.getItem(ADMIN_KEY_STORAGE) || "";
}

// 2. Admin Key ထည့်သွင်းရန် Login box (Key မရှိ/မှားလျှင် အလိုအလျောက် ပေါ်လာမည်)
let _keyPromise = null;

function askAdminKey(message) {
  if (_keyPromise) return _keyPromise;

  _keyPromise = new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,.72);backdrop-filter:blur(4px);z-index:3000;display:flex;align-items:center;justify-content:center;padding:20px;";
    wrap.innerHTML = `
      <form id="keyForm" style="background:#fff;border-radius:20px;padding:24px 20px;width:100%;max-width:360px;box-shadow:0 20px 50px rgba(0,0,0,.3);">
        <div style="font-size:34px;text-align:center;">🔐</div>
        <h3 style="margin:8px 0 4px;text-align:center;font-size:18px;color:#0f172a;">Key ထည့်ပါ</h3>
        <p id="keyMsg" style="margin:0 0 14px;text-align:center;font-size:12px;color:#64748b;line-height:1.5;">${message || "ဤ browser တွင် တစ်ကြိမ်သာ ထည့်ရပါမည်။"}</p>
        <input id="keyInput" type="password" autocomplete="current-password" placeholder="Admin Key / ဆိုင်ပိုင်ရှင် Key"
          style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:12px;font-size:15px;outline:none;margin-bottom:12px;">
        <button id="keyBtn" type="submit"
          style="width:100%;padding:13px;border-radius:12px;background:#0f172a;color:#fff;font-weight:800;font-size:15px;">ဝင်မည်</button>
      </form>`;
    document.body.appendChild(wrap);

    const input = wrap.querySelector("#keyInput");
    const msg = wrap.querySelector("#keyMsg");
    const btn = wrap.querySelector("#keyBtn");
    setTimeout(() => input.focus(), 50);

    wrap.querySelector("#keyForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const key = input.value.trim();
      if (!key) return;
      btn.disabled = true;
      btn.textContent = "စစ်ဆေးနေသည်...";
      try {
        const r = await fetch(API_BASE + "/api/admin/ping", { headers: { "X-Admin-Key": key } });
        if (r.ok) {
          localStorage.setItem(ADMIN_KEY_STORAGE, key);
          try { const d = await r.json(); localStorage.setItem(ME_STORAGE, JSON.stringify({ role: d.role || "owner", shop: d.shop || null })); } catch (_) {}
          setViewShop("");
          wrap.remove();
          _keyPromise = null;
          resolve(key);
          return;
        }
        msg.style.color = "#dc2626";
        msg.textContent = r.status === 401
          ? "Key မှားနေပါသည်။ ပိုင်ရှင်ပေးထားသော Key နှင့် အတိအကျ တူရပါမည်။"
          : "Server error (" + r.status + ")";
      } catch (err) {
        msg.style.color = "#dc2626";
        msg.textContent = "Server သို့ ချိတ်ဆက်၍ မရပါ။ အင်တာနက် စစ်ပါ။";
      }
      btn.disabled = false;
      btn.textContent = "ဝင်မည်";
      input.select();
    });
  });

  return _keyPromise;
}

// Key ပြောင်းလိုလျှင်
async function changeAdminKey() {
  localStorage.removeItem(ADMIN_KEY_STORAGE);
  await askAdminKey("Key အသစ် ထည့်ပါ။");
  location.reload();
}

// 2.1 Fetch API with Key Verification
async function apiFetch(path, opts = {}, _retried = false) {
  let key = getAdminKey();
  if (!key) key = await askAdminKey();

  let res;
  try {
    res = await fetch(API_BASE + path, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key": key,
        ...(getViewShop() ? { "X-Shop": getViewShop() } : {}),
        ...(opts.headers || {})
      }
    });
  } catch (err) {
    console.error("API Fetch Error:", err);
    showToast("Server သို့ ချိတ်ဆက်၍ မရပါ");
    throw err;
  }

  if (res.status === 401) {
    localStorage.removeItem(ADMIN_KEY_STORAGE);
    if (_retried) throw new Error("Unauthorized");
    await askAdminKey("Key မှားနေပါသည်၊ ပြန်ထည့်ပါ။");
    return apiFetch(path, opts, true);
  }

  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok || (data && data.ok === false)) {
    const msg = (data && data.error) || ("Server error " + res.status);
    showToast(msg);
    throw new Error(msg);
  }
  return data;
}

// 3. Authentication & Logout
function lockOut(message) {
  localStorage.removeItem(ADMIN_KEY_STORAGE);
  localStorage.removeItem(ME_STORAGE);
  setViewShop("");
  showToast(message || "Session သက်တမ်းကုန်သွားပါပြီ");
  setTimeout(() => location.reload(), 600);
}

function logout() {
  lockOut("Logout ပြုလုပ်ပြီးပါပြီ");
}

// 4. Utility Helper Functions
function money(n) {
  return (Number(n) || 0).toLocaleString() + " Ks";
}

function statusClass(s) {
  return s === "Completed" ? "done" : s === "Processing" ? "confirmed" : s === "Cancelled" ? "cancelled" : "pending";
}

function fmtDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso.replace(" ", "T") + "Z");
  if (isNaN(d)) return iso;
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// 5. Toast Notification System
function showToast(msg, ms) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), ms || (String(msg).length > 40 ? 4800 : 2600));
}

// 6. Mobile Sidebar Toggle Function
function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  let overlay = document.getElementById("sidebarOverlay");
  
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "sidebarOverlay";
    overlay.className = "overlay";
    overlay.onclick = toggleSidebar;
    document.body.appendChild(overlay);
  }

  if (sidebar) sidebar.classList.toggle("open");
  overlay.classList.toggle("show");
}

// 7. Render Admin Dynamic Navigation Links
function renderAdminLayout(activePage) {
  const navContainer = document.getElementById("sidebarNav");
  if (!navContainer) return;

  const pages = [
    { id: "dashboard", href: "index.html", icon: "fa-chart-pie", label: "Dashboard" },
    { id: "pos", href: "pos.html", icon: "fa-cash-register", label: "POS (ဆိုင်ရောင်း)" },
    { id: "orders", href: "orders.html", icon: "fa-receipt", label: "Orders" },
    { id: "products", href: "products.html", icon: "fa-box", label: "Products" },
    { id: "inventory", href: "inventory.html", icon: "fa-warehouse", label: "Inventory" },
    { id: "customers", href: "customers.html", icon: "fa-users", label: "Customers" },
    { id: "revenue", href: "revenue.html", icon: "fa-chart-line", label: "Revenue" },
    { id: "analytics", href: "analytics.html", icon: "fa-chart-column", label: "Analytics" },
    { id: "notifications", href: "notifications.html", icon: "fa-bell", label: "Notifications" },
    { id: "settings", href: "settings.html", icon: "fa-gear", label: "Settings" }
  ];
  const me = getMe();
  if (me.role === "owner") pages.splice(pages.length - 1, 0, { id: "shops", href: "shops.html", icon: "fa-store", label: "ဆိုင်များ (Marketplace)" });
  // ဆိုင်အမည်ကို ဘေးဘားတွင် ပြ၊ Owner က တခြားဆိုင်ကြည့်နေလျှင် သတိပေး
  const brandB = document.querySelector(".sidebar .brand b");
  const viewing = getViewShop();
  if (brandB) {
    const nm = viewing ? (localStorage.getItem(VIEW_SHOP_STORAGE + "_name") || "ဆိုင် #" + viewing) : (me.shop && me.shop.name) || "";
    if (nm) brandB.textContent = nm;
  }
  const title = document.getElementById("sidebarNav");
  if (title && !document.getElementById("viewBanner") && viewing) {
    const bn = document.createElement("div");
    bn.id = "viewBanner";
    bn.style.cssText = "margin:0 12px 10px;padding:9px 11px;border-radius:12px;background:#FFF3DF;color:#8A4B00;font-size:12px;font-weight:700;line-height:1.5;";
    bn.innerHTML = '👁 ဝင်ကြည့်နေသည်<br><button type="button" style="margin-top:4px;border:0;background:#8A4B00;color:#fff;border-radius:8px;padding:4px 10px;font-weight:800;font-size:11px;" onclick="setViewShop(\'\');location.href=\'shops.html\'">ကိုယ့်ဆိုင်သို့ ပြန်မည်</button>';
    title.parentNode.insertBefore(bn, title);
  }
  if (!window.__meRefreshed && getAdminKey()) {   // Role/ဆိုင်အမည် အသစ်ယူ (နောက်ကွယ်မှ)
    window.__meRefreshed = true;
    fetch(API_BASE + "/api/admin/ping", { headers: { "X-Admin-Key": getAdminKey() } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const old = JSON.stringify(getMe());
        const nw = JSON.stringify({ role: d.role || "owner", shop: d.shop || null });
        if (old !== nw) { localStorage.setItem(ME_STORAGE, nw); renderAdminLayout(activePage); }
      }).catch(() => {});
  }

  navContainer.innerHTML = pages.map(p => `
    <button onclick="window.location.href='${p.href}'" class="${activePage === p.id ? 'active' : ''}">
      <i class="fa-solid ${p.icon}"></i> ${p.label}
    </button>
  `).join('') + `
    <button onclick="logout()" style="margin-top: auto; color: #ef4444;">
      <i class="fa-solid fa-right-from-bracket"></i> Logout
    </button>
  `;
}

// 8. အော်ဒါအသစ် သတိပေးချက် (အသံ / တုန်ခါမှု / tab title badge / Telegram စမ်းသပ်)
//    ရွေးချယ်မှုများကို Settings စာမျက်နှာမှ ပြောင်းနိုင်သည် (ဤစက်၏ browser တွင်သာ သိမ်း)
const PREF = {
  get(k, d) { try { const v = localStorage.getItem("yns_" + k); return v === null ? d : v; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem("yns_" + k, String(v)); return true; } catch (_) { return false; } },
  del(k) { try { localStorage.removeItem("yns_" + k); } catch (_) {} },
};
const TONES = {
  bell:  { name: "ခေါင်းလောင်း", desc: "အသံပြတ်သား၊ ကြားလွယ်", notes: [[880, 0, .2], [880, .24, .2], [1175, .48, .3]], type: "sine", gain: .45 },
  chime: { name: "တေးသံလေး", desc: "ညင်သာပြီး သာယာ", notes: [[523, 0, .22], [659, .18, .22], [784, .36, .22], [1047, .54, .4]], type: "triangle", gain: .5 },
  ding:  { name: "ဆိုင် ding", desc: "ဆိုင်ကောင်တာ ခေါင်းလောင်းလို", notes: [[1318, 0, .7], [1318, .8, .7]], type: "sine", gain: .5 },
  alarm: { name: "နှိုးစက်", desc: "ကျယ်လောင်၊ ဆူညံသောနေရာအတွက်", notes: [[960, 0, .14], [720, .16, .14], [960, .32, .14], [720, .48, .14], [960, .64, .14], [720, .8, .14]], type: "square", gain: .28 },
  siren: { name: "ဆိုင်ရင်း (siren)", desc: "အသံမြင့်ကြီး တက်ကျ", notes: [[600, 0, .5, 1200], [600, .55, .5, 1200], [600, 1.1, .5, 1200]], type: "sawtooth", gain: .22 },
  soft:  { name: "တိုးညင်းသံ", desc: "အသံမလွန်ကဲ", notes: [[440, 0, .5], [554, .35, .6]], type: "sine", gain: .4 },
};
let _audioCtx = null, _lastBeep = 0, _customAudio = null;

function soundOn() { return PREF.get("sound", "1") !== "0"; }
function setSound(on) { PREF.set("sound", on ? "1" : "0"); }
function soundVol() { const v = parseFloat(PREF.get("vol", "0.8")); return Number.isFinite(v) ? Math.min(1, Math.max(0.05, v)) : 0.8; }
function soundTone() { const t = PREF.get("tone", "bell"); return t === "custom" ? (PREF.get("custom_sound", "") ? "custom" : "bell") : (TONES[t] ? t : "bell"); }

// Browser များက အသံကို user တစ်ချက်နှိပ်ပြီးမှသာ ခွင့်ပြုသည်
function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!_audioCtx) _audioCtx = new AC();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
  } catch (_) {}
}
["pointerdown", "keydown", "touchstart"].forEach(ev => document.addEventListener(ev, unlockAudio, { passive: true }));

function playTone(name, vol) {
  vol = vol == null ? soundVol() : vol;
  try {
    if (name === "custom") {
      const src = PREF.get("custom_sound", "");
      if (!src) return playTone("bell", vol);
      if (!_customAudio || _customAudio._src !== src) { _customAudio = new Audio(src); _customAudio._src = src; }
      _customAudio.volume = vol; _customAudio.currentTime = 0;
      const p = _customAudio.play(); if (p && p.catch) p.catch(() => {});
      return;
    }
    unlockAudio();
    const c = _audioCtx, T = TONES[name] || TONES.bell;
    if (!c || c.state !== "running") return;
    T.notes.forEach(([f, t, d, f2]) => {
      const o = c.createOscillator(), g = c.createGain(), at = c.currentTime + t;
      o.type = T.type; o.frequency.setValueAtTime(f, at);
      if (f2) o.frequency.linearRampToValueAtTime(f2, at + d);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, T.gain * vol), at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + d + 0.05);
      o.connect(g); g.connect(c.destination); o.start(at); o.stop(at + d + 0.08);
    });
  } catch (_) {}
}
function vibrate(pattern) { try { if (PREF.get("vib", "1") !== "0" && navigator.vibrate) navigator.vibrate(pattern || [300, 120, 300, 120, 500]); } catch (_) {} }

// အော်ဒါအသစ်ဝင်လာသောအခါ ခေါ်သည် (ရွေးထားသော အသံ + တုန်ခါမှု)
function playBeep() {
  _lastBeep = Date.now();
  vibrate();
  if (!soundOn()) return;
  playTone(soundTone());
}
function previewTone(name) { playTone(name); }

// လက်ခံသည်အထိ ထပ်ခါထပ်ခါ မြည် (Admin page ဖွင့်ထားချိန်)
function nagCheck(n) {
  if (!(n > 0) || PREF.get("nag", "1") === "0" || !soundOn()) return;
  const gap = Math.max(15, parseInt(PREF.get("nag_sec", "60"), 10) || 60) * 1000;
  if (Date.now() - _lastBeep >= gap) { playBeep(); }
}

// Tab title တွင် စောင့်နေသော အော်ဒါအရေအတွက် (2) Orders ပုံစံ
function setTitleBadge(n, base) {
  document.title = (n > 0 ? "(" + n + ") " : "") + base;
  nagCheck(n);
}

// Telegram သို့ စမ်းသပ်မက်ဆေ့ချ် ပို့ကြည့်ရန် (မအောင်မြင်လျှင် apiFetch က အကြောင်းရင်းကို toast ပြမည်)
async function testTelegram() {
  try {
    await apiFetch("/api/admin/test-telegram", { method: "POST" });
    showToast("Telegram သို့ စမ်းသပ်မက်ဆေ့ချ် ပို့ပြီးပါပြီ ✅ Telegram ကို ကြည့်ပါ", 5000);
  } catch (_) { /* error ကို apiFetch က toast ပြပြီးသား */ }
}

// 9. ဖန်သားပြင် မပိတ်စေရန် (Wake Lock) — ဆိုင်မှာ tablet/ဖုန်းကို ထောင်ထားချိန် အသံမပျက်စေရန်
let _wake = null;
async function applyWakeLock() {
  try {
    if (PREF.get("wake", "0") !== "1") { if (_wake) { await _wake.release(); _wake = null; } return; }
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible" || _wake) return;
    _wake = await navigator.wakeLock.request("screen");
    _wake.addEventListener("release", () => { _wake = null; });
  } catch (_) {}
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") applyWakeLock(); });

// 10. PWA (Home screen သို့ ထည့်နိုင်ရန်) + Service Worker သို့ key/API လိပ်စာ ပို့ပေးခြင်း
(function initPwa() {
  try {
    const h = document.head;
    if (!document.querySelector('link[rel="manifest"]')) { const l = document.createElement("link"); l.rel = "manifest"; l.href = "manifest.json"; h.appendChild(l); }
    if (!document.querySelector('meta[name="theme-color"]')) { const m = document.createElement("meta"); m.name = "theme-color"; m.content = "#0f172a"; h.appendChild(m); }
    if (!document.querySelector('link[rel="apple-touch-icon"]')) { const l = document.createElement("link"); l.rel = "apple-touch-icon"; l.href = "icons/icon-180.png"; h.appendChild(l); }
  } catch (_) {}
})();
function syncSwConfig() {
  try {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistration().then(r => {
      const w = r && (r.active || r.waiting || r.installing);
      if (w) w.postMessage({ type: "cfg", cfg: { api: API_BASE, key: getAdminKey() } });
    }).catch(() => {});
  } catch (_) {}
}
window.addEventListener("load", () => { applyWakeLock(); syncSwConfig(); });
