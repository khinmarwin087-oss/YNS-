// ---------------------------------------------------------------------------
// ai.js — AI feature အားလုံး ဤဖိုင်တစ်ခုတည်းတွင် (worker.js က import လုပ်သည်)
//
// အခြေခံမူ: ဂဏန်းတွေကို SQL/စည်းမျဉ်းဖြင့် တွက် (မှန်ကန်၊ အခမဲ့)၊ Workers AI (LLM) က
//          စကားပြောပုံစံ ရှင်းပြ/အကြံပေးရုံသာ။ AI က ဘာကိုမျှ အလိုလို မပြင်ပါ — owner က ဆုံးဖြတ်။
//
// Endpoint များ (Standard အစီအစဉ်မှစ၍ — worker.js က plan စစ်ပြီး ဤနေရာသို့ ပို့သည်):
//   GET  /api/admin/ai/summary?days=1|7|30   နေ့စဉ်/အပတ်စဉ် အရောင်း အကျဉ်းချုပ်
//   POST /api/admin/ai/ask      {q}          စကားနဲ့ မေးလို့ရသော report assistant
//   GET  /api/admin/ai/reorder               Stock ဘယ်နှစ်ရက်ခံမလဲ + ဘယ်လောက်မှာရမလဲ
//   GET  /api/admin/ai/segments              ဝယ်သူ အုပ်စုခွဲ (RFM) — အမြဲ/ပျောက်နေ/ပြန်ခေါ်ရန်
//   POST /api/admin/ai/promo    {goal,pid?}  Promotion အကြံ + ပို့စာ ရေးပေး
//   POST /api/admin/ai/describe {name,...}   ပစ္စည်းဖော်ပြချက် ရေးပေး
// ---------------------------------------------------------------------------

export const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MMT = 390 * 60000;
const mmtDay = (offsetDays = 0) => new Date(Date.now() + MMT - offsetDays * 864e5).toISOString().slice(0, 10);
const num = (v) => Math.round(Number(v) || 0);
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const ks = (n) => num(n).toLocaleString("en-US") + " Ks";

const SYS = "You are a concise business assistant for a small shop owner in Myanmar. Always answer in Burmese (Myanmar Unicode), short and practical. " +
  "Use ONLY the numbers in the DATA given — never invent figures. If data is not enough, say so. Suggestions are advice only; the owner decides.";

async function llm(env, system, user, maxTokens = 450, temp = 0.4) {
  if (!env.AI) return { error: "AI မချိတ်ရသေးပါ — wrangler.toml မှာ [ai] binding ထည့်ပြီး Worker ပြန်တင်ပါ" };
  try {
    const r = await env.AI.run(AI_MODEL, {
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: maxTokens, temperature: temp,
    });
    const t = String((r && (r.response ?? r.result ?? "")) || "").trim();
    return t ? { text: t } : { error: "AI က စာမထုတ်ပေးပါ — ထပ်စမ်းပါ" };
  } catch (e) {
    return { error: "AI အမှား: " + clip(e && e.message || e, 120) };
  }
}

