// netlify/functions/channels.js (ESM) — READ ONLY
// Lists Hostaway channels so you can find the "direct booking / website" channelId.

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
    throw new Error(
      `Token request failed: ${tokJson?.message || tokJson?.error || "unknown"}`
    );
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

    const r = await fetch(`${HOSTAWAY_BASE}/v1/channels`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const raw = await r.json().catch(() => ({}));

    if (!r.ok) {
      return json(r.status || 500, {
        error: "Hostaway /v1/channels failed",
        message: raw?.message || raw?.error || "unknown",
        details: raw,
      });
    }

    // Hostaway usually returns { status:"success", result:[...] }
    const result = raw?.result || raw?.data?.result || raw?.data || raw;
    const channels = Array.isArray(result) ? result : Array.isArray(result?.channels) ? result.channels : null;

    if (!Array.isArray(channels)) {
      return json(502, { error: "Unexpected channels response shape", raw });
    }

    // Return a compact list + full raw list for debugging
    const compact = channels.map((c) => ({
      id: c.id ?? c.channelId ?? c.channel_id ?? null,
      name: c.name ?? c.channelName ?? null,
      type: c.type ?? c.channelType ?? null,
      isActive: c.isActive ?? c.active ?? null,
      raw: c, // keep full object (helpful once, remove later if you want)
    }));

    return json(200, {
      count: compact.length,
      channels: compact,
      // raw, // uncomment if you want everything
    });
  } catch (e) {
    return json(500, { error: "Server error", details: String(e?.message || e) });
  }
}
