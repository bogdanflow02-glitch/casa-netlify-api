// netlify/functions/channels.js (ESM) — READ ONLY (PROBE)
// Tries multiple possible Hostaway endpoints to list channels.
// Returns the first successful response.

const HOSTAWAY_BASE = "https://api.hostaway.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
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

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return json(405, { error: "Method not allowed. Use GET." });
  }

  try {
    const token = await getAccessToken();

    const candidates = [
      "/v1/channels",
      "/v1/channel",
      "/v1/reservationChannels",
      "/v1/reservationChannel",
      "/v1/bookingChannels",
      "/v1/bookingChannel",
      "/v1/integrations/channels",
      "/v1/channels/list",
    ];

    const attempts = [];

    for (const path of candidates) {
      const url = `${HOSTAWAY_BASE}${path}`;
      const r = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });

      const raw = await r.json().catch(() => ({}));
      attempts.push({
        path,
        ok: r.ok,
        status: r.status,
        message: raw?.message || raw?.error || null,
      });

      if (!r.ok) continue;

      const result = raw?.result || raw?.data?.result || raw?.data || raw;

      return json(200, {
        ok: true,
        workingEndpoint: path,
        // Try to expose some likely shapes
        result,
        attempts,
      });
    }

    return json(502, {
      ok: false,
      error: "No known channels endpoint worked with this token/scope.",
      attempts,
      hint:
        "This usually means: endpoint name differs for your account, or token scope lacks permission. Ask Hostaway support which exact endpoint + scope returns channel ids for your account.",
    });
  } catch (e) {
    return json(500, { error: "Server error", details: String(e?.message || e) });
  }
}
