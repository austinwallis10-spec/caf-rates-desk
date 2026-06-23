// netlify/functions/commentary.mjs
// Generates a short "what's driving today" commentary from the day's rate moves.
// Requires environment variable: ANTHROPIC_API_KEY  (set in Netlify → Site settings → Environment variables)
// Cost note: one short call per refresh; pennies at personal volume.

export default async function handler(req) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  let rates = {};
  try { rates = await req.json(); } catch (e) { /* fall through with empty */ }

  const fmtChg = (b) => (b == null || isNaN(b)) ? "flat" : `${b >= 0 ? "+" : ""}${b} bps`;
  const lines = (rates.treasuries || []).map(t => `${t.tenor}: ${t.yield}% (${fmtChg(t.changeBps)})`).join(", ");
  const sofr = rates.sofr ? `SOFR ${rates.sofr.rate}% (${fmtChg(rates.sofr.changeBps)})` : "";

  const prompt = `You are a fixed-income desk strategist writing for a Dallas-based multifamily private equity investor who cares about financing costs (agency debt, floating-rate bridge debt priced over SOFR).
Today's US rate moves: ${lines}. ${sofr}.
Write a tight ~90-word commentary on what is plausibly driving the day-over-day move and what it means for multifamily financing. If you are unsure of the specific catalyst, speak to the curve shape and SOFR level rather than inventing news. No preamble, no bullet points, no disclaimer.`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: ctrl.signal,
    });
    const data = await res.json();
    const commentary = (data.content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    return new Response(JSON.stringify({ commentary: commentary || "Commentary unavailable." }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { "Content-Type": "application/json" } });
  } finally {
    clearTimeout(timer);
  }
}
