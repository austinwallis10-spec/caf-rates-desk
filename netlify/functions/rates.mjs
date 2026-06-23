// netlify/functions/rates.mjs
// Returns 2/5/7/10/30Y US Treasury par yields + SOFR, each with day-over-day change (bps).
// Sources (both free, no API key):
//   - US Treasury daily par yield curve (XML feed)
//   - NY Fed SOFR (JSON)
// NOTE: These endpoints could not be tested from the build environment. Smoke-test on first
// deploy via Netlify function logs; if a field name or response shape differs, adjust the
// parsers below. (Cowork can do this iteration automatically.)

const TENORS = [
  { tenor: "2Y",  tag: "BC_2YEAR" },
  { tenor: "5Y",  tag: "BC_5YEAR" },
  { tenor: "7Y",  tag: "BC_7YEAR" },
  { tenor: "10Y", tag: "BC_10YEAR" },
  { tenor: "30Y", tag: "BC_30YEAR" },
];

function pick(xml, tag) {
  // Matches <d:BC_10YEAR m:type="Edm.Double">4.23</d:BC_10YEAR>.
  // Missing values come back as <d:BC_30YEAR m:null="true" /> and correctly yield null.
  const m = xml.match(new RegExp("<d:" + tag + "[^>]*>([^<]+)</d:" + tag + ">"));
  return m ? parseFloat(m[1]) : null;
}

function yyyymm(d) {
  return "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0");
}

async function fetchMonthEntries(yyyymmStr) {
  // Monthly feed is ~20 entries vs. ~250 for the full year — far faster, avoids the
  // Netlify 10s function timeout. Atom/OData XML, entries ascending (oldest first).
  const url = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml" +
    "?data=daily_treasury_yield_curve&field_tdr_date_value_month=" + yyyymmStr;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (caf-rates-desk)" } });
  if (!res.ok) throw new Error("Treasury HTTP " + res.status);
  const xml = await res.text();
  return xml.split("<entry>").slice(1);
}

async function getTreasuries() {
  const now = new Date();
  let entries = await fetchMonthEntries(yyyymm(now));
  // Early in the month there may be <2 trading days; pull the prior month for day-over-day.
  if (entries.length < 2) {
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    try {
      const prevEntries = await fetchMonthEntries(yyyymm(prevMonth));
      entries = prevEntries.concat(entries);
    } catch (e) { /* keep what we have */ }
  }
  if (entries.length === 0) throw new Error("No treasury entries");
  const last = entries[entries.length - 1];
  const prev = entries.length > 1 ? entries[entries.length - 2] : null;
  const dateMatch = last.match(/<d:NEW_DATE[^>]*>([^<]+)</);
  const asOfRaw = dateMatch ? dateMatch[1].slice(0, 10) : "";
  const treasuries = TENORS.map(({ tenor, tag }) => {
    const cur = pick(last, tag);
    const old = prev ? pick(prev, tag) : null;
    const changeBps = cur != null && old != null ? Math.round((cur - old) * 100 * 10) / 10 : null;
    return { tenor, yield: cur, changeBps };
  }).filter((t) => t.yield != null);
  if (treasuries.length === 0) throw new Error("No treasury tenors parsed");
  return { asOf: asOfRaw, treasuries };
}

async function getSofr() {
  const url = "https://markets.newyorkfed.org/api/rates/secured/sofr/last/2.json";
  const res = await fetch(url);
  const data = await res.json();
  const rows = data.refRates || (data.rates ? data.rates : []);
  if (!rows.length) throw new Error("No SOFR rows");
  const cur = rows[0];
  const prev = rows[1] || null;
  const rate = parseFloat(cur.percentRate);
  const oldRate = prev ? parseFloat(prev.percentRate) : null;
  const changeBps = oldRate != null ? Math.round((rate - oldRate) * 100 * 10) / 10 : 0;
  return { rate, changeBps, effectiveDate: cur.effectiveDate };
}

// Foreign 10Y government benchmarks via Stooq (free, no key). Stooq daily CSV returns
// Date,Open,High,Low,Close,Volume ascending; take the last two closes for day-over-day.
// Each symbol is fetched independently so one failure can't sink the others; if all fail
// the array is empty and the front-end simply omits the section.
const FOREIGN = [
  { name: "Germany 10Y (Bund)", symbol: "10dey.b" },
  { name: "UK 10Y (Gilt)",      symbol: "10uky.b" },
  { name: "Japan 10Y (JGB)",    symbol: "10jpy.b" },
];

function ymd(d) {
  return "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

async function fetchForeignOne({ name, symbol }) {
  const now = new Date();
  const start = new Date(now.getTime() - 20 * 864e5); // ~20 days back to guarantee 2 closes
  const url = "https://stooq.com/q/d/l/?s=" + symbol + "&i=d&d1=" + ymd(start) + "&d2=" + ymd(now);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (caf-rates-desk)" } });
  if (!res.ok) throw new Error("Stooq HTTP " + res.status);
  const csv = (await res.text()).trim();
  const rows = csv.split(/\r?\n/).slice(1).filter(Boolean); // drop header
  if (rows.length === 0) throw new Error("No rows for " + symbol);
  const closeOf = (line) => parseFloat(line.split(",")[4]);
  const cur = closeOf(rows[rows.length - 1]);
  const old = rows.length > 1 ? closeOf(rows[rows.length - 2]) : null;
  if (!isFinite(cur)) throw new Error("Bad close for " + symbol);
  const changeBps = old != null && isFinite(old) ? Math.round((cur - old) * 100 * 10) / 10 : null;
  return { name, yield: cur, changeBps };
}

async function getForeign() {
  const settled = await Promise.allSettled(FOREIGN.map(fetchForeignOne));
  return settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
}

export default async function handler() {
  try {
    const [t, sofr, foreign] = await Promise.all([
      getTreasuries(),
      getSofr(),
      getForeign().catch(() => []), // foreign is best-effort; never fails the response
    ]);
    const asOf = t.asOf ? new Date(t.asOf).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) + " · par close" : "";
    return new Response(JSON.stringify({
      asOf,
      treasuries: t.treasuries,
      sofr,
      foreign,
    }), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=900" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
}
