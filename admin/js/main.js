// admin/js/main.js

const API_BASE = "https://yns.khinmarwin087.workers.dev";
const ADMIN_KEY_STORAGE = "yns_admin_key";

// 1. Get Stored Admin Key
function getAdminKey() {
  return localStorage.getItem(ADMIN_KEY_STORAGE) || "";
}

// 2. Fetch API with Key Verification
async function apiFetch(path, opts = {}) {
  const key = getAdminKey();
  
  if (!key) {
    showToast("Admin Key မရှိသေးပါ။ Settings တွင် Key သွားရောက်ထည့်သွင်းပါ/ပြင်ပါ။");
    throw new Error("Missing Admin Key");
  }

  try {
    const res = await fetch(API_BASE + path, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key": key,
        ...(opts.headers || {})
      }
    });

    if (res.status === 401) {
      showToast("Admin Key မှားနေပါသည်။ Settings တွင် Key ပြန်ပြင်ပါ။");
      throw new Error("Unauthorized");
    }

    return await res.json();
  } catch (err) {
    console.error("API Fetch Error:", err);
    throw err;
  }
}

// 3. Authentication & Logout
function lockOut(message) {
  localStorage.removeItem(ADMIN_KEY_STORAGE);
  showToast(message || "Session သက်တမ်းကုန်သွားပါပြီ");
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
function showToast(msg) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2600);
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
