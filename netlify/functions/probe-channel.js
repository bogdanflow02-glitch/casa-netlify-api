// netlify/functions/probe-channel.js (ESM) — READ ONLY
// Brute-force probe: tries a list of channelIds for priceDetails and shows which one applies the -10% markup.

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

async function fetchPriceDetails({ token, listingId, arrival, departure, guests, channelId }) {
  const payload = {
    startingDate: arrival,
    endingDate: departure,
    numberOfGuests: guests,
    version: 2,
    ...(Number.isFinite(channelId) ? { channelId } : {}),
  };

  const r = await fetch(
    `${HOSTAWAY_BASE}/v1/listings/${encodeURIComponent(listingId)}/calendar/priceDetails`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    }
  );

  const raw = await r.json().catch(() => ({}));
  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      message: raw?.message || raw?.error || "unknown",
      payloadSent: payload,
      raw,
    };
  }

  const result = raw?.result || raw?.data?.result || raw?.data || raw;
  const components = result?.components;

  if (!Array.isArray(components)) {
    return {
      ok: false,
      status: 502,
      message: "Missing components[] in response",
      payloadSent: payload,
      raw,
    };
  }

  // Same logic you use in price.js:
  // - accommodation (expected to include markup if channel is correct)
  // - include all other components except "discount"
  const accommodationTotal = sumTotals(components, (c) => c.type === "accommodation");
  const otherIncludedTotal = sumTotals(components, (c) => c.type !== "accommodation" && c.type !== "discount");
  const total = round2(accommodationTotal + otherIncludedTotal);

  return {
    ok: true,
    currency: result?.currency || raw?.currency || "CHF",
    payloadSent: payload,
    accommodationSubtotal: round2(accommodationTotal),
    otherIncludedTotal: round2(otherIncludedTotal),
    totalPrice: total,
    components,
  };
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

  // Default candidate list (small & practical)
  // You can override by sending { channelIds: [ ... ] } in request body.
  const defaultCandidates = [2013, 2020, 2000, 2001, 2002, 2003, 2004, 2005];

  const channelIds = Array.isArray(data.channelIds) && data.channelIds.length
    ? data.channelIds.map(Number).filter((n) => Number.isFinite(n)).slice(0, 12)
    : defaultCandidates;

  try {
    const token = await getAccessToken();

    // Baseline: no channelId
    const baseline = await fetchPriceDetails({
      token,
      listingId: LISTING_ID,
      arrival,
      departure,
      guests,
      channelId: NaN,
    });

    // Probe candidates
    const results = [];
    for (const id of channelIds) {
      const r = await fetchPriceDetails({
        token,
        listingId: LISTING_ID,
        arrival,
        departure,
        guests,
        channelId: id,
      });
      results.push({ channelId: id, ...r });
    }

    // Sort: lowest accommodationSubtotal first (that likely means markup applied)
    const sortable = results
      .filter((r) => r.ok)
      .sort((a, b) => (a.accommodationSubtotal ?? Infinity) - (b.accommodationSubtotal ?? Infinity));

    const best = sortable[0] || null;

    return json(200, {
      listingId: String(LISTING_ID),
      nights,
      guests,
      arrival,
      departure,
      baseline,
      probedCount: channelIds.length,
      results,
      bestGuess: best ? {
        channelId: best.channelId,
        accommodationSubtotal: best.accommodationSubtotal,
        otherIncludedTotal: best.otherIncludedTotal,
        totalPrice: best.totalPrice,
        currency: best.currency,
      } : null,
      note:
        "If any channelId applies your -10 markup, you should see accommodationSubtotal drop vs baseline.",
    });
  } catch (e) {
    return json(500, { error: "Server error", details: String(e?.message || e) });
  }
}
