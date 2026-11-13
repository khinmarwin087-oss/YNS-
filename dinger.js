// Dinger Payment (staging/production) — Cloudflare Worker အတွက်
// Web Crypto တွင် RSA PKCS#1 v1.5 encrypt နှင့် AES-ECB မရှိသောကြောင့် ကိုယ်တိုင်ရေးထားသည်
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64e = (u) => { let s = ""; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); };
const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---- RSA (PKCS#1 v1.5, public key) ----
function readDer(d, p) { // → {tag, start, len, next}
  const tag = d[p]; let l = d[p + 1], q = p + 2;
  if (l & 0x80) { const n = l & 0x7f; l = 0; for (let i = 0; i < n; i++) l = l * 256 + d[q++]; }
  return { tag, start: q, len: l, next: q + l };
}
export function parsePublicKey(pem) {
  const d = b64d(String(pem).replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""));
  const top = readDer(d, 0);                       // SEQUENCE
  const algo = readDer(d, top.start);              // AlgorithmIdentifier
  const bits = readDer(d, algo.next);              // BIT STRING
  const inner = readDer(d, bits.start + 1);        // RSAPublicKey SEQUENCE
  const nI = readDer(d, inner.start), eI = readDer(d, nI.next);
  const big = (x) => BigInt("0x" + (hex(d.slice(x.start, x.next)) || "0"));
  const n = big(nI);
  return { n, e: big(eI), k: Math.ceil(n.toString(16).length / 2) };
}
function modPow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; }
function rsaBlock(key, bytes) {
  const { n, e, k } = key;
  if (bytes.length > k - 11) throw new Error("RSA block too long");
  const em = new Uint8Array(k); em[1] = 2;
  const ps = crypto.getRandomValues(new Uint8Array(k - 3 - bytes.length));
  for (let i = 0; i < ps.length; i++) while (!ps[i]) ps[i] = crypto.getRandomValues(new Uint8Array(1))[0];
  em.set(ps, 2); em[2 + ps.length] = 0; em.set(bytes, 3 + ps.length);
  const c = modPow(BigInt("0x" + hex(em)), e, n).toString(16).padStart(k * 2, "0");
  return Uint8Array.from(c.match(/../g).map((h) => parseInt(h, 16)));
}
// Dinger နမူနာ (Java) အတိုင်း — စာသားကို 64-byte အပိုင်းများခွဲ၍ တစ်ပိုင်းချင်းစီ encrypt → ဆက် → Base64
export function rsaEncryptChunks(pem, text, chunk = 64) {
  const key = parsePublicKey(pem), data = new TextEncoder().encode(text), out = [];
  for (let i = 0; i < data.length; i += chunk) out.push(rsaBlock(key, data.slice(i, i + chunk)));
  const all = new Uint8Array(out.reduce((a, b) => a + b.length, 0)); let o = 0; for (const b of out) { all.set(b, o); o += b.length; }
  return b64e(all);
}

// ---- AES-ECB decrypt (PKCS7) ----
const SB = new Uint8Array(256), INV = new Uint8Array(256);
(() => { let p = 1, q = 1; do { p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0); q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
  const x = q ^ ((q << 1) | (q >> 7)) & 0xff ^ ((q << 2) | (q >> 6)) & 0xff ^ ((q << 3) | (q >> 5)) & 0xff ^ ((q << 4) | (q >> 4)) & 0xff; SB[p] = (x ^ 0x63) & 0xff; INV[SB[p]] = p; } while (p !== 1); SB[0] = 0x63; INV[0x63] = 0; })();