// ---------------------------------------------------------------------------
// ဒေတာ စုစည်းခြင်း (SQL — အားလုံး tenant အလိုက် scope ဖြစ်ပြီးသား env.DB ကို သုံး)
// ---------------------------------------------------------------------------
async function salesFacts(env, days) {
  const since = mmtDay(days - 1);
  const q = async (sql, ...b) => ((await env.DB.prepare(sql).bind(...b).all()).results || []);
  const tot = (await q(
    `SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM orders WHERE COALESCE(status,'') != 'Cancelled' AND date(created_at,'+390 minutes') >= ?`, since))[0] || { n: 0, t: 0 };
  const canc = (await q(
    `SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM orders WHERE status = 'Cancelled' AND date(created_at,'+390 minutes') >= ?`, since))[0] || { n: 0, t: 0 };
  const daily = await q(
    `SELECT date(created_at,'+390 minutes') d, COUNT(*) n, COALESCE(SUM(total),0) t FROM orders
     WHERE COALESCE(status,'') != 'Cancelled' AND date(created_at,'+390 minutes') >= ? GROUP BY d ORDER BY d`, since);
  const hours = await q(
    `SELECT CAST(strftime('%H', datetime(created_at,'+390 minutes')) AS INTEGER) h, COUNT(*) n FROM orders
     WHERE COALESCE(status,'') != 'Cancelled' AND date(created_at,'+390 minutes') >= ? GROUP BY h ORDER BY n DESC LIMIT 3`, since);
  const top = await q(
    `SELECT json_extract(j.value,'$.name') name, SUM(COALESCE(json_extract(j.value,'$.qty'),0)) q, SUM(COALESCE(json_extract(j.value,'$.total'),0)) r
     FROM orders o, json_each(CASE WHEN json_valid(o.items_json) THEN o.items_json ELSE '[]' END) j
     WHERE COALESCE(o.status,'') != 'Cancelled' AND date(o.created_at,'+390 minutes') >= ? GROUP BY name ORDER BY q DESC LIMIT 5`, since);
  const low = await q(
    `SELECT name, stock, daily_stock FROM products WHERE daily_stock > 0 AND stock <= MAX(1, daily_stock/4) AND COALESCE(hidden,0) = 0 ORDER BY stock LIMIT 8`);
  return {
    days, since,
    orders: num(tot.n), revenue: num(tot.t), avg_order: tot.n ? num(tot.t / tot.n) : 0,
    cancelled: num(canc.n), cancelled_value: num(canc.t),
    daily: daily.map((r) => ({ d: r.d, n: num(r.n), t: num(r.t) })),
    peak_hours: hours.map((r) => ({ h: num(r.h), n: num(r.n) })),
    top: top.map((r) => ({ name: clip(r.name, 40), qty: num(r.q), revenue: num(r.r) })),
    low_stock: low.map((r) => ({ name: clip(r.name, 40), stock: num(r.stock), daily: num(r.daily_stock) })),
  };
}

const hrLabel = (h) => `${h % 12 || 12} နာရီ${h < 12 ? " (နံနက်)" : h < 18 ? " (နေ့/ညနေ)" : " (ည)"}`;

