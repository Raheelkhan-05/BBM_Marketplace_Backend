// src/services/twoFactor.service.js
//
// Wraps 2Factor.in's SMS OTP API (https://2factor.in/CP/Dashboard_list.php).
// 2Factor generates + stores the OTP server-side, so we don't need our own
// otp_hash / expiry table for phone verification — just track the returned
// "Session Id" per (user, phone) until it's verified.
//
// Required env vars:
//   TWOFACTOR_API_KEY        - your 2Factor API key
//   TWOFACTOR_OTP_TEMPLATE   - the approved template name from the dashboard
// Optional:
//   TWOFACTOR_BASE_URL       - defaults to https://2factor.in/API/V1

const TWOFACTOR_BASE_URL = process.env.TWOFACTOR_BASE_URL || "https://2factor.in/API/V1";
const TWOFACTOR_API_KEY = process.env.TWOFACTOR_API_KEY;
const TWOFACTOR_OTP_TEMPLATE = process.env.TWOFACTOR_OTP_TEMPLATE;

function assertConfigured() {
  if (!TWOFACTOR_API_KEY || !TWOFACTOR_OTP_TEMPLATE) {
    throw new Error(
      "[twoFactor.service] TWOFACTOR_API_KEY / TWOFACTOR_OTP_TEMPLATE not set."
    );
  }
}

// 2Factor expects a 10-digit Indian number, no country code, no leading 0.
function normalizeIndianNumber(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  throw new Error(`[twoFactor.service] Unrecognized phone format: ${phone}`);
}

/**
 * Triggers a 6-digit OTP SMS via 2Factor's AUTOGEN2 endpoint and returns
 * their Session Id. AUTOGEN2 is fixed at 6 digits — there is no length
 * parameter in the URL (unlike what we assumed earlier).
 *
 * @param {string} phone - 10-digit Indian mobile number.
 * @returns {Promise<string>} sessionId
 */
export async function sendOtp(phone) {
  assertConfigured();
  const number = normalizeIndianNumber(phone);

  const url = `${TWOFACTOR_BASE_URL}/${TWOFACTOR_API_KEY}/SMS/${number}/AUTOGEN2/${TWOFACTOR_OTP_TEMPLATE}`;
  const res = await fetch(url);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`[twoFactor.service] Non-JSON response (status ${res.status})`);
  }

  if (data.Status !== "Success") {
    throw new Error(`[twoFactor.service] Send failed: ${data.Details || JSON.stringify(data)}`);
  }

  console.log(data);

  // Note: data.OTP is also returned by AUTOGEN2, but we deliberately don't
  // use or log it — verification should go through verifyOtp()/2Factor's
  // session check, not a value we'd have to store ourselves.
  return data.Details; // Session Id
}


/**
 * Verifies a user-entered OTP against a 2Factor session.
 *
 * @param {string} sessionId - returned from sendOtp().
 * @param {string} otp - the code the user typed in.
 * @returns {Promise<boolean>}
 */
export async function verifyOtp(sessionId, otp) {
  assertConfigured();

  const url = `${TWOFACTOR_BASE_URL}/${TWOFACTOR_API_KEY}/SMS/VERIFY/${sessionId}/${otp}`;
  const res = await fetch(url);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`[twoFactor.service] Non-JSON response (status ${res.status})`);
  }

  // 2Factor returns Status "Success" + Details "OTP Matched" on success,
  // and Status "Error" (with a message) on mismatch/expiry.
  return data.Status === "Success";
}