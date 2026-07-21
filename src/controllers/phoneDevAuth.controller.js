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

// Insert-or-fetch: two concurrent dev-verify calls for the same phone can
// both reach this point after the initial profile lookup missed. Rather
// than trusting the insert to always be the first writer, upsert on the
// primary key and just re-select if a concurrent request beat us to it.
async function upsertPhoneProfile(userId, phone) {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .upsert(
      { id: userId, phone, phone_verified: true, onboarding_step: "contact" },
      { onConflict: "id", ignoreDuplicates: false }
    )
    .select("id")
    .single();

  if (!error) return data;

  // Even upsert can race on truly simultaneous inserts under READ COMMITTED;
  // if so, the row now exists — just fetch it.
  console.warn("[dev-verify] upsert raced, refetching:", error.message);
  const { data: refetched } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  return refetched || null;
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
      const { data: created, error: createUserErr } = await supabaseAdmin.auth.admin.createUser({
        phone,
        phone_confirm: true,
        user_metadata: { auth_mode: "dev_bypass" },
      });

      if (createUserErr) {
        const alreadyExists = /already|exists|registered/i.test(createUserErr.message || "");
        if (!alreadyExists) {
          console.error("[dev-verify] auth user create failed:", createUserErr.message);
          return res.status(500).json({ success: false, message: "Couldn't create account. Try again." });
        }

        const { data: list, error: listErr } = await supabaseAdmin.auth.admin.listUsers();
        const existingAuthUser = !listErr && list?.users?.find((u) => u.phone === phone);
        if (!existingAuthUser) {
          console.error("[dev-verify] createUser said 'exists' but no match found:", createUserErr.message);
          return res.status(500).json({ success: false, message: "Couldn't create account. Try again." });
        }

        profile = await upsertPhoneProfile(existingAuthUser.id, phone);
      } else {
        profile = await upsertPhoneProfile(created.user.id, phone);
      }

      if (!profile) {
        return res.status(500).json({ success: false, message: "Couldn't create account. Try again." });
      }
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