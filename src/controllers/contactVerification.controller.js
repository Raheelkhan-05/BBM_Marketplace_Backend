// src/controllers/contactVerification.controller.js
//
// Verifies whichever of email/phone was NOT used as the login identifier.
// Writes straight to profiles.{field} + profiles.{field}_verified on
// success — the frontend never sends this value through registerProfile.

import crypto from "crypto";
import { supabaseAdmin } from "../config/supabase.js";
import { sendOtpEmail } from "../services/mail.service.js";

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function hashOtp(otp) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

// POST /api/auth/contact/request-otp  { field: 'email'|'phone', value }
export async function requestContactOtp(req, res) {
  const { field, value } = req.body || {};
  if (!["email", "phone"].includes(field) || !value) {
    return res.status(400).json({ success: false, message: "Invalid field." });
  }
  if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return res.status(400).json({ success: false, message: "Enter a valid email address." });
  }
  if (field === "phone" && !/^[6-9]\d{9}$/.test(value)) {
    return res.status(400).json({ success: false, message: "Enter a valid 10-digit mobile number." });
  }

  const otp = generateOtp();
  const { error } = await supabaseAdmin.from("contact_verifications").insert({
    user_id: req.user.id,
    field,
    value,
    otp_hash: hashOtp(otp),
    expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
  });
  if (error) {
    console.error("[contact-otp] insert failed:", error.message);
    return res.status(500).json({ success: false, message: "Couldn't send the code. Try again." });
  }

  if (field === "email") {
    sendOtpEmail(value, otp).catch((e) => console.error("[contact-otp] email send failed:", e.message));
  } else {
    // DEV MODE: no SMS provider wired yet (same situation as
    // phoneDevAuth.controller.js). Log the code instead of sending it.
    console.log(`[contact-otp][DEV] OTP for ${value}: ${otp}`);
  }

  return res.json({ success: true });
}

// POST /api/auth/contact/verify-otp  { field, value, otp }
export async function verifyContactOtp(req, res) {
  const { field, value, otp } = req.body || {};
  if (!["email", "phone"].includes(field) || !value || !otp) {
    return res.status(400).json({ success: false, message: "Invalid request." });
  }

  const { data: record } = await supabaseAdmin
    .from("contact_verifications")
    .select("*")
    .eq("user_id", req.user.id)
    .eq("field", field)
    .eq("value", value)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!record) {
    return res.status(400).json({ success: false, message: "Request a new code first." });
  }
  if (new Date(record.expires_at) < new Date()) {
    return res.status(400).json({ success: false, message: "Code expired. Request a new one." });
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    return res.status(429).json({ success: false, message: "Too many attempts. Request a new code." });
  }
  if (hashOtp(otp) !== record.otp_hash) {
    await supabaseAdmin.from("contact_verifications").update({ attempts: record.attempts + 1 }).eq("id", record.id);
    return res.status(400).json({ success: false, message: "Incorrect code." });
  }

  const patch = field === "email"
    ? { email: value, email_verified: true }
    : { phone: value, phone_verified: true };

  const { error } = await supabaseAdmin.from("profiles").update(patch).eq("id", req.user.id);
  if (error) {
    console.error("[contact-otp] profile update failed:", error.message);
    return res.status(500).json({ success: false, message: "Couldn't verify. Try again." });
  }

  await supabaseAdmin.from("contact_verifications").delete().eq("id", record.id);
  return res.json({ success: true });
}