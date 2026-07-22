// src/controllers/contactVerification.controller.js
import { supabaseAdmin } from "../config/supabase.js";
import { issueOtp, checkOtp } from "../services/otp.service.js";

export async function requestContactOtp(req, res) {
  const { field, value } = req.body || {};
  if (!["email", "phone"].includes(field) || !value) {
    return res.status(400).json({ success: false, message: "Invalid field." });
  }
  const normalized = field === "email" ? value.trim().toLowerCase() : value;
  if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return res.status(400).json({ success: false, message: "Enter a valid email address." });
  }
  if (field === "phone" && !/^[6-9]\d{9}$/.test(normalized)) {
    return res.status(400).json({ success: false, message: "Enter a valid 10-digit mobile number." });
  }

  const { data: taken } = await supabaseAdmin
    .from("profiles").select("id").eq(field, normalized).neq("id", req.user.id).maybeSingle();
  if (taken) {
    return res.status(409).json({
      success: false,
      message: field === "email" ? "This email is already linked to another account." : "This number is already linked to another account.",
    });
  }

  try {
    await issueOtp({ purpose: "contact_verify", channel: field, value: normalized, userId: req.user.id });
    return res.json({ success: true });
  } catch (e) {
    console.error("[contact-otp] request failed:", e.message);
    return res.status(502).json({ success: false, message: "Couldn't send the code. Try again." });
  }
}

export async function verifyContactOtp(req, res) {
  const { field, value, otp } = req.body || {};
  if (!["email", "phone"].includes(field) || !value || !otp) {
    return res.status(400).json({ success: false, message: "Invalid request." });
  }
  const normalized = field === "email" ? value.trim().toLowerCase() : value;

  const result = await checkOtp({ purpose: "contact_verify", channel: field, value: normalized, otp, userId: req.user.id });
  if (!result.ok) return res.status(result.status || 400).json({ success: false, message: result.message });

  const patch = field === "email" ? { email: normalized, email_verified: true } : { phone: normalized, phone_verified: true };
  const { error } = await supabaseAdmin.from("profiles").update(patch).eq("id", req.user.id);
  if (error) {
    if (error.code === "23505") return res.status(409).json({ success: false, message: "This is already linked to another account." });
    return res.status(500).json({ success: false, message: "Couldn't verify. Try again." });
  }
  return res.json({ success: true });
}