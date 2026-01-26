{\rtf1\ansi\ansicpg1252\cocoartf2867
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\froman\fcharset0 Times-Roman;}
{\colortbl;\red255\green255\blue255;\red0\green0\blue0;}
{\*\expandedcolortbl;;\cssrgb\c0\c0\c0;}
\paperw11900\paperh16840\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\deftab720
\pard\pardeftab720\partightenfactor0

\f0\fs24 \cf0 \expnd0\expndtw0\kerning0
\outl0\strokewidth0 \strokec2 // netlify/functions/book.js  (ESM)\
\
const HOSTAWAY_BASE = "https://api.hostaway.com";\
\
const corsHeaders = \{\
  "Access-Control-Allow-Origin": "*",\
  "Access-Control-Allow-Headers": "Content-Type, Authorization",\
  "Access-Control-Allow-Methods": "POST, OPTIONS",\
\};\
\
function json(statusCode, body) \{\
  return \{\
    statusCode,\
    headers: \{ ...corsHeaders, "Content-Type": "application/json; charset=utf-8" \},\
    body: JSON.stringify(body),\
  \};\
\}\
\
function isISODate(s) \{\
  return typeof s === "string" && /^\\d\{4\}-\\d\{2\}-\\d\{2\}$/.test(s);\
\}\
\
function round2(n) \{\
  const x = Number(n);\
  if (!Number.isFinite(x)) return null;\
  return Math.round((x + Number.EPSILON) * 100) / 100;\
\}\
\
function splitName(full) \{\
  const parts = String(full || "").trim().split(/\\s+/).filter(Boolean);\
  const firstName = parts.shift() || "";\
  const lastName = parts.join(" ") || "-";\
  return \{ firstName, lastName \};\
\}\
\
async function getAccessToken() \{\
  const ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;\
  const API_KEY = process.env.HOSTAWAY_API_KEY;\
\
  if (!ACCOUNT_ID || !API_KEY) \{\
    throw new Error("Missing HOSTAWAY_ACCOUNT_ID / HOSTAWAY_API_KEY env vars");\
  \}\
\
  const tokRes = await fetch(`$\{HOSTAWAY_BASE\}/v1/accessTokens`, \{\
    method: "POST",\
    headers: \{ "Content-Type": "application/x-www-form-urlencoded" \},\
    body: new URLSearchParams(\{\
      grant_type: "client_credentials",\
      client_id: ACCOUNT_ID,\
      client_secret: API_KEY,\
      scope: "general",\
    \}),\
  \});\
\
  const tokJson = await tokRes.json().catch(() => (\{\}));\
  if (!tokRes.ok || !tokJson?.access_token) \{\
    const msg = tokJson?.message || tokJson?.error || "unknown";\
    throw new Error(`Token request failed: $\{msg\}`);\
  \}\
\
  return tokJson.access_token;\
\}\
\
/**\
 * Get Hostaway priceDetails (totalPrice + financeField),\
 * then apply website discount to totalPrice.\
 *\
 * IMPORTANT:\
 * - We send discounted totalPrice into reservation create.\
 * - financeField is passed through as-is (Hostaway expects this structure).\
 */\
async function calcDiscountedPriceDetails(\{\
  accessToken,\
  listingId,\
  arrival,\
  departure,\
  guests,\
  discountPct,\
\}) \{\
  const discount = Math.max(0, Math.min(100, Number(discountPct) || 0));\
  const mult = 1 - discount / 100;\
\
  const r = await fetch(\
    `$\{HOSTAWAY_BASE\}/v1/listings/$\{encodeURIComponent(listingId)\}/calendar/priceDetails`,\
    \{\
      method: "POST",\
      headers: \{\
        "Content-Type": "application/json",\
        Authorization: `Bearer $\{accessToken\}`,\
      \},\
      body: JSON.stringify(\{\
        startingDate: arrival,\
        endingDate: departure,\
        numberOfGuests: Number(guests),\
        version: 2,\
      \}),\
    \}\
  );\
\
  const raw = await r.json().catch(() => (\{\}));\
  if (!r.ok) \{\
    return \{\
      ok: false,\
      status: r.status,\
      error: raw?.message || raw?.error || "priceDetails failed",\
      raw,\
    \};\
  \}\
\
  const totalPriceBase =\
    Number(raw?.totalPrice) ||\
    Number(raw?.data?.totalPrice) ||\
    Number(raw?.result?.totalPrice) ||\
    null;\
\
  const financeField =\
    raw?.financeField ||\
    raw?.data?.financeField ||\
    raw?.result?.financeField ||\
    null;\
\
  const currency =\
    raw?.currency ||\
    raw?.data?.currency ||\
    raw?.result?.currency ||\
    "CHF";\
\
  if (!Number.isFinite(totalPriceBase) || !financeField) \{\
    return \{\
      ok: false,\
      status: 502,\
      error: "Missing totalPrice/financeField in priceDetails response",\
      raw,\
    \};\
  \}\
\
  const totalPriceDiscounted = round2(totalPriceBase * mult);\
\
  return \{\
    ok: true,\
    currency,\
    totalPriceBase: round2(totalPriceBase),\
    totalPriceDiscounted,\
    financeField,\
    raw, // keep for debugging (you can remove later)\
  \};\
\}\
\
export async function handler(event) \{\
  if (event.httpMethod === "OPTIONS") \{\
    return \{ statusCode: 204, headers: corsHeaders, body: "" \};\
  \}\
  if (event.httpMethod !== "POST") \{\
    return json(405, \{ error: "Method not allowed. Use POST." \});\
  \}\
\
  let data;\
  try \{\
    data = JSON.parse(event.body || "\{\}");\
  \} catch \{\
    return json(400, \{ error: "Invalid JSON body" \});\
  \}\
\
  // ---- Required fields ----\
  const required = ["arrival", "departure", "name", "email", "phone", "guests"];\
  for (const f of required) \{\
    if (!data[f]) return json(400, \{ error: `Missing field: $\{f\}` \});\
  \}\
\
  // ---- Validate dates ----\
  if (!isISODate(data.arrival) || !isISODate(data.departure)) \{\
    return json(400, \{ error: "arrival/departure must be YYYY-MM-DD" \});\
  \}\
\
  const start = new Date(`$\{data.arrival\}T00:00:00Z`);\
  const end = new Date(`$\{data.departure\}T00:00:00Z`);\
  const nights = Math.max(0, Math.round((end - start) / 86400000));\
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || nights < 1) \{\
    return json(400, \{\
      error: "Invalid dates",\
      hint: "Departure must be after Arrival (min 1 night).",\
    \});\
  \}\
