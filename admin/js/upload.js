// admin/js/upload.js — ဖုန်းထဲက ပုံကို တိုက်ရိုက်ရွေး၊ အလိုအလျောက် ကျုံ့၊ Worker သို့ တင်
(function () {
  function pickFile() {
    return new Promise((resolve) => {
      const i = document.createElement("input");
      i.type = "file"; i.accept = "image/*"; i.style.display = "none";
      i.onchange = () => { const f = i.files && i.files[0]; i.remove(); resolve(f || null); };
      i.oncancel = () => { i.remove(); resolve(null); };
      document.body.appendChild(i); i.click();
    });
  }
  async function load(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (_) {}
    }
    return await new Promise((res, rej) => {
      const url = URL.createObjectURL(file), im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); res(im); };
      im.onerror = () => { URL.revokeObjectURL(url); rej(new Error("ပုံဖတ်၍ မရပါ")); };
      im.src = url;
    });
  }
  const b64bytes = (d) => Math.floor(((d.length - d.indexOf(",") - 1) * 3) / 4);
  // ပုံကို အရွယ်အစားသေးပြီး JPEG အဖြစ် ကျုံ့ (maxKB အောက်ရောက်သည်အထိ)
  async function compress(file, o) {
    o = Object.assign({ maxDim: 1000, maxKB: 220, minQ: 0.5 }, o || {});
    const img = await load(file);
    let w = img.width || img.naturalWidth, h = img.height || img.naturalHeight, dim = o.maxDim;
    for (let round = 0; round < 6; round++) {
      const sc = Math.min(1, dim / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
      const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
      const c = cv.getContext("2d");
      c.fillStyle = "#fff"; c.fillRect(0, 0, cw, ch);
      c.drawImage(img, 0, 0, cw, ch);
      for (let q = 0.85; q >= o.minQ - 0.001; q -= 0.07) {
        const d = cv.toDataURL("image/jpeg", q);
        if (b64bytes(d) <= o.maxKB * 1024) return d;
      }
      dim = Math.round(dim * 0.8);
    }
    throw new Error("ပုံကို ကျုံ့၍ မရပါ");
  }
  async function upload(file, o) {
    const data = await compress(file, o);
    const r = await apiFetch("/api/admin/upload", { method: "POST", body: JSON.stringify({ data }) });
    return { url: r.url, bytes: r.bytes };
  }
  // ရွေး → ကျုံ့ → တင် → { url }  (မရွေးလျှင် null)
  async function pickAndUpload(o) {
    const f = await pickFile();
    if (!f) return null;
    if (!/^image\//.test(f.type || "image/")) throw new Error("ပုံဖိုင်သာ ရွေးပါ");
    return upload(f, o);
  }
  // Logo / App icon အတွက် — ပုံအလယ်ကို လေးထောင့်ကျကျ ဖြတ်၍ size×size ဖြင့် တင် (ဥပမာ 512×512)
  async function compressSquare(file, size, maxKB) {
    const img = await load(file), w = img.width || img.naturalWidth, h = img.height || img.naturalHeight, s = Math.min(w, h);
    const cv = document.createElement("canvas"); cv.width = cv.height = size;
    const c = cv.getContext("2d"); c.fillStyle = "#fff"; c.fillRect(0, 0, size, size);
    c.drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
    for (let q = 0.92; q >= 0.5; q -= 0.07) { const d = cv.toDataURL("image/jpeg", q); if (b64bytes(d) <= maxKB * 1024) return d; }
    return cv.toDataURL("image/jpeg", 0.5);
  }
  async function pickSquare(o) {
    o = Object.assign({ size: 512, maxKB: 140 }, o || {});
    const f = await pickFile(); if (!f) return null;
    if (!/^image\//.test(f.type || "image/")) throw new Error("ပုံဖိုင်သာ ရွေးပါ");
    const data = await compressSquare(f, o.size, o.maxKB);
    const r = await apiFetch("/api/admin/upload", { method: "POST", body: JSON.stringify({ data }) });
    return { url: r.url, bytes: r.bytes };
  }
  window.YNSUpload = { pickFile, compress, upload, pickAndUpload, pickSquare };
})();
