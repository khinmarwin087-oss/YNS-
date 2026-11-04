// ဆိုင်ဒေတာ ခွဲထားမှု စစ်ဆေးမှု — `node tests/tenant-check.mjs`
// ၁) CREATE TABLE လုပ်ထားသော table တိုင်းကို "ဆိုင်အလိုက်" (TENANT_RE) သို့မဟုတ် "အားလုံးမျှ" (GLOBAL) ထဲ ရှိကြောင်း
// ၂) SQL ထဲက table အမည်တိုင်း ဆိုင်ခွဲ regex ကျော်မသွားကြောင်း
import fs from "node:fs";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const GLOBAL = new Set(["shops", "rate_limits", "passkeys", "pk_sessions", "admin_sessions"]);
const m = src.match(/const TENANT_RE = \/(.+)\/gi;/);
if (!m) { console.error("TENANT_RE မတွေ့ပါ"); process.exit(1); }
const re = new RegExp(m[1], "gi");
const tenant = new Set((m[1].match(/\(orders\|[^)]+\)/) || [""])[0].slice(1, -1).split("|"));
let bad = 0;
const created = [...src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((x) => x[1].toLowerCase());
for (const t of new Set(created)) {
  if (!tenant.has(t) && !GLOBAL.has(t)) { console.error("❌ table `" + t + "` ကို TENANT_RE ထဲလည်း GLOBAL ထဲလည်း မထည့်ရသေးပါ"); bad++; }
}
// SQL table references
const refs = [...src.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO|ON|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+([a-z_][a-z0-9_]*)\b/g)].map((x) => x[1].toLowerCase());
for (const t of new Set(refs)) { if (created.includes(t) && tenant.has(t)) { /* ok — regex ဖြင့် ပြောင်းမည် */ } }
// CREATE INDEX ... ON <tenant table> — TENANT_RE က `ON` ကို မကိုင်၊ index အမည်ကိုလည်း ပြောင်းရမည်
for (const x of src.matchAll(/CREATE (?:UNIQUE )?INDEX[^`"']*?\bON\s+(\w+)/gi)) {
  if (tenant.has(x[1].toLowerCase())) { console.error("❌ CREATE INDEX ... ON " + x[1] + " — ဆိုင်ခွဲ SQL ထဲ index အမည်ပါ ထပ်နေနိုင်"); bad++; }
}
// ဆိုင် ၂ အတွက် နမူနာ SQL များ စမ်း
const sample = [
  ["SELECT * FROM orders WHERE id=?", "s2_orders"], ["INSERT OR IGNORE INTO settings (k,v) VALUES (?,?)", "s2_settings"],
  ["DELETE FROM products WHERE id=?", "s2_products"], ["UPDATE promos SET x=1", "s2_promos"],
  ["SELECT a FROM orders o JOIN products p ON p.id=o.id", "s2_products"], ["ALTER TABLE orders ADD COLUMN x TEXT", "s2_orders"],
  ["SELECT * FROM shops", "shops"], ["SELECT * FROM rate_limits", "rate_limits"],
];
for (const [sql, want] of sample) {
  const out = sql.replace(re, (mm, a, b, t) => `${a}${b}s2_${t.toLowerCase()}`);
  if (!out.includes(want)) { console.error("❌ `" + sql + "` → " + out); bad++; }
}
console.log(bad ? `\n${bad} ပြဿနာ တွေ့သည်` : "✅ ဆိုင်ဒေတာ ခွဲထားမှု စစ်ဆေးမှု အားလုံး အောင်သည် (" + [...tenant].length + " tenant tables)");
process.exit(bad ? 1 : 0);