const xt = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };
function expand(key) {
  const nk = key.length / 4, nr = nk + 6, w = new Uint8Array(16 * (nr + 1)); w.set(key);
  let rc = 1;
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = w.slice((i - 1) * 4, i * 4);
    if (i % nk === 0) { t = [SB[t[1]] ^ rc, SB[t[2]], SB[t[3]], SB[t[0]]]; rc = xt(rc); } else if (nk > 6 && i % nk === 4) t = t.map((x) => SB[x]);
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ t[j];
  }
  return { w, nr };
}
function decBlock(s, { w, nr }) {
  const add = (r) => { for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i]; };
  add(nr);
  for (let r = nr - 1; r >= 0; r--) {
    const t = s.slice(); for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) s[((c + rr) % 4) * 4 + rr] = t[c * 4 + rr];   // InvShiftRows
    for (let i = 0; i < 16; i++) s[i] = INV[s[i]];
    add(r);
    if (r) for (let c = 0; c < 4; c++) { const a = s.slice(c * 4, c * 4 + 4); s[c * 4] = mul(a[0], 14) ^ mul(a[1], 11) ^ mul(a[2], 13) ^ mul(a[3], 9); s[c * 4 + 1] = mul(a[0], 9) ^ mul(a[1], 14) ^ mul(a[2], 11) ^ mul(a[3], 13); s[c * 4 + 2] = mul(a[0], 13) ^ mul(a[1], 9) ^ mul(a[2], 14) ^ mul(a[3], 11); s[c * 4 + 3] = mul(a[0], 11) ^ mul(a[1], 13) ^ mul(a[2], 9) ^ mul(a[3], 14); }
  }
  return s;
}
export function aesEcbDecrypt(secret, b64) {
  const key = new TextEncoder().encode(secret), ct = b64d(b64);
  if (![16, 24, 32].includes(key.length) || ct.length % 16 || !ct.length) throw new Error("bad key/cipher");
  const ks = expand(key), out = new Uint8Array(ct.length);
  for (let i = 0; i < ct.length; i += 16) out.set(decBlock(ct.slice(i, i + 16), ks), i);
  const pad = out[out.length - 1]; if (pad < 1 || pad > 16) throw new Error("bad padding");
  return new TextDecoder().decode(out.slice(0, out.length - pad));
}
export async function sha256Hex(text) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))); }

// ---- Dinger API ----
const base = (env) => { const b = String(env.DINGER_BASE || ""); if (!/^https:\/\/[\w.-]+(\/[\w./-]*)?$/.test(b)) throw new Error("DINGER_BASE မသတ်မှတ်ရသေးပါ"); return b.endsWith("/") ? b : b + "/"; };
export async function dingerCreate(env, p) {
  if (!env.DINGER_API_KEY || !env.DINGER_PUBLIC_KEY) throw new Error("DINGER_API_KEY / DINGER_PUBLIC_KEY မသတ်မှတ်ရသေးပါ");
  const B = base(env), q = new URLSearchParams({ projectName: env.DINGER_PROJECT || "sannkyi staging", apiKey: env.DINGER_API_KEY, merchantName: env.DINGER_MERCHANT || "mtktest" });
  const t = await (await fetch(`${B}api/token?${q}`)).json();
  const token = t && t.token && t.token.paymentToken;
  if (!token) throw new Error("Token မရပါ: " + (t && t.message || "unknown"));
  const body = { providerName: p.providerName, methodName: p.methodName, totalAmount: Number(p.totalAmount), orderId: String(p.orderId), customerPhone: String(p.customerPhone), customerName: String(p.customerName), items: JSON.stringify(p.items) };
  const fd = new FormData(); fd.append("payload", rsaEncryptChunks(env.DINGER_PUBLIC_KEY, JSON.stringify(body)));
  const r = await fetch(`${B}api/pay`, { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
  let j; try { j = await r.json(); } catch (_) { throw new Error("Dinger ပြန်ကြားချက် မမှန်ပါ (HTTP " + r.status + ")"); }
  return j;
}
export async function dingerCallback(env, b) {
  const plain = aesEcbDecrypt(env.DINGER_SECRET, String(b.paymentResult || ""));
  const sum = String(b.checksum || b.checkSum || "").toLowerCase();
  let sumOk = false; try { sumOk = sum === (await sha256Hex(plain)) || sum === (await sha256Hex(JSON.stringify(JSON.parse(plain)))); } catch (_) {}
  return { result: JSON.parse(plain), sumOk };
}
