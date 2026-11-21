/* Admin Gate — Key မစစ်မီ စာမျက်နှာအကြောင်းအရာကို လုံးဝ မပြပါ။
   Key မရှိ/မှား → ဝင်ခွင့်ပေးမည့် box သာ ပေါ်မည်။ Server (/api/admin/ping) က အတည်ပြမှသာ ဖွင့်မည်။ */
(function () {
  var KEY = "yns_admin_key", d = document, h = d.documentElement;
  var st = d.createElement("style"); st.id = "gate-css";
  st.textContent = "html.gate-lock body{visibility:hidden!important}html.gate-lock #gate-box,html.gate-lock body>div[style*=\"z-index:3000\"]{visibility:visible!important}";
  d.head.appendChild(st); h.classList.add("gate-lock");
  var base = /(^|\.)myintharchickenbbq\.shop$/.test(location.hostname) ? location.origin : "https://yns.khinmarwin087.workers.dev";
  function get() { try { return localStorage.getItem(KEY) || ""; } catch (_) { return ""; } }
  function ping(k) {
    return fetch(base + "/api/admin/ping", { headers: { "X-Admin-Key": k } }).then(function (r) { return r.status; }, function () { return 0; });
  }
  function open() { h.classList.remove("gate-lock"); var b = d.getElementById("gate-box"); if (b) b.remove(); }
  function box(msg) {
    var b = d.getElementById("gate-box"); if (b) b.remove();
    b = d.createElement("div"); b.id = "gate-box";
    b.style.cssText = "position:fixed;inset:0;background:#0b3d2e;z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:'Noto Sans Myanmar',system-ui,sans-serif";
    b.innerHTML = '<form style="background:#fff;border-radius:22px;padding:26px 22px;width:100%;max-width:340px;box-shadow:0 20px 50px rgba(0,0,0,.35)"><div style="font-size:36px;text-align:center">🔐</div><h3 style="margin:8px 0 4px;text-align:center;font-size:18px;color:#0f172a">Admin ဝင်ရန်</h3><p id="gm" style="margin:0 0 14px;text-align:center;font-size:12.5px;color:#64748b;line-height:1.6">' + (msg || "Key ထည့်ပါ") + '</p><input id="gk" type="password" autocomplete="current-password" placeholder="Admin Key" style="width:100%;box-sizing:border-box;padding:13px 14px;border:1px solid #cbd5e1;border-radius:12px;font-size:15px;outline:none;margin-bottom:12px"><button type="submit" style="width:100%;padding:13px;border:0;border-radius:12px;background:#0D5C49;color:#fff;font-weight:800;font-size:15px">ဝင်မည်</button></form>';
    d.body.appendChild(b);
    var f = b.querySelector("form"), i = b.querySelector("#gk"), m = b.querySelector("#gm");
    setTimeout(function () { i.focus(); }, 60);
    f.onsubmit = function (e) {
      e.preventDefault(); var k = i.value.trim(); if (!k) return;
      m.textContent = "စစ်ဆေးနေသည်…";
      ping(k).then(function (s) {
        if (s === 200) { try { localStorage.setItem(KEY, k); } catch (_) {} open(); location.reload(); }
        else { m.style.color = "#dc2626"; m.textContent = s === 401 || s === 403 ? "Key မှားနေပါသည်" : s === 429 ? "ကြိုးစားမှု များလွန်းသည်၊ ခဏစောင့်ပါ" : "ချိတ်ဆက်၍ မရပါ၊ ထပ်ကြိုးစားပါ"; i.value = ""; }
      });
    };
  }
  function ask(msg) {   // main.js ရှိလျှင် ၎င်း၏ login box (လက်ဗွေ/Face ID ပါ) ကို သုံး၊ မရှိလျှင် ကိုယ်ပိုင် box
    var go = function () {
      if (typeof askAdminKey === "function") askAdminKey(msg).then(function () { location.reload(); });
      else box(msg);
    };
    if (d.readyState === "complete") go(); else window.addEventListener("load", go);
  }
  function start() {
    var k = get();
    if (!k) return ask();
    ping(k).then(function (s) {
      if (s === 200 || s === 402) return open();          // 402 = သက်တမ်းကုန် (key မှန်) — စာမျက်နှာက ကိုယ်တိုင် ကိုင်တွယ်မည်
      if (s === 401 || s === 403) { try { localStorage.removeItem(KEY); } catch (_) {} return ask("Key သက်တမ်းကုန်/မှားနေပါသည်၊ ပြန်ထည့်ပါ"); }
      open();                                              // ကွန်ရက်ပြဿနာ — server က API တိုင်းကို ဆက်ကာကွယ်ထားသည်
    });
  }
  if (d.body) start(); else d.addEventListener("DOMContentLoaded", start);
})();
