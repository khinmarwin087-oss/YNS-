// admin/js/main.js
const API_BASE = "https://yns.khinmarwin087.workers.dev";
const ADMIN_KEY_STORAGE = "yns_admin_key";

function getAdminKey() {
  return localStorage.getItem(ADMIN_KEY_STORAGE) || "";
}

async function apiFetch(path, opts = {}) {
  const key = getAdminKey();
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": key,
      ...(opts.headers || {})
    }
  });
  if (res.status === 401) {
    lockOut("Admin Key မှားနေပါသည်။ ပြန်လည်ဝင်ရောက်ပါ။");
    throw new Error("Unauthorized");
  }
  return res.json();
}

function lockOut(message) {
  localStorage.removeItem(ADMIN_KEY_STORAGE);
  window.location.href = "index.html";
}

function logout() {
  lockOut("");
}

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

// Side Navigation Bar Component Render Logic
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
  `).join('');
}
