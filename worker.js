export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Order ပို့မယ့် path ကိုပဲ ဒီနေရာမှာ ကိုင်တွယ်မယ် ("/api/send-order")
    if (url.pathname === "/api/send-order") {
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }

      if (request.method !== "POST") {
        return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      try {
        const body = await request.json();
        if (!body || !body.text) {
          return new Response(JSON.stringify({ ok: false, error: "Missing text" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const telegramUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;

        const tgResponse = await fetch(telegramUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.CHAT_ID,
            text: body.text,
            parse_mode: "Markdown",
          }),
        });

        const tgResult = await tgResponse.json();

        return new Response(JSON.stringify(tgResult), {
          status: tgResponse.status,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // ကျန်တဲ့ request အားလုံးကို static file (html/css/js) အနေနဲ့ ပုံမှန်အတိုင်း serve လုပ်ပေးမယ်
    return env.ASSETS.fetch(request);
  },
};
