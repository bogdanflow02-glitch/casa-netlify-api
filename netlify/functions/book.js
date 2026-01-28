// netlify/functions/book.js  (CommonJS, Node 18+ / Netlify)
// Hostaway-driven pricing: we DO NOT apply any extra discount here.
// We use Hostaway priceDetails.totalPrice (already includes Hostaway discounts like weekly/monthly)
// and pass financeField through to the reservation create.

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

/**
 * Fetch Hostaway priceDetails for the selected dates.
 * IMPORTANT:
 * - totalPrice returned here already includes Hostaway discounts (weekly/monthly/etc) if configured.
 * - financeField must be passed through unchanged when creating reservation.
 */
async function getHostawayPriceDetails({
  accessToken,
  listingId,
  arrival,
  departure,
  guests,
}) {
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

  // Your observed shape: { status:"success", result:{ totalPrice, components, ... } }
  const result = raw?.result || raw?.data?.result || raw?.data || raw;

  const totalPrice =
    Number(result?.totalPrice) ??
    Number(raw?.totalPrice) ??
    Number(raw?.data?.totalPrice) ??
    null;

  const financeField =
    result?.financeField ||
    raw?.financeField ||
    raw?.data?.financeField ||
    null;

  const currency =
    result?.currency ||
    raw?.currency ||
    raw?.data?.currency ||
    "CHF";

  if (!Number.isFinite(totalPrice) || !financeField) {
    return {
      ok: false,
      status: 502,
      error: "Missing totalPrice/financeField in priceDetails response",
      raw,
    };
  }

  return {
    ok: true,
    currency,
    totalPrice: round2(totalPrice), // Hostaway-calculated total (incl. Hostaway discounts)
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

  // Required fields
  const required = ["arrival", "departure", "name", "email", "phone", "guests"];
  for (const f of required) {
    if (!data[f]) return json(400, { error: `Missing field: ${f}` });
  }

  // Validate dates
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

  // ENV
  const LISTING_ID = Number(process.env.HOSTAWAY_LISTING_ID);
  if (!Number.isFinite(LISTING_ID)) {
    return json(500, { error: "Missing/invalid HOSTAWAY_LISTING_ID env var" });
  }

  const guests = Math.max(1, Math.min(10, Number(data.guests) || 1));
  const { firstName, lastName } = splitName(data.name);

  try {
    // 1) Token
    const accessToken = await getAccessToken();

    // 2) Get Hostaway priceDetails (includes Hostaway discounts)
    const priceCalc = await getHostawayPriceDetails({
      accessToken,
      listingId: LISTING_ID,
      arrival: data.arrival,
      departure: data.departure,
      guests,
    });

    if (!priceCalc.ok) {
      return json(502, {
        error: "Price calculation failed",
        status: priceCalc.status,
        message: priceCalc.error,
        details: priceCalc.raw,
      });
    }

    // 3) Create reservation
    const channelId = 2020; // partner/website

    const reservationPayload = {
      channelId,
      listingMapId: LISTING_ID,
      listingId: LISTING_ID,
      source: "website",

      // IMPORTANT: reservation date fields (not startDate/endDate)
      arrivalDate: data.arrival,
      departureDate: data.departure,

      numberOfGuests: guests,

      guestName: data.name,
      guestEmail: data.email,
      guestPhone: data.phone,
      firstName,
      lastName,

      // ✅ Hostaway-driven amount + financeField
      totalPrice: priceCalc.totalPrice,
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
      message: "Booking request created (Hostaway-driven total sent to Hostaway)",
      nights,
      channelId,
      currency: priceCalc.currency,
      totalPriceSentToHostaway: priceCalc.totalPrice,
      hostaway: result,
    });
  } catch (err) {
    return json(500, { error: "Server crash", details: String(err?.message || err) });
  }
};
