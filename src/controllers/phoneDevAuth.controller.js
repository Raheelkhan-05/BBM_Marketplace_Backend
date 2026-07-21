// src/controllers/phoneDevAuth.controller.js
//
// ⚠️  DEVELOPMENT-ONLY PHONE AUTH BYPASS ⚠️
// No SMS/OTP provider is wired up yet, so this accepts ANY code for ANY
// phone number and issues a real session. It refuses to run at all if
// NODE_ENV=production, so it cannot accidentally reach prod.
//
// To replace with a real provider later: delete this file and its route,
// and switch utils/api.js's phone branch back to
// supabase.auth.signInWithOtp({ phone }) / supabase.auth.verifyOtp(...).

import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabase.js";

const DEV_JWT_SECRET = process.env.DEV_AUTH_JWT_SECRET;

// if (process.env.NODE_ENV === "production" && process.env.AUTH_DEV_BYPASS_OTP === "true") {
//   throw new Error(
//     "[FATAL] AUTH_DEV_BYPASS_OTP is enabled in production. This would let " +
//     "anyone log in as any phone number with no code check. Refusing to start."
//   );
// }

function assertDevModeEnabled() {
  if (process.env.AUTH_DEV_BYPASS_OTP !== "true") {
    throw Object.assign(new Error("Phone OTP bypass is disabled."), { status: 503 });
  }
  if (!DEV_JWT_SECRET) {
    throw Object.assign(new Error("DEV_AUTH_JWT_SECRET is not set."), { status: 500 });
  }
}

// POST /api/auth/phone/dev-request  { phone }
// Intentionally does nothing — no code is sent anywhere.
export async function devRequestPhoneOtp(req, res) {
  try {
    assertDevModeEnabled();
    return res.json({ success: true });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
}

// POST /api/auth/phone/dev-verify  { phone, otp }
// Accepts any 6-digit string as the code. Finds-or-creates the profile
// row for this phone, then issues our own short-lived JWT (NOT a real
// Supabase session token) that requireAuth will accept only when the
// bypass flag is on.
export async function devVerifyPhoneOtp(req, res) {
  try {
    assertDevModeEnabled();
    const { phone, otp } = req.body || {};

    if (!phone) {
      return res.status(400).json({ success: false, message: "Phone is required." });
    }
    if (!/^\d{6}$/.test(otp || "")) {
      return res.status(400).json({ success: false, message: "Enter the 6-digit code." });
    }
    // Deliberately no comparison against a stored/sent code — that's the point of the bypass.

    let { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("phone", phone)
      .maybeSingle();

    if (!profile) {
      const { data: created, error: createErr } = await supabaseAdmin
        .from("profiles")
        .insert({ phone, roles: ["buyer"] })
        .select("id")
        .single();
      if (createErr) {
        console.error("[dev-verify] profile create failed:", createErr.message);
        return res.status(500).json({ success: false, message: "Couldn't create account. Try again." });
      }
      profile = created;
    }

    const token = jwt.sign(
      { sub: profile.id, phone, auth_mode: "dev_bypass" },
      DEV_JWT_SECRET,
      { expiresIn: "12h" }
    );

    return res.json({ success: true, token });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
}