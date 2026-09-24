// src/services/gst.service.js
//
// Checksum validation stays local (no need to spend an API credit on
// something that's obviously malformed).
//
// Lookup order:
//   1. gstverify.co.in   (primary)
//   2. gstinapi.in       (fallback, only when the primary is unavailable —
//                         Cloudflare block, 5xx, 429, bad key, timeout, etc.)
//
// A genuine "this GSTIN doesn't exist / lookup failed" answer from the
// primary is returned as-is and does NOT trigger the fallback, so we don't
// burn a second API credit on something that will fail the same way.

const GSTIN_CODES = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

// const GSTVERIFY_BASE = "https://gstverify.co.in/api/v1/verify";
const GSTVERIFY_BASE = "https://gstin.cloud/api/v1/verify";
const GSTVERIFY_KEY = process.env.GST_VERIFY_API_KEY;

const GSTINAPI_BASE = "https://www.gstinapi.in/v1/gstin";
const GSTINAPI_KEY = process.env.GSTINAPI_API_KEY;

const REQUEST_TIMEOUT_MS = 8000;

// Best-effort in-memory cache. On Vercel this only survives while a function
// instance is warm, so it's a bonus (it avoids the second call that
// completeProfile makes right after lookupGstin), not a guarantee. For a real
// cache, store the verified result in your DB keyed by GSTIN.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

function cacheGet(gstin) {
  const hit = cache.get(gstin);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(gstin);
    return null;
  }
  return hit.value;
}
function cacheSet(gstin, value) {
  cache.set(gstin, { at: Date.now(), value });
}

// GST state codes -> state names (gstinapi.in doesn't always return the name).
const STATE_NAMES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan",
  "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh",
  "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura",
  "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand",
  "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "25": "Daman and Diu", "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep",
  "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh",
  "38": "Ladakh", "97": "Other Territory", "99": "Centre Jurisdiction",
};

export function isValidGSTINFormat(gstin) {
  return GSTIN_FORMAT.test(gstin);
}

export function isValidGSTINChecksum(gstin) {
  if (gstin.length !== 15) return false;
  const chars = gstin.split("");
  const checkChar = chars.pop();
  let factor = 2;
  let sum = 0;
  const mod = GSTIN_CODES.length;

  for (let i = chars.length - 1; i >= 0; i--) {
    const codePoint = GSTIN_CODES.indexOf(chars[i]);
    if (codePoint === -1) return false;
    let digit = factor * codePoint;
    digit = Math.floor(digit / mod) + (digit % mod);
    sum += digit;
    factor = factor === 2 ? 1 : 2;
  }

  const checkCodePoint = (mod - (sum % mod)) % mod;
  return GSTIN_CODES[checkCodePoint] === checkChar;
}

export function validateGSTIN(rawValue) {
  const gstin = (rawValue || "").trim().toUpperCase();
  if (gstin.length !== 15) return { valid: false, reason: "GSTIN must be 15 characters." };
  if (!isValidGSTINFormat(gstin)) return { valid: false, reason: "GSTIN format is invalid." };
  if (!isValidGSTINChecksum(gstin)) return { valid: false, reason: "GSTIN checksum failed — check for a typo." };
  return { valid: true, gstin };
}

