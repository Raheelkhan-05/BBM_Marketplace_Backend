// src/services/gst.service.js
//
// Checksum validation stays local (no need to spend an API credit on
// something that's obviously malformed). The actual lookup now hits a
// real provider — gstverify.co.in — instead of the old stub.
//
// NOTE: Vercel's shared outbound IPs get Cloudflare-challenged by this
// provider (403 + cf-mitigated: challenge), even though the exact same
// request works fine from localhost. Routing through a static-IP proxy
// (STATIC_PROXY_URL) fixes this once that IP is allowlisted with the
// provider. Falls back to a direct call if the env var isn't set, so
// this keeps working locally without any proxy.

import { HttpsProxyAgent } from "https-proxy-agent";

const GSTIN_CODES = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const GST_API_BASE = "https://gstverify.co.in/api/v1/verify";
const GST_API_KEY = process.env.GST_VERIFY_API_KEY;
const STATIC_PROXY_URL = process.env.STATIC_PROXY_URL;

const proxyAgent = STATIC_PROXY_URL ? new HttpsProxyAgent(STATIC_PROXY_URL) : null;

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

function parseDMY(str) {
  // "30/11/2017" -> "2017-11-30" for a Postgres date column
  if (!str) return null;
  const [dd, mm, yyyy] = str.split("/");
  if (!dd || !mm || !yyyy) return null;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// Maps the provider's response shape onto business_profiles' columns.
function mapGstResponse(d) {
  return {
    legal_name: d.legal_name || null,
    trade_name: d.trade_name || null,
    gstin_status: d.status || null,
    constitution: d.constitution || null,
    taxpayer_type: d.taxpayer_type || null,
    gst_registration_date: parseDMY(d.registration_date),
    gst_last_updated: parseDMY(d.last_updated),
    state: d.state || null,
    state_code: d.state_code || null,
    pan: d.pan || null,
    registered_address: d.address || null,
    district: d.district || null,
    pincode: d.pincode || null,
    nature_of_business: d.nature_of_business || [],
  };
}

// Real lookup. Returns { verified, mapped, raw } or { verified: false, reason }.
export async function fetchGstinDetails(gstin) {
  if (!GST_API_KEY) {
    console.error("[gst] GST_VERIFY_API_KEY is not set.");
    return {
      verified: false,
      reason: "GST verification isn't configured.",
    };
  }

  try {
    console.log("[gst] Fetching details for:", gstin, proxyAgent ? "(via static proxy)" : "(direct)");

    const res = await fetch(`${GST_API_BASE}/${gstin}`, {
      headers: {
        "X-API-Key": GST_API_KEY,
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      // Node's fetch (undici) accepts a custom dispatcher via this key for
      // proxying. If no proxy is configured, this is simply omitted and
      // the request goes out directly — same behavior as before.
      ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
    });

    console.log("[gst] provider response:", {
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get("content-type"),
      cfMitigated: res.headers.get("cf-mitigated"),
    });

    if (!res.ok) {
      const contentType = res.headers.get("content-type") || "";

      if (res.status === 403) {
        if (res.headers.get("cf-mitigated") === "challenge") {
          console.error("[gst] Provider blocked request with Cloudflare challenge.");
          return {
            verified: false,
            reason: "GST verification provider blocked the request.",
          };
        }

        return {
          verified: false,
          reason: "GST verification provider returned 403 Forbidden.",
        };
      }

      const body = contentType.includes("application/json")
        ? await res.text()
        : "";

      console.error("[gst] Provider HTTP error:", res.status, body.slice(0, 500));

      return {
        verified: false,
        reason: `GST verification provider returned HTTP ${res.status}.`,
      };
    }

    const contentType = res.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      console.error("[gst] Provider returned non-JSON response:", contentType);

      return {
        verified: false,
        reason: "GST verification provider returned an invalid response.",
      };
    }

    const json = await res.json();

    if (!json.success) {
      return {
        verified: false,
        reason: json.message || "GSTIN lookup failed.",
      };
    }

    const mapped = mapGstResponse(json.data);

    return {
      verified: mapped.gstin_status === "Active",
      mapped,
      raw: json.data,
    };
  } catch (e) {
    console.error("[gst] provider request failed:", e);

    return {
      verified: false,
      reason: "Couldn't reach the GST verification service.",
    };
  }
}