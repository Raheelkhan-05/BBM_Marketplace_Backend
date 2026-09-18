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
// src/controllers/otpAuth.controller.js

// Finds a profile owning this phone/email. Verified ownership always
// wins: if some profile has actually verified this value, that's the
// one returned, full stop — even if other unverified rows also happen
// to carry the same value (abandoned signups, typos, etc.). Only when
// NO profile has verified it yet do we fall back to an unverified match,
// picking exactly one (most recently created) so a half-finished signup
// resumes on the same profile instead of spawning a duplicate.
async function findOrCreateProfile(channel, value) {
  const column = channel === "phone" ? "phone" : "email";
  const verifiedColumn = channel === "phone" ? "phone_verified" : "email_verified";

  // 1) Verified match, if any — this is authoritative ownership.
  const { data: verifiedProfile, error: verifiedErr } = await supabaseAdmin
    .from("profiles").select("*")
    .eq(column, value)
    .eq(verifiedColumn, true)
    .eq("role", "user")
    .is("deleted_at", null)
    .maybeSingle();
  if (verifiedErr) throw verifiedErr;

  let profile = verifiedProfile;

  // 2) No one has verified this value yet — fall back to an unverified
  // row, but only ONE: the most recently created, so this is
  // deterministic even if several stale rows share the value.
  if (!profile) {
    const { data: unverifiedMatches, error: unverifiedErr } = await supabaseAdmin
      .from("profiles").select("*")
      .eq(column, value)
      .eq(verifiedColumn, false)
      .eq("role", "user")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1);
    if (unverifiedErr) throw unverifiedErr;
    profile = unverifiedMatches?.[0] || null;
  }

  if (profile) {
    if (!profile[verifiedColumn]) {
      await supabaseAdmin.from("profiles").update({ [column]: value, [verifiedColumn]: true }).eq("id", profile.id);
      profile[verifiedColumn] = true;
    }
    return { profile, isNewUser: profile.onboarding_step !== "done" };
  }

  const insertPatch = channel === "phone"
    ? { phone: value, phone_verified: true, role: "user" }
    : { email: value, email_verified: true, role: "user" };
  const { data: created, error: insertErr } = await supabaseAdmin.from("profiles").insert(insertPatch).select("*").single();
  if (insertErr) {
    if (insertErr.code === "23505") {
      // Someone else just verified this value in the race window —
      // re-run the same verified-first lookup rather than re-querying
      // the old broad OR.
      const { data: raced, error: racedErr } = await supabaseAdmin
        .from("profiles").select("*")
        .eq(column, value).eq(verifiedColumn, true).eq("role", "user").is("deleted_at", null).maybeSingle();
      if (racedErr) throw racedErr;
      if (raced) return { profile: raced, isNewUser: raced.onboarding_step !== "done" };
    }
    throw insertErr;
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
    const token = jwt.sign({ sub: profile.id }, AUTH_JWT_SECRET, { expiresIn: "168h" });

    return res.json({ success: true, token, isNewUser, onboardingStep: profile.onboarding_step, profile });
  } catch (e) {
    console.error("[otp-auth] verify failed:", e.message);
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
}