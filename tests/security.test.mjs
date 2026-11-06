// Integration test — Node 22 (node:sqlite) ဖြင့် D1 အတု ပြုလုပ်ပြီး Worker ကို တိုက်ရိုက် စမ်းသည်
// run: node --no-warnings tests/security.test.mjs
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const tmp = new URL("./.worker.tmp.mjs", import.meta.url);
fs.copyFileSync(new URL("../worker.js", import.meta.url), tmp);
const { default: W } = await import(tmp.href);
const sql = new DatabaseSync(":memory:");
const fix = (v) => (typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v);
const DB = {
  prepare(q) {
    let args = [];
    const st = { bind: (...a) => { args = a.map(fix); return st; },
      run: async () => { const r = sql.prepare(q).run(...args); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
      first: async () => sql.prepare(q).get(...args) || null,
      all: async () => ({ results: sql.prepare(q).all(...args) }),
      _x: () => sql.prepare(q).run(...args) };
    return st;
  },
  async batch(sts) { for (const s of sts) await s.run(); return []; },
  async exec(q) { sql.exec(q); },
};
const env = { DB, ADMIN_KEY: "owner-key-0123456789abcdef", CHAT_ID: "1", RATE_OFF: "1" };
const ctx = { waitUntil: (p) => p };
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ✅ " : "  ❌ ") + m); if (!c) fails++; };
async function call(method, path, key, body, extra = {}) {
  const r = await W.fetch(new Request("https://x.test" + path, { method, headers: { "Content-Type": "application/json", ...(key ? { "X-Admin-Key": key } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  let j = null; try { j = await r.clone().json(); } catch (_) {}
  return { s: r.status, j, r };
}
const OK = env.ADMIN_KEY;
console.log("1) Owner + session token");
let r = await call("GET", "/api/admin/ping", OK); ok(r.s === 200 && r.j.role === "owner", "owner ping");
r = await call("GET", "/api/admin/ping", "wrong"); ok(r.s === 401, "wrong key 401");
r = await call("POST", "/api/admin/session", OK, { label: "test" }); const tok = r.j && r.j.token; ok(r.s === 200 && /^ss\./.test(tok), "session minted");
r = await call("GET", "/api/admin/ping", tok); ok(r.s === 200 && r.j.role === "owner", "ping with session token");
r = await call("GET", "/api/admin/sessions", tok); ok(r.j.items.length === 1 && r.j.items[0].current, "session list shows current");
console.log("2) Staff roles");
r = await call("POST", "/api/admin/staff", tok, { name: "Ma Ma", role: "cashier" }); const ck = r.j && r.j.key; ok(r.s === 200 && /^sf1\.\d+\.[0-9a-f]{24}$/.test(ck), "cashier created");
r = await call("POST", "/api/admin/staff", tok, { name: "Ko Ko", role: "manager" }); const mk = r.j && r.j.key; ok(r.s === 200, "manager created");
r = await call("GET", "/api/admin/ping", ck); ok(r.s === 200 && r.j.staff && r.j.staff.role === "cashier", "cashier ping");
r = await call("GET", "/api/admin/products", ck); ok(r.s === 200, "cashier can read products");
r = await call("POST", "/api/admin/products", ck, { name: "x", price: 1 }); ok(r.s === 403, "cashier cannot create product");
r = await call("GET", "/api/admin/staff", ck); ok(r.s === 403, "cashier cannot list staff");
r = await call("GET", "/api/admin/export", ck); ok(r.s === 403, "cashier cannot export");
r = await call("GET", "/api/admin/analytics", ck); ok(r.s === 403, "cashier cannot see analytics");
r = await call("GET", "/api/admin/orders", ck); ok(r.s === 200, "cashier can read orders");
r = await call("GET", "/api/admin/staff", mk); ok(r.s === 403, "manager cannot manage staff");
r = await call("GET", "/api/admin/export", mk); ok(r.s === 403, "manager cannot export");
r = await call("POST", "/api/admin/passkey/register", mk, {}); ok(r.s === 403, "manager cannot register passkey");
r = await call("POST", "/api/admin/products", mk, { name: "Chicken", price: 4000 }); ok(r.s === 200 || r.s === 201, "manager can create product (" + r.s + ")");
r = await call("GET", "/api/admin/ping", ck.replace(/.$/, "0")); ok(r.s === 401, "tampered staff key rejected");
console.log("3) Audit log");
r = await call("GET", "/api/admin/audit", tok); ok(r.s === 200 && r.j.items.some((x) => /products/.test(x.path) && /Ko Ko/.test(x.actor)), "audit has manager's product create");
ok(r.j.items.some((x) => /staff/.test(x.path) && x.role === "owner"), "audit has owner staff create");
console.log("4) Revoke + staff delete");
r = await call("POST", "/api/admin/sessions/revoke", tok, { current: true }); ok(r.s === 200, "revoke current");
r = await call("GET", "/api/admin/ping", tok); ok(r.s === 401, "revoked token rejected");
const staffList = (await call("GET", "/api/admin/staff", OK)).j.items; const cid = staffList.find((x) => x.role === "cashier").id;
r = await call("POST", "/api/admin/staff/delete", OK, { id: cid }); ok(r.s === 200, "staff deleted");
r = await call("GET", "/api/admin/ping", ck); ok(r.s === 401, "deleted staff key rejected");
console.log("5) Tenant isolation");
r = await call("POST", "/api/admin/shops", OK, { name: "Shop Two", slug: "two", category: "x" }); ok(r.s === 200 || r.s === 201, "shop 2 created (" + r.s + ")");
const vkey = r.j && (r.j.key || r.j.owner_key || r.j.admin_key); console.log("     vendor key field:", Object.keys(r.j || {}).join(","));
if (vkey) {
  r = await call("POST", "/api/admin/products", vkey, { name: "SHOP2-ONLY", price: 100 }); ok(r.s === 200 || r.s === 201, "vendor creates product");
  r = await call("GET", "/api/admin/products", vkey); const names2 = JSON.stringify(r.j); ok(names2.includes("SHOP2-ONLY") && !names2.includes("Chicken"), "vendor sees only own products");
  r = await call("GET", "/api/admin/products", OK); const names1 = JSON.stringify(r.j); ok(names1.includes("Chicken") && !names1.includes("SHOP2-ONLY"), "owner shop1 does not see shop2 product");
  r = await call("POST", "/api/admin/staff", vkey, { name: "Vendor Cashier", role: "cashier" }); const vck = r.j && r.j.key; ok(/^sf2\./.test(vck || ""), "vendor creates staff in own shop");
  r = await call("GET", "/api/admin/products", vck); ok(JSON.stringify(r.j).includes("SHOP2-ONLY") && !JSON.stringify(r.j).includes("Chicken"), "vendor staff sees only shop2");
  r = await call("GET", "/api/admin/staff", vkey); ok(r.j.items.length === 1, "vendor sees only own staff");
  r = await call("GET", "/api/admin/audit", vkey); ok(!JSON.stringify(r.j).includes("Ko Ko"), "vendor audit log isolated");
  r = await call("GET", "/api/admin/export", vkey); ok(r.s === 200 && !JSON.stringify(r.j).includes("Chicken"), "vendor export isolated");
  r = await call("GET", "/api/admin/shops", vkey); ok(r.s === 403, "vendor cannot manage shops");
}
console.log("6) Export");
r = await call("GET", "/api/admin/export", OK); ok(r.s === 200 && r.j.products.length >= 1 && !JSON.stringify(r.j.settings).includes("vapid"), "owner export has products, no secrets");

console.log("7) Signup · trial · plans · expiry");
r = await call("GET", "/api/plans"); ok(r.s === 200 && r.j.plans.length === 3 && r.j.trial_days === 14, "public plans");
r = await call("POST", "/api/signup", null, { name: "Trial Cafe", owner_name: "Mg Mg", phone: "09123456789" }); const tk = r.j && r.j.key; ok(r.s === 200 && /^v\d+\./.test(tk || ""), "signup ok");
const tid = Number(String(tk).split(".")[0].slice(1)); const tslug = r.j.slug;
r = await call("POST", "/api/signup", null, { name: "Bad", owner_name: "x", phone: "12" }); ok(r.s === 400, "signup rejects bad phone");
r = await call("GET", "/api/shops"); ok(!JSON.stringify(r.j).includes("Trial Cafe"), "unapproved shop hidden from marketplace");
r = await call("GET", "/api/shop-status?shop=" + tslug); ok(r.s === 200, "trial shop reachable by direct link");
r = await call("GET", "/api/admin/subscription", tk); ok(r.s === 200 && r.j.trial === true && r.j.days_left >= 13 && r.j.plan === "standard", "trial subscription 14d standard");
r = await call("POST", "/api/admin/shops/" + tid + "/sub", OK, { approved: true }); ok(r.s === 200, "owner approves");
r = await call("GET", "/api/shops"); ok(JSON.stringify(r.j).includes("Trial Cafe"), "approved shop listed");
r = await call("GET", "/api/admin/shops/" + tid + "/sub", tk); ok(r.s === 404 || r.s === 403 || r.s === 405, "vendor cannot reach billing admin (" + r.s + ")");
r = await call("POST", "/api/admin/shops/" + tid + "/payment", tk, { months: 1 }); ok(r.s === 403, "vendor cannot self-record payment");
// plan limits
r = await call("POST", "/api/admin/shops/" + tid + "/sub", OK, { plan: "starter" }); ok(r.s === 200, "set starter");
r = await call("POST", "/api/admin/ai/describe", tk, { name: "x" }); ok(r.s === 403, "starter cannot use AI");
r = await call("POST", "/api/admin/promos", tk, { code: "ABC123", kind: "percent", value: 10 }); ok(r.s === 403, "starter cannot create promo");
r = await call("POST", "/api/admin/staff", tk, { name: "A", role: "cashier" }); ok(r.s === 200, "starter staff 1");
r = await call("POST", "/api/admin/staff", tk, { name: "B", role: "cashier" }); ok(r.s === 200, "starter staff 2");
r = await call("POST", "/api/admin/staff", tk, { name: "C", role: "cashier" }); ok(r.s === 400, "starter staff limit 2 enforced");
sql.exec(`CREATE TABLE IF NOT EXISTS s${tid}_products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
const ins = sql.prepare(`INSERT INTO s${tid}_products (name) VALUES (?)`); for (let i = 0; i < 200; i++) ins.run("p" + i);
r = await call("POST", "/api/admin/products", tk, { name: "overflow", price: 1 }); ok(r.s === 403, "starter product limit 200 enforced");
// payment extends
r = await call("POST", "/api/admin/shops/" + tid + "/payment", OK, { plan: "pro", months: 2, method: "KBZPay", ref: "T123" }); ok(r.s === 200 && r.j.plan === "pro", "owner records payment");
r = await call("GET", "/api/admin/subscription", tk); ok(r.j.plan === "pro" && r.j.trial === false && r.j.days_left >= 70, "payment extends ~14+60 days (" + r.j.days_left + ")");
r = await call("GET", "/api/admin/payments", OK); ok(r.j.items.length === 1 && r.j.items[0].amount === 120000, "payment logged 120,000");
// expiry
const past = Math.floor(Date.now() / 1000) - 10 * 86400; sql.prepare("UPDATE shops SET paid_until = ? WHERE id = ?").run(past, tid);
r = await call("GET", "/api/admin/products", tk); ok(r.s === 402, "expired vendor blocked 402");
r = await call("GET", "/api/admin/subscription", tk); ok(r.s === 200 && r.j.state === "expired", "expired vendor can still see subscription");
r = await call("GET", "/api/admin/export", tk); ok(r.s === 200, "expired vendor can still export data");
r = await call("GET", "/api/shop-status?shop=" + tslug); ok(r.s === 404, "expired shop hidden from customers");
r = await call("GET", "/api/shops"); ok(!JSON.stringify(r.j).includes("Trial Cafe"), "expired shop hidden from marketplace");
r = await call("GET", "/api/admin/products", OK); ok(r.s === 200, "owner main shop unaffected");
sql.prepare("UPDATE shops SET paid_until = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) - 86400, tid);
r = await call("GET", "/api/admin/products", tk); ok(r.s === 200, "within 3-day grace still works");
r = await call("POST", "/api/admin/shops/" + tid + "/payment", OK, { plan: "standard", months: 1 }); r = await call("GET", "/api/admin/products", tk); ok(r.s === 200, "renewed after expiry works");
// daily reset — လျော့နေသော stock ကိုပါ ပြန်ဖြည့်
r = await call("POST", "/api/admin/products", OK, { name: "ResetT", price: 1000, stock: 4, daily_stock: 10 }); ok(r.s === 200, "create tracked product");
const rid = r.j.id || (r.j.product && r.j.product.id);
r = await call("POST", "/api/admin/inventory/reset", OK, { mode: "soldout" });
ok(sql.prepare("SELECT stock FROM products WHERE id = ?").get(rid).stock === 4, "soldout mode leaves partial stock");
r = await call("POST", "/api/admin/inventory/reset", OK, { mode: "all" });
ok(sql.prepare("SELECT stock FROM products WHERE id = ?").get(rid).stock === 10, "all mode refills partial stock");
ok(sql.prepare("SELECT COUNT(*) c FROM stock_log WHERE product_id = ? AND reason LIKE ?").get(rid, "%ပြန်စ%").c === 1, "reset logged");
// delete shop — Owner Key ထပ်တောင်း
r = await call("DELETE", "/api/admin/shops/" + tid, OK, {}); ok(r.s === 403, "delete without key body refused");
r = await call("DELETE", "/api/admin/shops/" + tid, OK, { key: "wrong" }); ok(r.s === 403, "delete with wrong key refused");
r = await call("DELETE", "/api/admin/shops/" + tid, tk, { key: OK }); ok(r.s === 403, "vendor cannot delete");
r = await call("DELETE", "/api/admin/shops/1", OK, { key: OK }); ok(r.s === 400, "main shop cannot be deleted");
r = await call("DELETE", "/api/admin/shops/" + tid, OK, { key: OK }); ok(r.s === 200, "delete with owner key ok");
ok(!sql.prepare("SELECT 1 x FROM shops WHERE id = ?").get(tid), "shop row gone");
ok(!sql.prepare("SELECT name FROM sqlite_master WHERE name = ?").get("s" + tid + "_products"), "tenant tables dropped");
ok(sql.prepare("SELECT COUNT(*) c FROM payments").get().c >= 1, "payment records kept");
fs.unlinkSync(tmp);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
