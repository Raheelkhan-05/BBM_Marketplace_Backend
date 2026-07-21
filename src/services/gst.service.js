// src/services/gst.service.js
//
// Same algorithm as the frontend's utils/validators.js — duplicated here
// deliberately, because client-side validation is a UX nicety, not a
// security boundary. This is the copy that actually matters.

const GSTIN_CODES = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

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

// Real registration-status + legal-name lookup requires a KYC provider
// (Surepass, Karza, Signzy) or government API Setu access — the GST
// portal itself has no simple public API. Wire the provider call in here;
// keep the function signature the same so callers don't need to change.
export async function lookupGstinWithProvider(gstin) {
  // Example shape once wired to a real provider:
  // const res = await fetch("https://provider.example.com/v1/gstin/verify", {
  //   method: "POST",
  //   headers: { Authorization: `Bearer ${process.env.GST_PROVIDER_KEY}` },
  //   body: JSON.stringify({ gstin }),
  // });
  // const data = await res.json();
  // return { verified: data.status === "Active", legalName: data.legalName };

  return { verified: null, legalName: null }; // not wired yet — see BACKEND_GUIDE.md
}