// Accepts "30/11/2017" (GSTVerify) or "2017-11-30" (gstinapi.in) and returns
// "2017-11-30" for a Postgres date column.
function parseDate(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const [dd, mm, yyyy] = str.split("/");
  if (!dd || !mm || !yyyy) return null;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// --- Provider 1: GSTVerify response -> business_profiles columns ----------
function mapGstVerifyResponse(d) {
  return {
    legal_name: d.legal_name || null,
    trade_name: d.trade_name || null,
    gstin_status: d.status || null,
    constitution: d.constitution || null,
    taxpayer_type: d.taxpayer_type || null,
    gst_registration_date: parseDate(d.registration_date),
    gst_last_updated: parseDate(d.last_updated),
    state: d.state || null,
    state_code: d.state_code || null,
    pan: d.pan || null,
    registered_address: d.address || null,
    district: d.district || null,
    pincode: d.pincode || null,
    nature_of_business: d.nature_of_business || [],
  };
}

// --- Provider 2: gstinapi.in response -> business_profiles columns --------
function mapGstinApiResponse(d, gstin) {
  const ad = d.address_details || {};
  const stateCode = d.state_code || gstin.slice(0, 2);
  const nob = d.nature_of_business;
  return {
    legal_name: d.legal_name || null,
    trade_name: d.trade_name || null,
    gstin_status: d.status || null,
    constitution: d.business_constitution || null,
    taxpayer_type: d.taxpayer_type || null,
    gst_registration_date: parseDate(d.registration_date),
    gst_last_updated: null, // not provided by this API
    state: ad.state || STATE_NAMES[stateCode] || null,
    state_code: stateCode || null,
    pan: gstin.slice(2, 12), // PAN is embedded in characters 3-12 of the GSTIN
    registered_address: d.address || null,
    district: ad.district || null,
    pincode: d.pincode || ad.pincode || null,
    nature_of_business: Array.isArray(nob) ? nob : nob ? [nob] : [],
  };
}

async function readJson(res) {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// providerError = true  -> the provider itself is unavailable/blocked; safe to
//                          try another provider and to show a "temporarily
//                          unavailable" message (HTTP 502/503 in the controller).
// providerError = false -> the provider answered and said this lookup failed.
const providerDown = (reason) => ({ verified: false, reason, providerError: true });
const lookupFailed = (reason) => ({ verified: false, reason, providerError: false });

async function fetchFromGstVerify(gstin) {
  if (!GSTVERIFY_KEY) {
    console.error("[gst:gstverify] GST_VERIFY_API_KEY is not set.");
    return providerDown("GST verification isn't configured.");
  }

  try {
    console.log("[gst:gstverify] Fetching details for:", gstin);

    const res = await fetch(`${GSTVERIFY_BASE}/${gstin}`, {
      headers: {
        "X-API-Key": GSTVERIFY_KEY,
        Accept: "application/json",
        "User-Agent": "bbm-backend/1.0",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    console.log("[gst:gstverify] provider response:", {
      status: res.status,
      contentType: res.headers.get("content-type"),
      cfMitigated: res.headers.get("cf-mitigated"),
      cfRay: res.headers.get("cf-ray"), // give this to the provider's support
    });

    if (!res.ok) {
      if (res.status === 403 && res.headers.get("cf-mitigated") === "challenge") {
        console.error("[gst:gstverify] Blocked by Cloudflare challenge.");
        return providerDown("GST verification provider blocked the request.");
      }
      const body = (await res.text().catch(() => "")).slice(0, 300);
      console.error("[gst:gstverify] HTTP error:", res.status, body);
      return providerDown(`GST verification provider returned HTTP ${res.status}.`);
    }

    const json = await readJson(res);
    if (!json) {
      console.error("[gst:gstverify] Non-JSON response.");
      return providerDown("GST verification provider returned an invalid response.");
    }

    if (!json.success) {
      return lookupFailed(json.message || "GSTIN lookup failed.");
    }

    const mapped = mapGstVerifyResponse(json.data);
    return { verified: mapped.gstin_status === "Active", mapped, raw: json.data, source: "gstverify" };
  } catch (e) {
    console.error("[gst:gstverify] request failed:", e);
    return providerDown("Couldn't reach the GST verification service.");
  }
}

// gstinapi.in often returns district as null. Best-effort lookup from the
// pincode via India Post's public API. Never throws and never blocks the
// verification: on any failure we just leave district null.
async function districtFromPincode(pincode) {
  if (!pincode || !/^\d{6}$/.test(pincode)) return null;
  try {
    const res = await fetch(`https://api.postalpincode.in/pincode/${pincode}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const office = json?.[0]?.PostOffice?.[0];
    return office?.District || null;
  } catch (e) {
    console.warn("[gst] pincode->district lookup failed:", e.message);
    return null;
  }
}

async function fetchFromGstinApi(gstin) {
  if (!GSTINAPI_KEY) {
    console.error("[gst:gstinapi] GSTINAPI_API_KEY is not set.");
    return providerDown("Backup GST verification isn't configured.");
  }

  try {
    console.log("[gst:gstinapi] Fetching details for:", gstin);

    const res = await fetch(`${GSTINAPI_BASE}/${gstin}`, {
      headers: {
        "x-api-key": GSTINAPI_KEY,
        Accept: "application/json",
        "User-Agent": "bbm-backend/1.0",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    console.log("[gst:gstinapi] provider response:", {
      status: res.status,
      contentType: res.headers.get("content-type"),
      cfMitigated: res.headers.get("cf-mitigated"),
    });

    const json = await readJson(res);

    if (!res.ok) {
      // 400 / 404 = the API understood the request and says the GSTIN can't
      // be verified. Everything else (401 bad key, 402 out of credits,
      // 403, 429, 5xx) is a provider/account problem, not the user's fault.
      if (res.status === 400 || res.status === 404) {
        return lookupFailed(json?.message || json?.error || "GSTIN lookup failed.");
      }
      console.error("[gst:gstinapi] HTTP error:", res.status, JSON.stringify(json)?.slice(0, 300));
      return providerDown(`Backup GST verification returned HTTP ${res.status}.`);
    }

    if (!json) return providerDown("Backup GST verification returned an invalid response.");
    if (!json.success || !json.data) {
      return lookupFailed(json.message || json.error || "GSTIN lookup failed.");
    }

    if (typeof json.credits_remaining === "number" && json.credits_remaining < 50) {
      console.warn("[gst:gstinapi] Low credits remaining:", json.credits_remaining);
    }

    const mapped = mapGstinApiResponse(json.data, gstin);
    if (!mapped.district) {
      mapped.district = await districtFromPincode(mapped.pincode);
    }
    return { verified: mapped.gstin_status === "Active", mapped, raw: json.data, source: "gstinapi" };
  } catch (e) {
    console.error("[gst:gstinapi] request failed:", e);
    return providerDown("Couldn't reach the backup GST verification service.");
  }
}

// Public entry point. Returns { verified, mapped, raw, source } on success or
// { verified: false, reason, providerError } on failure.
export async function fetchGstinDetails(gstin) {
  const cached = cacheGet(gstin);
  if (cached) {
    console.log("[gst] cache hit for:", gstin);
    return cached;
  }

  const primary = await fetchFromGstVerify(gstin);
  if (primary.mapped) {
    cacheSet(gstin, primary);
    return primary;
  }
  // Provider answered "lookup failed" -> don't spend a second credit.
  if (!primary.providerError) return primary;

  console.warn("[gst] Primary provider unavailable (%s), trying fallback.", primary.reason);

  const fallback = await fetchFromGstinApi(gstin);
  if (fallback.mapped) {
    cacheSet(gstin, fallback);
    return fallback;
  }
  if (!fallback.providerError) return fallback;

  // Both providers are down.
  return providerDown("GST verification is temporarily unavailable. Please try again in a few minutes.");
}