\
  // ---- ENV ----\
  const LISTING_ID = Number(process.env.HOSTAWAY_LISTING_ID);\
  const DISCOUNT_PCT = Number(process.env.WEBSITE_DISCOUNT_PCT ?? 10);\
\
  if (!Number.isFinite(LISTING_ID)) \{\
    return json(500, \{ error: "Missing/invalid HOSTAWAY_LISTING_ID env var" \});\
  \}\
\
  const guests = Math.max(1, Math.min(10, Number(data.guests) || 1));\
  const \{ firstName, lastName \} = splitName(data.name);\
\
  try \{\
    // 1) Token\
    const accessToken = await getAccessToken();\
\
    // 2) (Optional but useful) Verify listing exists\
    //    If you want faster execution, you can remove this block.\
    const listRes = await fetch(`$\{HOSTAWAY_BASE\}/v1/listings/$\{LISTING_ID\}`, \{\
      method: "GET",\
      headers: \{ Authorization: `Bearer $\{accessToken\}` \},\
    \});\
    if (!listRes.ok) \{\
      const listJson = await listRes.json().catch(() => (\{\}));\
      return json(400, \{\
        error: "Listing verification failed",\
        listingIdWeUsed: LISTING_ID,\
        details: listJson,\
      \});\
    \}\
\
    // 3) Calculate priceDetails then apply discount (server-side)\
    const priceCalc = await calcDiscountedPriceDetails(\{\
      accessToken,\
      listingId: LISTING_ID,\
      arrival: data.arrival,\
      departure: data.departure,\
      guests,\
      discountPct: DISCOUNT_PCT,\
    \});\
\
    if (!priceCalc.ok) \{\
      return json(502, \{\
        error: "Price calculation failed",\
        status: priceCalc.status,\
        message: priceCalc.error,\
        details: priceCalc.raw,\
      \});\
    \}\
\
    // 4) Create reservation\
    //    Use channelId 2020 (partner/website)\
    const channelId = 2020;\
\
    const reservationPayload = \{\
      channelId,\
      listingMapId: LISTING_ID, // common field used in Hostaway examples\
      listingId: LISTING_ID,    // include also; harmless\
      source: "website",\
\
      // IMPORTANT: correct reservation date fields\
      arrivalDate: data.arrival,\
      departureDate: data.departure,\
\
      numberOfGuests: guests,\
\
      guestName: data.name,\
      guestEmail: data.email,\
      guestPhone: data.phone,\
      firstName,\
      lastName,\
\
      // IMPORTANT: send discounted price into Hostaway\
      totalPrice: priceCalc.totalPriceDiscounted,\
      financeField: priceCalc.financeField,\
    \};\
\
    const res = await fetch(`$\{HOSTAWAY_BASE\}/v1/reservations`, \{\
      method: "POST",\
      headers: \{\
        "Content-Type": "application/json",\
        Authorization: `Bearer $\{accessToken\}`,\
      \},\
      body: JSON.stringify(reservationPayload),\
    \});\
\
    const result = await res.json().catch(() => (\{\}));\
\
    if (!res.ok) \{\
      return json(res.status || 500, \{\
        error: "Hostaway reservation create failed",\
        message: result?.message || result?.error || "Unknown error",\
        details: result,\
        sent: \{\
          channelId,\
          listingId: LISTING_ID,\
          arrivalDate: reservationPayload.arrivalDate,\
          departureDate: reservationPayload.departureDate,\
          totalPrice: reservationPayload.totalPrice,\
          hasFinanceField: !!reservationPayload.financeField,\
        \},\
      \});\
    \}\
\
    return json(200, \{\
      message: "Booking request created (discounted price sent to Hostaway)",\
      nights,\
      channelId,\
      currency: priceCalc.currency,\
      totalPriceBase: priceCalc.totalPriceBase,\
      totalPriceDiscounted: priceCalc.totalPriceDiscounted,\
      hostaway: result,\
    \});\
  \} catch (err) \{\
    return json(500, \{ error: "Server crash", details: String(err?.message || err) \});\
  \}\
\}\
}