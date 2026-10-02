// src/services/otp.service.js
import crypto from "crypto";
import { supabaseAdmin } from "../config/supabase.js";
import { sendOtp as sendPhoneOtpViaTwoFactor, verifyOtp as verifyTwoFactorSession } from "./twoFactor.service.js";
import { sendOtpViaMapthrust } from "./mapthrust.service.js";
import { sendOtpViaStartMessaging } from "./startMessaging.service.js";
import { sendOtpEmail } from "./mail.service.js";

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_TTL_MIN = OTP_TTL_MS / 60000;
const MAX_ATTEMPTS = 5;
export const PHONE_RE = /^[6-9]\d{9}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function detectChannel(identifier) {
  if (!identifier) return null;
  if (PHONE_RE.test(identifier)) return "phone";
  if (EMAIL_RE.test(identifier)) return "email";
  return null;
}

const generateOtp = () => String(crypto.randomInt(100000, 1000000));
const hashOtp = (otp) => crypto.createHash("sha256").update(otp).digest("hex");

/**
 * Phone delivery waterfall:
 *   1) Mapthrust       (our OTP)
 *   2) StartMessaging  (same OTP)
 *   3) 2Factor         (their own OTP + session id)
 *
 * Returns { provider, otp } for providers 1/2 (we verify via hash),
 * or { provider: "twofactor", sessionId } for provider 3 (2Factor verifies).
 * Throws only if all three fail.
 */
async function sendPhoneOtpWithFallback(phone) {
  const otp = generateOtp();

  const attempts = [
    {
      name: "mapthrust",
      run: async () => {
        await sendOtpViaMapthrust(phone, otp);
        return { provider: "mapthrust", otp };
      },
    },
    {
      name: "startmessaging",
      run: async () => {
        await sendOtpViaStartMessaging(phone, otp, OTP_TTL_MIN);
        return { provider: "startmessaging", otp };
      },
    },
    {
      name: "twofactor",
      run: async () => {
        const sessionId = await sendPhoneOtpViaTwoFactor(phone);
        return { provider: "twofactor", sessionId };
      },
    },
  ];

  const errors = [];
  for (const attempt of attempts) {
    try {
      const result = await attempt.run();
      if (errors.length) {
        console.warn(`[otp] phone OTP sent via ${attempt.name} after failures:`, errors.join(" | "));
      }
      return result;
    } catch (e) {
      const msg = `${attempt.name}: ${e.name === "AbortError" ? "timeout" : e.message}`;
      console.error("[otp] provider failed ->", msg);
      errors.push(msg);
    }
  }
  throw Object.assign(new Error("All SMS providers failed."), { status: 502 });
}

// purpose: "login" | "contact_verify". userId: null for pre-auth login OTPs.
export async function issueOtp({ purpose, channel, value, userId = null }) {
  const expires_at = new Date(Date.now() + OTP_TTL_MS).toISOString();

  if (channel === "phone") {
    const sent = await sendPhoneOtpWithFallback(value);

    // Only store AFTER a provider accepted the send, so the row always
    // matches whichever provider actually delivered the code.
    const row = { purpose, channel, user_id: userId, value, expires_at };
    if (sent.provider === "twofactor") {
      row.session_id = sent.sessionId;
    } else {
      row.otp_hash = hashOtp(sent.otp);
    }

    const { error } = await supabaseAdmin.from("otp_sessions").insert(row);
    if (error) throw error;
    return;
  }

  // email
  const otp = generateOtp();
  const { error } = await supabaseAdmin.from("otp_sessions").insert({
    purpose, channel, user_id: userId, value,
    otp_hash: hashOtp(otp), expires_at,
  });
  if (error) throw error;

  // await instead of fire-and-forget — Vercel freezes the function
  // right after the response is sent, so background sends don't
  // reliably complete there the way they do on a long-running localhost process.
  try {
    await sendOtpEmail(value, otp);
  } catch (e) {
    console.error("[otp] email send failed:", e.message);
    throw Object.assign(new Error("Couldn't send the code. Try again."), { status: 502 });
  }
}

// Returns { ok: true, record } or { ok: false, message, status? }
export async function checkOtp({ purpose, channel, value, otp, userId = null }) {
  let query = supabaseAdmin.from("otp_sessions").select("*")
    .eq("purpose", purpose).eq("channel", channel).eq("value", value);
  query = userId ? query.eq("user_id", userId) : query.is("user_id", null);

  const { data: record } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();

  if (!record) return { ok: false, message: "Request a new code first." };
  if (new Date(record.expires_at) < new Date()) return { ok: false, message: "Code expired. Request a new one." };
  if (record.attempts >= MAX_ATTEMPTS) return { ok: false, message: "Too many attempts. Request a new code.", status: 429 };

  let matched;
  if (record.session_id) {
    // Sent via 2Factor (last-resort fallback): they hold the OTP, so verify there.
    try {
      matched = await verifyTwoFactorSession(record.session_id, otp);
    } catch (e) {
      console.error("[otp] 2Factor verify failed:", e.message);
      return { ok: false, message: "Couldn't verify. Try again.", status: 502 };
    }
  } else {
    // Email, Mapthrust or StartMessaging: we generated it, compare the hash.
    matched = hashOtp(String(otp)) === record.otp_hash;
  }

  if (!matched) {
    await supabaseAdmin.from("otp_sessions").update({ attempts: record.attempts + 1 }).eq("id", record.id);
    return { ok: false, message: "Incorrect code." };
  }

  await supabaseAdmin.from("otp_sessions").delete().eq("id", record.id);
  return { ok: true, record };
}