function factsText(f) {
  const lines = [
    `ကာလ: နောက်ဆုံး ${f.days} ရက် (${f.since} မှ)`,
    `အော်ဒါ ${f.orders} ခု · ရောင်းရငွေ ${ks(f.revenue)} · အော်ဒါတစ်ခုလျှင် ပျမ်းမျှ ${ks(f.avg_order)}`,
    `ပယ်ဖျက်ထားသော အော်ဒါ ${f.cancelled} ခု (${ks(f.cancelled_value)})`,
  ];
  if (f.peak_hours.length) lines.push("အော်ဒါအများဆုံး အချိန်: " + f.peak_hours.map((x) => `${hrLabel(x.h)} (${x.n})`).join(", "));
  if (f.top.length) lines.push("အရောင်းဆုံး: " + f.top.map((x) => `${x.name} ${x.qty} ခု (${ks(x.revenue)})`).join("; "));
  if (f.low_stock.length) lines.push("Stock နည်း/ကုန်လုနီး: " + f.low_stock.map((x) => `${x.name} (${x.stock}/${x.daily})`).join(", "));
  if (f.daily.length > 1) lines.push("နေ့စဉ်: " + f.daily.map((x) => `${x.d.slice(5)}=${ks(x.t)}`).join(", "));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
async function aiSummary(request, env, json) {
  const days = Math.min(30, Math.max(1, parseInt(new URL(request.url).searchParams.get("days"), 10) || 1));
  const f = await salesFacts(env, days);
  const data = factsText(f);
  const r = f.orders || f.cancelled
    ? await llm(env, SYS, `DATA:\n${data}\n\nအပေါ်ဒေတာကို ဆိုင်ပိုင်ရှင်အတွက် အကျဉ်းချုပ်ပေးပါ: (၁) ဘယ်လိုနေလဲ ၁-၂ ကြောင်း (၂) သတိထားရမည့်အချက် (stock၊ ပယ်ဖျက်မှု၊ အချိန်) (၃) လုပ်သင့်သည့်အကြံ ၁-၂ ချက်။ စုစုပေါင်း ၆ ကြောင်းအောက်။`)
    : { text: "ဤကာလအတွက် အော်ဒါ မရှိသေးပါ။" };
  return json({ ok: true, facts: f, facts_text: data, text: r.text || "", ai_error: r.error || null });
}

async function aiAsk(request, env, json) {
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const qn = clip(b.q, 300);
  if (!qn) return json({ ok: false, error: "မေးခွန်း ရိုက်ပါ" }, 400);
  const [f30, f7] = [await salesFacts(env, 30), await salesFacts(env, 7)];
  const today = (await salesFacts(env, 1));
  const data = `[ယနေ့]\n${factsText(today)}\n\n[၇ ရက်]\n${factsText(f7)}\n\n[၃၀ ရက်]\n${factsText(f30)}`;
  const r = await llm(env, SYS, `DATA:\n${data}\n\nမေးခွန်း: ${qn}`, 450, 0.2);
  if (r.error) return json({ ok: false, error: r.error }, 502);
  return json({ ok: true, text: r.text });
}

// Stock ဘယ်နှစ်ရက်ခံမလဲ — စည်းမျဉ်းသက်သက် (AI မလို)
async function aiReorder(env, json) {
  const since = mmtDay(13);
  const sold = {};
  for (const r of (await env.DB.prepare(
    `SELECT json_extract(j.value,'$.id') pid, SUM(COALESCE(json_extract(j.value,'$.qty'),0)) q
     FROM orders o, json_each(CASE WHEN json_valid(o.items_json) THEN o.items_json ELSE '[]' END) j
     WHERE COALESCE(o.status,'') != 'Cancelled' AND date(o.created_at,'+390 minutes') >= ? GROUP BY pid`).bind(since).all()).results || []) {
    if (r.pid != null) sold[r.pid] = num(r.q);
  }
  const prods = (await env.DB.prepare(
    `SELECT id, name, stock, daily_stock, available FROM products WHERE COALESCE(hidden,0) = 0 AND daily_stock > 0 ORDER BY name`).all()).results || [];
  const rows = prods.map((p) => {
    const rate = (sold[p.id] || 0) / 14;                 // တစ်ရက် ပျမ်းမျှ ရောင်းနှုန်း
    const left = rate > 0 ? p.stock / rate : null;       // လက်ကျန်ဖြင့် ဘယ်နှစ်ရက်ခံ
    const need7 = Math.ceil(rate * 7);
    const suggest = Math.max(0, need7 - num(p.stock));
    let level = "ok";
    if (p.stock <= 0 || !p.available) level = "out";
    else if (left !== null && left < 1) level = "urgent";
    else if (left !== null && left < 3) level = "soon";
    else if (rate === 0 && p.stock > 0) level = "idle";
    return { id: p.id, name: clip(p.name, 50), stock: num(p.stock), daily: num(p.daily_stock), per_day: Math.round(rate * 10) / 10, days_left: left === null ? null : Math.round(left * 10) / 10, suggest_qty: suggest, level };
  });
  const order = { out: 0, urgent: 1, soon: 2, ok: 3, idle: 4 };
  rows.sort((a, b) => order[a.level] - order[b.level] || (a.days_left ?? 999) - (b.days_left ?? 999));
  return json({ ok: true, basis: "နောက်ဆုံး ၁၄ ရက် ရောင်းနှုန်း", rows });
}

// ဝယ်သူ အုပ်စုခွဲ (RFM-lite) — ဖုန်းနံပါတ်အလိုက်
async function aiSegments(env, json) {
  const rs = (await env.DB.prepare(
    `SELECT phone, MAX(customer_name) name, COUNT(*) n, COALESCE(SUM(total),0) spent,
            CAST(julianday(date('now','+390 minutes')) - julianday(date(MAX(created_at),'+390 minutes')) AS INTEGER) last_days
     FROM orders WHERE COALESCE(status,'') != 'Cancelled' AND COALESCE(phone,'') != '' GROUP BY phone`).all()).results || [];
  const seg = { loyal: [], new: [], risk: [], lost: [], other: [] };
  for (const r of rs) {
    const c = { phone: r.phone, name: clip(r.name, 40), orders: num(r.n), spent: num(r.spent), last_days: num(r.last_days) };
    if (c.orders >= 4 && c.last_days <= 30) seg.loyal.push(c);
    else if (c.orders === 1 && c.last_days <= 14) seg.new.push(c);
    else if (c.orders >= 2 && c.last_days > 30 && c.last_days <= 90) seg.risk.push(c);
    else if (c.last_days > 90) seg.lost.push(c);
    else seg.other.push(c);
  }
  const by = (a, b) => b.spent - a.spent;
  const out = {};
  for (const k of Object.keys(seg)) out[k] = { count: seg[k].length, spent: seg[k].reduce((a, x) => a + x.spent, 0), top: seg[k].sort(by).slice(0, 15) };
  return json({ ok: true, total: rs.length, segments: out,
    note: "ဝယ်သူအချက်အလက်ကို ဆိုင်ပိုင်ရှင်သာ မြင်ရသည်။ SMS/Viber ပို့လျှင် ဝယ်သူ၏ သဘောတူညီမှု ရှိရမည်။" });
}

async function aiPromo(request, env, json) {
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const goal = clip(b.goal, 200) || "ရောင်းအားတိုးရန်";
  const pid = parseInt(b.pid, 10);
  let prod = "";
  if (pid > 0) {
    const p = (await env.DB.prepare(`SELECT name, price, stock, daily_stock FROM products WHERE id = ?`).bind(pid).first());
    if (p) prod = `ပစ္စည်း: ${clip(p.name, 60)} · ဈေး ${ks(p.price)} · stock ${num(p.stock)}/${num(p.daily_stock)}`;
  }
  const f = await salesFacts(env, 7);
  const r = await llm(env,
    SYS + " Output exactly this format:\nအကြံ: <one promotion idea with a sensible discount/limit>\nစာတို: <one short customer message in Burmese, max 2 sentences, friendly>",
    `DATA:\n${factsText(f)}\n${prod}\nရည်ရွယ်ချက်: ${goal}\nဆိုင်ရှင် ဆုံးဖြတ်ရန် အကြံပေးပါ။ အရှုံးမပေါ်သော လျှော့ဈေးသာ အကြံပြုပါ။`, 350, 0.7);
  if (r.error) return json({ ok: false, error: r.error }, 502);
  return json({ ok: true, text: r.text });
}

async function aiDescribe(request, env, json, h) {
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const name = clip(b.name, 100), cat = clip(b.category, 50), hint = clip(b.hint, 200);
  if (!name) return json({ ok: false, error: "ပစ္စည်းအမည် အရင်ဖြည့်ပါ" }, 400);
  const shop = (env.SHOP && env.SHOP.name) || "";
  const r = await llm(env,
    "You write short, appetizing product descriptions in Burmese (Myanmar Unicode) for a small online shop. Output ONLY the description text: 1-2 short sentences, no quotes, no emoji spam, no invented facts such as prices or ingredients not given.",
    `ဆိုင်: ${shop || "-"}\nပစ္စည်းအမည်: ${name}\nအမျိုးအစား: ${cat || "-"}\nထပ်ဆောင်းအချက်: ${hint || "-"}`, 220, 0.7);
  if (r.error) return json({ ok: false, error: r.error }, 502);
  const t = r.text.replace(/^["'“”]+|["'“”]+$/g, "").replace(/\s+/g, " ").slice(0, 300);
  return json({ ok: true, text: t });
}

// ---------------------------------------------------------------------------
// router — worker.js မှ တစ်ခုတည်း ခေါ်သည်။ h = { json, rateTake, clientIp }
// ---------------------------------------------------------------------------
export async function handleAi(request, env, path, h) {
  const { json } = h;
  if (!env.DB) return json({ ok: false, error: "Database not configured" }, 500);
  // LLM သုံးသော endpoint များကိုသာ rate-limit (reorder/segments က SQL သက်သက်)
  const usesLlm = path !== "/api/admin/ai/reorder" && path !== "/api/admin/ai/segments";
  if (usesLlm && (await h.rateTake(env, "ai:" + h.clientIp(request), 60, 3600)))
    return json({ ok: false, error: "တစ်နာရီအတွင်း အကြိမ်များလွန်းသည် — ခဏနေမှ ထပ်စမ်းပါ" }, 429);
  const m = request.method;
  try {
    if (path === "/api/admin/ai/summary" && m === "GET") return await aiSummary(request, env, json);
    if (path === "/api/admin/ai/ask" && m === "POST") return await aiAsk(request, env, json);
    if (path === "/api/admin/ai/reorder" && m === "GET") return await aiReorder(env, json);
    if (path === "/api/admin/ai/segments" && m === "GET") return await aiSegments(env, json);
    if (path === "/api/admin/ai/promo" && m === "POST") return await aiPromo(request, env, json);
    if (path === "/api/admin/ai/describe" && m === "POST") return await aiDescribe(request, env, json, h);
  } catch (e) {
    return json({ ok: false, error: "AI module: " + clip(e && e.message || e, 120) }, 500);
  }
  return json({ ok: false, error: "Not found" }, 404);
}
