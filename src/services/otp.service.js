// src/services/otp.service.js
import crypto from "crypto";
import { supabaseAdmin } from "../config/supabase.js";
import { sendOtp as sendPhoneOtp, verifyOtp as verifyPhoneOtpSession } from "./twoFactor.service.js";
import { sendOtpEmail } from "./mail.service.js";

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
export const PHONE_RE = /^[6-9]\d{9}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function detectChannel(identifier) {
  if (!identifier) return null;
  if (PHONE_RE.test(identifier)) return "phone";
  if (EMAIL_RE.test(identifier)) return "email";
  return null;
}

const generateOtp = () => String(Math.floor(100000 + Math.random() * 900000));
const hashOtp = (otp) => crypto.createHash("sha256").update(otp).digest("hex");

// purpose: "login" | "contact_verify". userId: null for pre-auth login OTPs.
export async function issueOtp({ purpose, channel, value, userId = null }) {
  if (channel === "phone") {
    const sessionId = await sendPhoneOtp(value); // throws on provider failure
    const { error } = await supabaseAdmin.from("otp_sessions").insert({
      purpose, channel, user_id: userId, value,
      session_id: sessionId, expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    });
    if (error) throw error;
  } else {
    const otp = generateOtp();
    const { error } = await supabaseAdmin.from("otp_sessions").insert({
      purpose, channel, user_id: userId, value,
      otp_hash: hashOtp(otp), expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    });
    if (error) throw error;
    sendOtpEmail(value, otp).catch((e) => console.error("[otp] email send failed:", e.message));
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
  if (channel === "phone") {
    try {
      matched = await verifyPhoneOtpSession(record.session_id, otp);
    } catch (e) {
      console.error("[otp] 2Factor verify failed:", e.message);
      return { ok: false, message: "Couldn't verify. Try again.", status: 502 };
    }
  } else {
    matched = hashOtp(otp) === record.otp_hash;
  }

  if (!matched) {
    await supabaseAdmin.from("otp_sessions").update({ attempts: record.attempts + 1 }).eq("id", record.id);
    return { ok: false, message: "Incorrect code." };
  }

  await supabaseAdmin.from("otp_sessions").delete().eq("id", record.id);
  return { ok: true, record };
}