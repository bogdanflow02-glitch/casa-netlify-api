import fetch from "node-fetch";

export async function handler(event) {
  try {
    // CORS
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
        body: "",
      };
    }

    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const { arrival, departure, guests } = JSON.parse(event.body || "{}");

    if (!arrival || !departure || !guests) {
      return json(400, { error: "Missing arrival, departure or guests" });
    }

    // ENV VARS
    const ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
    const API_KEY = process.env.HOSTAWAY_API_KEY;
    const LISTING_ID = process.env.HOSTAWAY_LISTING_ID;

    if (!ACCOUNT_ID) return json(500, { error: "Missing HOSTAWAY_ACCOUNT_ID env var" });
    if (!API_KEY) return json(500, { error: "Missing HOSTAWAY_API_KEY env var" });
    if (!LISTING_ID) return json(500, { error: "Missing HOSTAWAY_LISTING_ID env var" });

    // 1️⃣ GET ACCESS TOKEN
    const tokenRes = await fetch("https://api.hostaway.com/v1/accessTokens", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: ACCOUNT_ID,
        client_secret: API_KEY,
        scope: "general",
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return json(500, { error: "Failed to get access token", raw: tokenData });
    }

    const accessToken = tokenData.access_token;

    // 2️⃣ CALL PRICE CALCULATION
    const priceRes = await fetch(
      `https://api.hostaway.com/v1/listings/${LISTING_ID}/calendar/price`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          startDate: arrival,
          endDate: departure,
          numberOfGuests: guests,
          channelId: 2020,
        }),
      }
    );

    const raw = await priceRes.json();

    if (!raw || raw.status !== "success") {
      return json(502, { error: "Hostaway price API failed", raw });
    }

    const result = raw.result;

    // 3️⃣ PARSE COMPONENTS (OVDE JE POPRAVKA)
    const components = result.components || [];

    // nightly subtotal = samo accommodation (bez cleaning fee)
    let nightlySubtotal = components
      .filter((c) => c.type === "accommodation")
      .reduce((sum, c) => sum + Number(c.total || 0), 0);

    if (!nightlySubtotal || !Number.isFinite(nightlySubtotal)) {
      return json(502, { error: "Could not read nightly subtotal from priceDetails", raw });
    }

    // cleaning fee (ako postoji)
    const cleaningFeeObj = components.find((c) => c.name === "cleaningFee");
    const cleaningFee = cleaningFeeObj ? Number(cleaningFeeObj.total || 0) : 0;

    const totalPrice = Number(result.totalPrice || nightlySubtotal + cleaningFee);

    // 4️⃣ RETURN CLEAN RESPONSE FRONTENDU
    return json(200, {
      success: true,
      arrival,
      departure,
      guests,
      nightlySubtotal,
      cleaningFee,
      totalPrice,
    });

  } catch (err) {
    console.error("PRICE FUNCTION ERROR:", err);
    return json(500, { error: "Internal server error", details: err.message });
  }
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  };
}
