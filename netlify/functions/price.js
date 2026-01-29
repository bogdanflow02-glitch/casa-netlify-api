// netlify/functions/price.js (ESM) — FIXED for Booking Engine Markup (-10) logic
const HOSTAWAY_BASE = "https://api.hostaway.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

function isISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

async function getAccessToken() {
  const ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
  const API_KEY = process.env.HOSTAWAY_API_KEY;

  if (!ACCOUNT_ID || !API_KEY) {
    throw new Error("Missing HOSTAWAY_ACCOUNT_ID / HOSTAWAY_API_KEY env vars");
  }

  const tokRes = await fetch(`${HOSTAWAY_BASE}/v1/accessTokens`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: ACCOUNT_ID,
      client_secret: API_KEY,
      scope: "general",
    }),
  });

  const tokJson = await tokRes.json().catch(() => ({}));
  if (!tokRes.ok || !tokJson?.access_token) {
    throw new Error(`Token request failed: ${tokJson?.message || tokJson?.error || "unknown"}`);
  }
  return tokJson.access_token;
}

function sumTotals(components, predicateFn) {
  return components
    .filter((c) => c && predicateFn(c) && Number.isFinite(Number(c.total)))
    .reduce((sum, c) => sum + Number(c.total), 0);
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed. Use POST." });

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { arrival, departure } = data;
  const guests = Math.max(1, Math.min(10, Number(data.guests) || 1));

  if (!isISODate(arrival) || !isISODate(departure)) {
    return json(400, { error: "arrival and departure must be YYYY-MM-DD" });
  }

  const start = new Date(`${arrival}T00:00:00Z`);
  const end = new Date(`${departure}T00:00:00Z`);
  const nights = Math.max(0, Math.round((end - start) / 86400000));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || nights < 1) {
    return json(400, { error: "Invalid dates", hint: "Departure must be after Arrival (min 1 night)." });
  }

  const LISTING_ID = process.env.HOSTAWAY_LISTING_ID;
  if (!LISTING_ID) return json(500, { error: "Missing HOSTAWAY_LISTING_ID env var" });

  try {
    const token = await getAccessToken();

    const priceDetailsRes = await fetch(
      `${HOSTAWAY_BASE}/v1/listings/${encodeURIComponent(LISTING_ID)}/calendar/priceDetails`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          startingDate: arrival,
          endingDate: departure,
          numberOfGuests: guests,
          version: 2,
        }),
      }
    );

    const raw = await priceDetailsRes.json().catch(() => ({}));
    if (!priceDetailsRes.ok) {
      return json(priceDetailsRes.status || 500, {
        error: "Hostaway priceDetails failed",
        message: raw?.message || raw?.error || "unknown",
        details: raw,
      });
    }

    const result = raw?.result || raw?.data?.result || raw?.data || raw;
    const components = result?.components;

    if (!Array.isArray(components)) {
      return json(502, { error: "Hostaway response missing components[]", raw });
    }

    // ✅ Your rule:
    // accommodation already includes Booking Engine markup (-10)
    // include all other components EXCEPT "discount" (weekly/monthly/coupon)
    const accommodationTotal = sumTotals(components, (c) => c.type === "accommodation");
    const otherIncludedTotal = sumTotals(
      components,
      (c) => c.type !== "accommodation" && c.type !== "discount"
    );

    if (!Number.isFinite(accommodationTotal) || accommodationTotal <= 0) {
      return json(502, { error: "Could not compute accommodation subtotal from components", raw });
    }

    const totalPrice = round2(accommodationTotal + otherIncludedTotal);
    const perNight = nights > 0 ? round2(accommodationTotal / nights) : null;

    const currency = result?.currency || raw?.currency || "CHF";

    return json(200, {
      currency,
      nights,
      // ✅ return components so frontend can show cleaning fee etc. without hard-coding
      components,
      breakdown: {
        accommodationSubtotal: round2(accommodationTotal), // already includes Booking Engine Markup
        otherIncludedTotal: round2(otherIncludedTotal),   // fees/taxes/etc (excluding discount)
        totalPrice,
        perNight,
      },
    });
  } catch (e) {
    return json(500, { error: "Server error", details: String(e?.message || e) });
  }
}
