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

  if (!ACCOUNT_ID || !API_KEY) throw new Error("Missing HOSTAWAY_ACCOUNT_ID / HOSTAWAY_API_KEY env vars");

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

function sumFromArray(arr) {
  if (!Array.isArray(arr)) return null;
  let sum = 0;
  let found = false;

  for (const it of arr) {
    const v =
      Number(it?.total) ||
      Number(it?.amount) ||
      Number(it?.price) ||
      Number(it?.value);

    if (Number.isFinite(v)) {
      sum += v;
      found = true;
    }
  }
  return found ? sum : null;
}

exports.handler = async (event) => {
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

  const discountPct = Number(process.env.WEBSITE_DISCOUNT_PCT ?? 10);
  const discountMult = 1 - Math.max(0, Math.min(100, discountPct)) / 100;

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

    const currency = raw?.currency || raw?.data?.currency || "CHF";

    const candidates =
      raw?.priceDetails || raw?.data?.priceDetails ||
      raw?.prices || raw?.data?.prices ||
      raw?.days || raw?.data?.days ||
      null;

    const nightlySubtotalBase =
      sumFromArray(candidates) ??
      Number(raw?.accommodationTotal) ??
      Number(raw?.data?.accommodationTotal) ??
      Number(raw?.totalPrice) ??
      null;

    if (!Number.isFinite(Number(nightlySubtotalBase))) {
      return json(502, { error: "Could not read nightly subtotal from priceDetails", raw });
    }

    const nightlySubtotalDiscounted = round2(Number(nightlySubtotalBase) * discountMult);
    const perNightDiscounted = nights > 0 ? round2(nightlySubtotalDiscounted / nights) : null;

    return json(200, {
      currency,
      nights,
      breakdown: {
        nightlySubtotal: nightlySubtotalDiscounted,
        nightlySubtotalBase: round2(Number(nightlySubtotalBase)),
        perNight: perNightDiscounted,
        discountPct: round2(discountPct),
      },
    });
  } catch (e) {
    return json(500, { error: "Server error", details: String(e?.message || e) });
  }
};
