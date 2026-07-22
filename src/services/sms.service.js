// src/services/sms.service.js
//
// Sends OTP messages via Textlocal's SMS API.
// Docs: https://api.textlocal.in/send/
//
// Required env vars:
//   TEXTLOCAL_API_KEY   - your Textlocal API key
//   TEXTLOCAL_SENDER    - approved 6-char sender ID (e.g. TXTLCL)
// Optional:
//   TEXTLOCAL_BASE_URL  - defaults to https://api.textlocal.in/send/

const TEXTLOCAL_BASE_URL = process.env.TEXTLOCAL_BASE_URL || "https://api.textlocal.in/send/";
const TEXTLOCAL_API_KEY = process.env.TEXTLOCAL_API_KEY;
const TEXTLOCAL_SENDER = process.env.TEXTLOCAL_SENDER;

function assertConfigured() {
  if (!TEXTLOCAL_API_KEY || !TEXTLOCAL_SENDER) {
    throw new Error(
      "[sms.service] TEXTLOCAL_API_KEY / TEXTLOCAL_SENDER not set — cannot send SMS."
    );
  }
}

// Textlocal expects Indian 10-digit numbers, no country code, no leading 0.
function normalizeIndianNumber(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  throw new Error(`[sms.service] Unrecognized phone format: ${phone}`);
}

/**
 * Sends an OTP via SMS through Textlocal.
 * @param {string} phone - 10-digit Indian mobile number (any common format in).
 * @param {string} otp - the numeric code to send.
 */
export async function sendOtpSms(phone, otp) {
  assertConfigured();
  const number = normalizeIndianNumber(phone);
  const message = `Your verification code is ${otp}. It expires in 5 minutes. Do not share this code with anyone.`;

  const params = new URLSearchParams({
    apikey: TEXTLOCAL_API_KEY,
    numbers: number,
    sender: TEXTLOCAL_SENDER,
    message,
  });

  const res = await fetch(TEXTLOCAL_BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`[sms.service] Non-JSON response from Textlocal (status ${res.status})`);
  }

  if (data.status !== "success") {
    const reason = data.errors?.[0]?.message || JSON.stringify(data);
    throw new Error(`[sms.service] Textlocal send failed: ${reason}`);
  }

  return data;
}

/**
 * Placeholder for WhatsApp delivery.
 *
 * Textlocal's plain SMS API cannot send WhatsApp messages — WhatsApp requires
 * their separate WhatsApp Business API product, pre-approved message
 * templates (Meta requirement), and a different endpoint/auth flow.
 *
 * If/when that's set up, implement it here with the same (phone, otp)
 * signature so callers don't need to change, e.g.:
 *
 *   export async function sendOtpWhatsapp(phone, otp) {
 *     // POST to Textlocal's WhatsApp endpoint with your approved
 *     // "otp_verification" template name + params: [otp]
 *   }
 */
export async function sendOtpWhatsapp(phone, otp) {
  throw new Error(
    "[sms.service] WhatsApp OTP not implemented — requires Textlocal's WhatsApp Business API " +
    "with an approved message template. Falling back to SMS is recommended for now."
  );
}