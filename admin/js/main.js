// admin/js/main.js

const API_BASE = "https://yns.khinmarwin087.workers.dev";
const ADMIN_KEY_STORAGE = "yns_admin_key";

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
        <h3 style="margin:8px 0 4px;text-align:center;font-size:18px;color:#0f172a;">Admin Key ထည့်ပါ</h3>
        <p id="keyMsg" style="margin:0 0 14px;text-align:center;font-size:12px;color:#64748b;line-height:1.5;">${message || "ဤ browser တွင် တစ်ကြိမ်သာ ထည့်ရပါမည်။"}</p>
        <input id="keyInput" type="password" autocomplete="current-password" placeholder="Admin Key"
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
          wrap.remove();
          _keyPromise = null;
          resolve(key);
          return;
        }
        msg.style.color = "#dc2626";
        msg.textContent = r.status === 401
          ? "Key မှားနေပါသည်။ Cloudflare တွင် ထည့်ထားသော ADMIN_KEY နှင့် အတိအကျ တူရပါမည်။"
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
    { id: "orders", href: "orders.html", icon: "fa-receipt", label: "Orders" },
    { id: "products", href: "products.html", icon: "fa-box", label: "Products" },
    { id: "inventory", href: "inventory.html", icon: "fa-warehouse", label: "Inventory" },
    { id: "customers", href: "customers.html", icon: "fa-users", label: "Customers" },
    { id: "revenue", href: "revenue.html", icon: "fa-chart-line", label: "Revenue" },
    { id: "analytics", href: "analytics.html", icon: "fa-chart-column", label: "Analytics" },
    { id: "notifications", href: "notifications.html", icon: "fa-bell", label: "Notifications" },
    { id: "settings", href: "settings.html", icon: "fa-gear", label: "Settings" }
  ];

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

// 8. အော်ဒါအသစ် သတိပေးချက် (အသံ / tab title badge / Telegram စမ်းသပ်)
const SOUND_KEY = "yns_sound";
let _audioCtx = null;

function soundOn() {
  try { return localStorage.getItem(SOUND_KEY) !== "0"; } catch (_) { return true; }
}
function setSound(on) {
  try { localStorage.setItem(SOUND_KEY, on ? "1" : "0"); } catch (_) {}
}
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

function playBeep() {
  if (!soundOn()) return;
  try {
    unlockAudio();
    const c = _audioCtx;
    if (!c || c.state !== "running") return;
    [0, 0.24, 0.48].forEach((t, i) => {
      const o = c.createOscillator(), g = c.createGain(), at = c.currentTime + t;
      o.type = "sine";
      o.frequency.value = i === 2 ? 1175 : 880;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.4, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      o.connect(g); g.connect(c.destination);
      o.start(at); o.stop(at + 0.22);
    });
  } catch (_) {}
}

// Tab title တွင် စောင့်နေသော အော်ဒါအရေအတွက် (2) Orders ပုံစံ
function setTitleBadge(n, base) {
  document.title = (n > 0 ? "(" + n + ") " : "") + base;
}

// Telegram သို့ စမ်းသပ်မက်ဆေ့ချ် ပို့ကြည့်ရန် (မအောင်မြင်လျှင် apiFetch က အကြောင်းရင်းကို toast ပြမည်)
async function testTelegram() {
  try {
    await apiFetch("/api/admin/test-telegram", { method: "POST" });
    showToast("Telegram သို့ စမ်းသပ်မက်ဆေ့ချ် ပို့ပြီးပါပြီ ✅ Telegram ကို ကြည့်ပါ", 5000);
  } catch (_) { /* error ကို apiFetch က toast ပြပြီးသား */ }
}
