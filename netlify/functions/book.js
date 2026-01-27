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

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  const firstName = parts.shift() || "";
  const lastName = parts.join(" ") || "-";
  return { firstName, lastName };
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
    const msg = tokJson?.message || tokJson?.error || "unknown";
    throw new Error(`Token request failed: ${msg}`);
  }

  return tokJson.access_token;
}

async function calcDiscountedPriceDetails({
  accessToken,
  listingId,
  arrival,
  departure,
  guests,
  discountPct,
}) {
  const discount = Math.max(0, Math.min(100, Number(discountPct) || 0));
  const mult = 1 - discount / 100;

  const r = await fetch(
    `${HOSTAWAY_BASE}/v1/listings/${encodeURIComponent(listingId)}/calendar/priceDetails`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        startingDate: arrival,
        endingDate: departure,
        numberOfGuests: Number(guests),
        version: 2,
      }),
    }
  );

  const raw = await r.json().catch(() => ({}));
  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      error: raw?.message || raw?.error || "priceDetails failed",
      raw,
    };
  }

  const totalPriceBase =
    Number(raw?.totalPrice) ||
    Number(raw?.data?.totalPrice) ||
    Number(raw?.result?.totalPrice) ||
    null;

  const financeField =
    raw?.financeField ||
    raw?.data?.financeField ||
    raw?.result?.financeField ||
    null;

  const currency =
    raw?.currency ||
    raw?.data?.currency ||
    raw?.result?.currency ||
    "CHF";

  if (!Number.isFinite(totalPriceBase) || !financeField) {
    return {
      ok: false,
      status: 502,
      error: "Missing totalPrice/financeField in priceDetails response",
      raw,
    };
  }

  const totalPriceDiscounted = round2(totalPriceBase * mult);

  return {
    ok: true,
    currency,
    totalPriceBase: round2(totalPriceBase),
    totalPriceDiscounted,
    financeField,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed. Use POST." });
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const required = ["arrival", "departure", "name", "email", "phone", "guests"];
  for (const f of required) {
    if (!data[f]) return json(400, { error: `Missing field: ${f}` });
  }

  if (!isISODate(data.arrival) || !isISODate(data.departure)) {
    return json(400, { error: "arrival/departure must be YYYY-MM-DD" });
  }

  const start = new Date(`${data.arrival}T00:00:00Z`);
  const end = new Date(`${data.departure}T00:00:00Z`);
  const nights = Math.max(0, Math.round((end - start) / 86400000));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || nights < 1) {
    return json(400, {
      error: "Invalid dates",
      hint: "Departure must be after Arrival (min 1 night).",
    });
  }

  const LISTING_ID = Number(process.env.HOSTAWAY_LISTING_ID);
  const DISCOUNT_PCT = Number(process.env.WEBSITE_DISCOUNT_PCT ?? 10);

  if (!Number.isFinite(LISTING_ID)) {
    return json(500, { error: "Missing/invalid HOSTAWAY_LISTING_ID env var" });
  }

  const guests = Math.max(1, Math.min(10, Number(data.guests) || 1));
  const { firstName, lastName } = splitName(data.name);

  try {
    const accessToken = await getAccessToken();

    const priceCalc = await calcDiscountedPriceDetails({
      accessToken,
      listingId: LISTING_ID,
      arrival: data.arrival,
      departure: data.departure,
      guests,
      discountPct: DISCOUNT_PCT,
    });

    if (!priceCalc.ok) {
      return json(502, {
        error: "Price calculation failed",
        status: priceCalc.status,
        message: priceCalc.error,
        details: priceCalc.raw,
      });
    }

    const channelId = 2020;

    const reservationPayload = {
      channelId,
      listingMapId: LISTING_ID,
      listingId: LISTING_ID,
      source: "website",

      arrivalDate: data.arrival,
      departureDate: data.departure,

      numberOfGuests: guests,

      guestName: data.name,
      guestEmail: data.email,
      guestPhone: data.phone,
      firstName,
      lastName,

      totalPrice: priceCalc.totalPriceDiscounted,
      financeField: priceCalc.financeField,
    };

    const res = await fetch(`${HOSTAWAY_BASE}/v1/reservations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(reservationPayload),
    });

    const result = await res.json().catch(() => ({}));

    if (!res.ok) {
      return json(res.status || 500, {
        error: "Hostaway reservation create failed",
        message: result?.message || result?.error || "Unknown error",
        details: result,
      });
    }

    return json(200, {
      message: "Booking request created (discounted price sent to Hostaway)",
      nights,
      channelId,
      currency: priceCalc.currency,
      totalPriceBase: priceCalc.totalPriceBase,
      totalPriceDiscounted: priceCalc.totalPriceDiscounted,
      hostaway: result,
    });
  } catch (err) {
    return json(500, { error: "Server crash", details: String(err?.message || err) });
  }
};
