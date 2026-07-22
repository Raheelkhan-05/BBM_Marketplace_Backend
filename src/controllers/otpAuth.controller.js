// src/controllers/otpAuth.controller.js
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabase.js";
import { issueOtp, checkOtp, detectChannel } from "../services/otp.service.js";

const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET;

function assertConfigured() {
  if (!AUTH_JWT_SECRET) throw Object.assign(new Error("AUTH_JWT_SECRET is not set."), { status: 500 });
}

// Finds a profile by EITHER phone or email matching the given value, so a
// user who started signup on one channel can log back in on the other and
// land on the same account, rather than getting a fresh blank one.
async function findOrCreateProfile(channel, value) {
  const { data: profile } = await supabaseAdmin
    .from("profiles").select("*")
    .or(`phone.eq.${value},email.eq.${value}`)
    .maybeSingle();

  if (profile) {
    const column = channel === "phone" ? "phone" : "email";
    const verifiedColumn = channel === "phone" ? "phone_verified" : "email_verified";
    // Backfill this channel if the existing profile didn't have it yet
    // (e.g. they verified phone last time, now they're logging in by email
    // that was never actually attached — shouldn't normally happen since
    // findOrCreate matched on it, but keeps state consistent either way).
    if (!profile[column]) {
      await supabaseAdmin.from("profiles").update({ [column]: value, [verifiedColumn]: true }).eq("id", profile.id);
      profile[column] = value;
      profile[verifiedColumn] = true;
    }
    return { profile, isNewUser: profile.onboarding_step !== "done" };
  }

  const insertPatch = channel === "phone" ? { phone: value, phone_verified: true } : { email: value, email_verified: true };
  const { data: created, error } = await supabaseAdmin.from("profiles").insert(insertPatch).select("*").single();
  if (error) {
    if (error.code === "23505") {
      const { data: existing } = await supabaseAdmin.from("profiles").select("*")
        .or(`phone.eq.${value},email.eq.${value}`).maybeSingle();
      if (existing) return { profile: existing, isNewUser: existing.onboarding_step !== "done" };
    }
    throw error;
  }
  return { profile: created, isNewUser: true };
}

export async function requestLoginOtp(req, res) {
  try {
    const { identifier } = req.body || {};
    const channel = detectChannel(identifier);
    if (!channel) return res.status(400).json({ success: false, message: "Enter a valid phone number or email." });
    const value = channel === "email" ? identifier.trim().toLowerCase() : identifier;

    await issueOtp({ purpose: "login", channel, value });
    return res.json({ success: true, channel });
  } catch (e) {
    console.error("[otp-auth] request failed:", e.message);
    return res.status(e.status || 502).json({ success: false, message: "Couldn't send the code. Try again." });
  }
}

export async function verifyLoginOtp(req, res) {
  try {
    assertConfigured();
    const { identifier, otp } = req.body || {};
    const channel = detectChannel(identifier);
    if (!channel || !otp) return res.status(400).json({ success: false, message: "Invalid request." });
    const value = channel === "email" ? identifier.trim().toLowerCase() : identifier;

    const result = await checkOtp({ purpose: "login", channel, value, otp });
    if (!result.ok) return res.status(result.status || 400).json({ success: false, message: result.message });

    const { profile, isNewUser } = await findOrCreateProfile(channel, value);
    console.log("[verifyLoginOtp] profile.id used for token:", profile.id);
    const token = jwt.sign({ sub: profile.id }, AUTH_JWT_SECRET, { expiresIn: "12h" });

    return res.json({ success: true, token, isNewUser, onboardingStep: profile.onboarding_step, profile });
  } catch (e) {
    console.error("[otp-auth] verify failed:", e.message);
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
}