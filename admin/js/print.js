/* admin/js/print.js — ဖောက်သည်ဘက် ဘောက်ချာ ပုံစံအတိုင်း thermal ပရင်တာအတွက် (ပုံအဖြစ်ဆွဲ + ESC/POS) */
(function () {
  const DOTS = { 58: 384, 80: 576 };
  const FONT = '"Noto Sans Myanmar","Bricolage Grotesque","Plus Jakarta Sans",sans-serif';
  const NOEMO = x => String(x == null ? "" : x).replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}️]/gu, "").replace(/\s{2,}/g, " ").trim();
  const fmt = n => Number(n || 0).toLocaleString("en-US");

  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

  /* d = { vCode, queue?, name, phone?, when, pickup?, items:[{name,price,qty,total,note?}], discount?, promo?, total, packs?:[{no,items:[{name,qty}],sauce,note}], note?, paid } */
  async function draw(cv, d, mm) {
    mm = mm === 80 ? 80 : 58;
    try { await document.fonts.load('bold 20px "Noto Sans Myanmar"', "မြင်သာကြက်ကင်"); } catch (_) {}
    const W = DOTS[mm], FS = mm === 80 ? 22 : 19, B = 10, PAD = B + 12, wide = mm === 80;
    const mc = document.createElement("canvas").getContext("2d");
    const seg = t => { try { return Array.from(new Intl.Segmenter("my", { granularity: "grapheme" }).segment(t), x => x.segment); } catch (_) { return Array.from(t); } };
    const f = (sz, bold) => `${bold ? "bold " : ""}${sz}px ${FONT}`;
    const lh = sz => Math.round(sz * 1.55);
    const wrap = (txt, font, maxW) => { mc.font = font; const out = []; for (const para of String(txt).split(/\n/)) { let line = ""; for (const w of para.split(" ")) { const t = line ? line + " " + w : w; if (mc.measureText(t).width <= maxW) { line = t; continue; } if (line) { out.push(line); line = ""; } if (mc.measureText(w).width <= maxW) { line = w; continue; } for (const g of seg(w)) { if (mc.measureText(line + g).width > maxW && line) { out.push(line); line = g; } else line += g; } } out.push(line); } return out; };
    const inner = W - PAD * 2;
    const L = []; let H = B + 14;
    const push = (o, h) => { L.push({ ...o, y: H }); H += h; };

    push({ k: "t", text: "မြင်သာကြက်ကင်", sz: FS + 9, bold: 1 }, lh(FS + 9));
    push({ k: "t", text: "Voucher No: " + d.vCode, sz: FS - 1, bold: 1 }, lh(FS - 1));
    push({ k: "t", text: "ဝယ်ယူအားပေးမှုကို ကျေးဇူးတင်ပါသည်", sz: FS - 4 }, lh(FS - 4));
    H += 6;
    if (d.queue) { const QS = FS + 52; push({ k: "qbox", label: "ခေါ်ရန် နံပါတ်", num: String(d.queue), qs: QS }, lh(FS - 2) + QS + 24); H += 6; }
    const info = [["ဝယ်သူအမည်:", NOEMO(d.name)], d.phone ? ["ဖုန်း / ID:", NOEMO(d.phone)] : null, ["နေ့ရက်/အချိန်:", NOEMO(d.when)], d.pickup ? ["လာယူရန်:", NOEMO(d.pickup)] : null].filter(Boolean);
    info.forEach(([k, v]) => {
      mc.font = f(FS - 1); const kw = Math.ceil(mc.measureText(k).width) + 10;
      const lines = wrap(v, f(FS - 1, 1), inner - kw); push({ k: "info", key: k, kw, lines, sz: FS - 1 }, lines.length * lh(FS - 1));
    });
    H += 4; push({ k: "hr", dash: 1 }, 12);

    // ---- items ----
    if (wide) {
      push({ k: "head4", sz: FS - 4 }, lh(FS - 4) + 4);
      push({ k: "hr" }, 12);
      const cq = Math.round(W * .56), cp = Math.round(W * .39);
      d.items.forEach(i => {
        const lines = wrap(NOEMO(i.name), f(FS, 1), cp - PAD - 8);
        push({ k: "row4", lines, i, cp, cq, sz: FS }, lines.length * lh(FS) + 4);
        if (i.note) { const nl = wrap("• " + NOEMO(i.note), f(FS - 4), inner); push({ k: "sub", lines: nl, sz: FS - 4 }, nl.length * lh(FS - 4)); }
      });
    } else {
      push({ k: "head2", sz: FS - 4 }, lh(FS - 4) + 4);
      push({ k: "hr" }, 12);
      d.items.forEach(i => {
        const lines = wrap(NOEMO(i.name), f(FS, 1), inner);
        push({ k: "row2a", lines, sz: FS }, lines.length * lh(FS));
        push({ k: "row2b", l: `${fmt(i.price)} Ks × ${i.qty}`, r: fmt(i.total) + " Ks", sz: FS - 2 }, lh(FS - 2) + 4);
        if (i.note) { const nl = wrap("• " + NOEMO(i.note), f(FS - 4), inner); push({ k: "sub", lines: nl, sz: FS - 4 }, nl.length * lh(FS - 4)); }
      });
    }
    push({ k: "hr", dash: 1 }, 12);
    if (d.discount > 0) push({ k: "lr", l: `လျှော့ဈေး (${NOEMO(d.promo) || "PROMO"})`, r: "-" + fmt(d.discount) + " Ks", sz: FS - 1, bold: 1 }, lh(FS - 1) + 2);
    push({ k: "total", l: "စုစုပေါင်းကျသင့်ငွေ:", r: fmt(d.total) + " Ks", sz: FS + 1 }, lh(FS + 3) + 6);
    H += 6;
    push({ k: "stamp", text: d.paid ? "ငွေရှင်းပြီး" : "ငွေမရှင်းရသေးပါ", sz: FS + 2, paid: d.paid }, lh(FS + 2) + 18);

    if (d.packs && d.packs.length) {
      H += 6; push({ k: "hr", dash: 1 }, 12);
      push({ k: "lbl", text: "ထုပ်ခွဲပေးရန်", sz: FS }, lh(FS));
      d.packs.forEach((p, n) => {
        const rows = (p.items || []).map(x => `${NOEMO(x.name)} ×${x.qty}`).join("\n");
        const lines = wrap(rows, f(FS - 2), inner - 8), extra = [];
        if (p.sauce === "with") extra.push("အချဉ်ရည် ပါမည် (တစ်ခါတည်းစမ်း)"); else if (p.sauce === "separate") extra.push("အချဉ်ရည် သက်သက်ထုပ်");
        if (p.note) extra.push(NOEMO(p.note));
        const el = extra.flatMap(t => wrap("• " + t, f(FS - 3), inner - 8));
        push({ k: "pack", no: p.no || n + 1, lines, el, sz: FS - 2 }, lh(FS - 1) + 4 + lines.length * lh(FS - 2) + el.length * lh(FS - 3) + 10);
      });
    }
    if (d.note) { H += 4; push({ k: "hr", dash: 1 }, 12); push({ k: "lbl", text: "မှတ်ချက်", sz: FS }, lh(FS)); const nl = wrap(NOEMO(d.note), f(FS - 1), inner); push({ k: "sub2", lines: nl, sz: FS - 1 }, nl.length * lh(FS - 1)); }
    H += 8; push({ k: "hr", dash: 1 }, 12);
    const foot = wrap("ဤဘောက်ချာကို ပြသမှသာ ပစ္စည်းထုတ်ပေးပါမည်", f(FS - 3), inner);
    push({ k: "foot", lines: foot, sz: FS - 3 }, foot.length * lh(FS - 3));
    H += 14 + B;

    // ---- draw ----
    cv.width = W; cv.height = H; const c = cv.getContext("2d"); c.fillStyle = "#fff"; c.fillRect(0, 0, W, H); c.fillStyle = "#000"; c.strokeStyle = "#000";
    c.lineWidth = 3; rr(c, B / 2 + 1, B / 2 + 1, W - B - 2, H - B - 2, 6); c.stroke();
    const bl = (y, sz) => y + Math.round(lh(sz) * .76);
    for (const e of L) {
      if (e.k === "t") { c.font = f(e.sz, e.bold); c.textAlign = "center"; c.fillText(e.text, W / 2, bl(e.y, e.sz)); }
      else if (e.k === "qbox") { const h = lh(FS - 2) + e.qs + 20; c.lineWidth = 4; rr(c, PAD, e.y, W - PAD * 2, h, 12); c.stroke(); c.textAlign = "center"; c.font = f(FS - 2, 1); c.fillText(e.label, W / 2, bl(e.y + 6, FS - 2)); c.font = f(e.qs, 1); c.fillText(e.num, W / 2, e.y + 6 + lh(FS - 2) + e.qs * .98); }
      else if (e.k === "info") { c.textAlign = "left"; c.font = f(e.sz); c.fillText(e.key, PAD, bl(e.y, e.sz)); c.font = f(e.sz, 1); e.lines.forEach((ln, i) => c.fillText(ln, PAD + e.kw, bl(e.y + i * lh(e.sz), e.sz))); }
      else if (e.k === "hr") { c.lineWidth = 2; c.setLineDash(e.dash ? [6, 4] : []); c.beginPath(); c.moveTo(PAD - 4, e.y + 6); c.lineTo(W - PAD + 4, e.y + 6); c.stroke(); c.setLineDash([]); }
      else if (e.k === "head4") { c.font = f(e.sz, 1); c.textAlign = "left"; c.fillText("အမည်", PAD, bl(e.y, e.sz)); c.fillText("ဈေးနှုန်း", Math.round(W * .39), bl(e.y, e.sz)); c.textAlign = "center"; c.fillText("ခုရေ", Math.round(W * .66), bl(e.y, e.sz)); c.textAlign = "right"; c.fillText("စုစုပေါင်း", W - PAD, bl(e.y, e.sz)); }
      else if (e.k === "head2") { c.font = f(e.sz, 1); c.textAlign = "left"; c.fillText("အမည် / ဈေး × ခုရေ", PAD, bl(e.y, e.sz)); c.textAlign = "right"; c.fillText("စုစုပေါင်း", W - PAD, bl(e.y, e.sz)); }
      else if (e.k === "row4") { c.font = f(e.sz, 1); c.textAlign = "left"; e.lines.forEach((ln, i) => c.fillText(ln, PAD, bl(e.y + i * lh(e.sz), e.sz))); c.fillText(fmt(e.i.price) + " Ks", e.cp, bl(e.y, e.sz)); c.textAlign = "center"; c.fillText(String(e.i.qty), Math.round(W * .66), bl(e.y, e.sz)); c.textAlign = "right"; c.fillText(fmt(e.i.total) + " Ks", W - PAD, bl(e.y, e.sz)); }
      else if (e.k === "row2a") { c.font = f(e.sz, 1); c.textAlign = "left"; e.lines.forEach((ln, i) => c.fillText(ln, PAD, bl(e.y + i * lh(e.sz), e.sz))); }
      else if (e.k === "row2b") { c.font = f(e.sz); c.textAlign = "left"; c.fillText(e.l, PAD + 8, bl(e.y, e.sz)); c.font = f(e.sz, 1); c.textAlign = "right"; c.fillText(e.r, W - PAD, bl(e.y, e.sz)); }
      else if (e.k === "sub") { c.font = f(e.sz); c.textAlign = "left"; e.lines.forEach((ln, i) => c.fillText(ln, PAD + 8, bl(e.y + i * lh(e.sz), e.sz))); }
      else if (e.k === "lr") { c.font = f(e.sz, e.bold); c.textAlign = "left"; c.fillText(e.l, PAD, bl(e.y, e.sz)); c.textAlign = "right"; c.fillText(e.r, W - PAD, bl(e.y, e.sz)); }
      else if (e.k === "total") { c.font = f(e.sz, 1); c.textAlign = "left"; c.fillText(e.l, PAD, bl(e.y + 2, e.sz)); c.font = f(e.sz + 3, 1); c.textAlign = "right"; c.fillText(e.r, W - PAD, bl(e.y + 2, e.sz + 2)); }
      else if (e.k === "stamp") { const h = lh(e.sz) + 12; c.lineWidth = 3; if (e.paid) rr(c, PAD + 24, e.y, W - (PAD + 24) * 2, h, 10); else { c.setLineDash([8, 5]); rr(c, PAD + 10, e.y, W - (PAD + 10) * 2, h, 10); } c.stroke(); c.setLineDash([]); c.font = f(e.sz, 1); c.textAlign = "center"; c.fillText(e.text, W / 2, bl(e.y + 6, e.sz)); }
      else if (e.k === "lbl") { c.font = f(e.sz, 1); c.textAlign = "left"; c.fillText(e.text, PAD, bl(e.y, e.sz)); }
      else if (e.k === "pack") {
        const h = lh(FS - 1) + 4 + e.lines.length * lh(e.sz) + e.el.length * lh(FS - 3) + 6;
        c.lineWidth = 2; rr(c, PAD, e.y, W - PAD * 2, h, 8); c.stroke();
        c.fillRect(PAD, e.y, W - PAD * 2, lh(FS - 1) + 2); c.fillStyle = "#fff"; c.font = f(FS - 1, 1); c.textAlign = "left"; c.fillText("ထုပ် " + e.no, PAD + 8, bl(e.y + 1, FS - 1)); c.fillStyle = "#000";
        let y = e.y + lh(FS - 1) + 4; c.font = f(e.sz); e.lines.forEach(ln => { c.fillText(ln, PAD + 8, bl(y, e.sz)); y += lh(e.sz); });
        c.font = f(FS - 3); e.el.forEach(ln => { c.fillText(ln, PAD + 8, bl(y, FS - 3)); y += lh(FS - 3); });
      }
      else if (e.k === "sub2") { c.font = f(e.sz); c.textAlign = "left"; e.lines.forEach((ln, i) => c.fillText(ln, PAD, bl(e.y + i * lh(e.sz), e.sz))); }
      else if (e.k === "foot") { c.font = f(e.sz); c.textAlign = "center"; e.lines.forEach((ln, i) => c.fillText(ln, W / 2, bl(e.y + i * lh(e.sz), e.sz))); }
    }
    const img = c.getImageData(0, 0, W, H), px = img.data;
    for (let i = 0; i < px.length; i += 4) { const v = (px[i] * .3 + px[i + 1] * .59 + px[i + 2] * .11) < 150 ? 0 : 255; px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255; }
    c.putImageData(img, 0, 0);
    return cv;
  }

  function escpos(cv) {
    const W = cv.width, H = cv.height, bpr = Math.ceil(W / 8), px = cv.getContext("2d").getImageData(0, 0, W, H).data, out = [0x1B, 0x40], BAND = 96;
    for (let y0 = 0; y0 < H; y0 += BAND) { const h = Math.min(BAND, H - y0); out.push(0x1D, 0x76, 0x30, 0x00, bpr & 255, bpr >> 8, h & 255, h >> 8); for (let y = 0; y < h; y++) for (let bx = 0; bx < bpr; bx++) { let b = 0; for (let k = 0; k < 8; k++) { const x = bx * 8 + k; if (x < W && px[((y0 + y) * W + x) * 4] < 128) b |= 0x80 >> k; } out.push(b); } }
    out.push(0x1B, 0x64, 0x04, 0x1D, 0x56, 0x42, 0x00); return new Uint8Array(out);
  }
  window.YNSPrint = { draw, escpos };
})();
