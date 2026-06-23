// netlify/functions/news.mjs
// Pulls recent commercial real estate headlines from public RSS feeds, then ranks them for
// CAF relevance and adds a one-line "why it matters" using the Anthropic API (same key the
// commentary function uses, read from ANTHROPIC_API_KEY). Headlines + links only — no
// full-text republication. If the key is absent or the model call fails, it degrades cleanly
// to a recency-sorted list with no "why it matters" line.
//
// Sources confirmed with Austin: GlobeSt, Multifamily Dive, The Real Deal, Bisnow.
// CoStar News has no public RSS feed (subscription product), so it can't be wired here.

// Abort slow upstreams (a sluggish RSS host or the model call) before they run the function
// into Netlify's ~10s wall and cause an empty response.
async function fetchWithTimeout(url, opts = {}, ms = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const FEEDS = [
  { url: "https://www.globest.com/feed/",                source: "GlobeSt",          tag: "CRE" },
  { url: "https://www.multifamilydive.com/feeds/news/",  source: "Multifamily Dive", tag: "Multifamily" },
  { url: "https://therealdeal.com/national/feed/",       source: "The Real Deal",    tag: "CRE" },
  { url: "https://www.bisnow.com/rss",                   source: "Bisnow",           tag: "CRE" },
];

function parseItems(xml, source, tag) {
  const items = [];
  const blocks = xml.split(/<item[ >]/).slice(1);
  for (const b of blocks.slice(0, 8)) {
    const title = (b.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1];
    const link = (b.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) || [])[1];
    const date = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    if (title && link) {
      items.push({
        headline: title.trim(),
        url: link.trim(),
        source,
        tag,
        date: date ? new Date(date.trim()).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "",
        ts: date ? Date.parse(date.trim()) : 0,
      });
    }
  }
  return items;
}

// Ask Claude to score each candidate for a DFW multifamily PE lens and explain why it matters.
async function rankForCaf(candidates, key) {
  const list = candidates.map((it, i) => `${i}. ${it.headline} (${it.source})`).join("\n");
  const prompt = `You rank commercial real estate headlines for the VP of a Dallas-Fort Worth multifamily private equity firm (CAF Capital Partners). His priorities, highest first:
1) Texas / Sun Belt multifamily (apartments, rents, supply, transactions)
2) Agency debt — Fannie Mae / Freddie Mac / HUD multifamily lending
3) Apartment cap rates and multifamily valuations
4) Major multifamily transactions and capital flows
General CRE/macro is lower priority; office/retail/industrial-only items are lowest.

Headlines:
${list}

Return ONLY a JSON array, no prose, no code fences. One object per headline you consider worth showing (you may drop clearly irrelevant ones), ordered most relevant first:
[{"i": <index>, "score": <0-100>, "why": "<one tight sentence, max ~14 words, on why it matters to a DFW multifamily investor>"}]`;

  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    }),
  }, 8000);
  const data = await res.json();
  let text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("["), end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("No JSON array in model output");
  const ranked = JSON.parse(text.slice(start, end + 1));
  return ranked
    .filter((r) => candidates[r.i])
    .map((r) => ({ ...candidates[r.i], whyItMatters: (r.why || "").trim(), score: r.score }));
}

export default async function handler() {
  const all = [];
  await Promise.all(FEEDS.map(async (f) => {
    try {
      const res = await fetchWithTimeout(f.url, { headers: { "User-Agent": "Mozilla/5.0 (caf-rates-desk)" } }, 5000);
      const xml = await res.text();
      all.push(...parseItems(xml, f.source, f.tag));
    } catch (e) { /* skip a feed that fails */ }
  }));

  // Dedupe by headline, then take a recency-ordered candidate pool to rank.
  const seen = new Set();
  const deduped = all.filter((it) => {
    const k = it.headline.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  deduped.sort((a, b) => b.ts - a.ts);
  const candidates = deduped.slice(0, 14);

  const key = process.env.ANTHROPIC_API_KEY;
  let items;
  if (key && candidates.length) {
    try {
      const ranked = await rankForCaf(candidates, key);
      items = ranked.slice(0, 6).map(({ ts, score, ...rest }) => rest);
    } catch (e) {
      // Ranking failed — fall back to recency, no "why it matters".
      items = candidates.slice(0, 6).map(({ ts, ...rest }) => rest);
    }
  } else {
    items = candidates.slice(0, 6).map(({ ts, ...rest }) => rest);
  }

  return new Response(JSON.stringify({ items }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=900" },
  });
}
