// controllers/adminOtpAuth.controller.js
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabase.js";
import { issueOtp, checkOtp, detectChannel } from "../services/otp.service.js";

const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET;

// Looks up an ACTIVE profile with role='admin' matching this exact
// phone/email — no fuzzy matching, no fallback to the other channel
// (unlike findOrCreateProfile in otpAuth.controller.js), and critically,
// NEVER creates one. This is the "no signup" enforcement point.
async function findAdminProfile(channel, value) {
    const column = channel === "phone" ? "phone" : "email";
    const { data } = await supabaseAdmin
        .from("profiles")
        .select("id, name, phone, email, role, onboarding_step")
        .eq(column, value)
        .eq("role", "admin")
        .is("deleted_at", null)
        .maybeSingle();
    return data || null;
}

export async function requestAdminLoginOtp(req, res) {
    const { identifier } = req.body || {};
    const channel = detectChannel(identifier);
    if (!channel) return res.status(400).json({ success: false, message: "Enter a valid phone number or email." });
    const value = channel === "email" ? identifier.trim().toLowerCase() : identifier;

    const admin = await findAdminProfile(channel, value);
    if (!admin) {
        // No OTP is sent at all if this isn't a known admin identifier — this
        // is the "show unauthorized instead of letting them in" gate.
        return res.status(403).json({ success: false, message: "Unauthorized access. This account doesn't have admin access." });
    }

    try {
        await issueOtp({ purpose: "admin_login", channel, value });
        return res.json({ success: true, channel });
    } catch (e) {
        console.error("[admin-otp-auth] request failed:", e.message);
        return res.status(e.status || 502).json({ success: false, message: "Couldn't send the code. Try again." });
    }
}

export async function verifyAdminLoginOtp(req, res) {
    const { identifier, otp } = req.body || {};
    const channel = detectChannel(identifier);
    if (!channel || !otp) return res.status(400).json({ success: false, message: "Invalid request." });
    const value = channel === "email" ? identifier.trim().toLowerCase() : identifier;

    console.log("[verifyAdminLoginOtp] HIT — body:", req.body);

    // Re-check here too — not just trusting that request-otp already
    // gated it, since these are two separate requests and the admin could
    // theoretically have been demoted in between.
    const admin = await findAdminProfile(channel, value);
    if (!admin) {
        return res.status(403).json({ success: false, message: "Unauthorized access. This account doesn't have admin access." });
    }

    const result = await checkOtp({ purpose: "admin_login", channel, value, otp });
    if (!result.ok) return res.status(result.status || 400).json({ success: false, message: result.message });

    // Same AUTH_JWT_SECRET, same { sub: profile.id } shape as the buyer/
    // seller login — this is what lets the existing requireAuth +
    // requireAdmin middleware, and every /api/admin/* route, work
    // completely unchanged.
    const token = jwt.sign({ sub: admin.id }, AUTH_JWT_SECRET, { expiresIn: "672h" });
    return res.json({ success: true, token, profile: admin });
}