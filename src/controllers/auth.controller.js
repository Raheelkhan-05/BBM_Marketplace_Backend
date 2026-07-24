// src/controllers/auth.controller.js
import { supabaseAdmin, supabase } from "../config/supabase.js";
import { validateGSTIN, fetchGstinDetails } from "../services/gst.service.js";
import { sendWelcomeEmail, sendBusinessVerifiedEmail } from "../services/mail.service.js";

// GET /api/auth/me
export async function getMe(req, res) {
  // console.log("[getMe] looking up id:", req.user.id);
  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("id, phone, phone_verified, email, email_verified, name, onboarding_step, created_at, role")
    .eq("id", req.user.id)
    .maybeSingle();
  // console.log("[getMe] result:", { profile, error });
  if (error || !profile) {
    return res.status(401).json({ success: false, message: "Session out of date — please log in again." });
  }

  // inside getMe, alongside the existing profile fetch
  const { data: seller } = await supabase.from("seller_profiles").select("status, shop_slug").eq("user_id", req.user.id).maybeSingle();

  const { data: businessProfile } = await supabaseAdmin
    .from("business_profiles").select("*").eq("user_id", req.user.id).maybeSingle();
  return res.json({ success: true, profile, businessProfile: businessProfile || null, shop_slug: seller?.shop_slug ?? null, seller_status: seller?.status ?? null });
}

// POST /api/auth/gst-lookup  { gstin }
export async function lookupGstin(req, res) {
  const check = validateGSTIN(req.body?.gstin);
  if (!check.valid) return res.status(400).json({ success: false, message: check.reason });

  const { data: existing } = await supabaseAdmin
    .from("business_profiles").select("user_id").eq("gstin", check.gstin).maybeSingle();
  if (existing && existing.user_id !== req.user.id) {
    return res.status(409).json({ success: false, message: "This GSTIN is already registered to another account." });
  }

  const result = await fetchGstinDetails(check.gstin);
  if (!result.mapped) return res.status(400).json({ success: false, message: result.reason });

  return res.json({ success: true, data: result.mapped });
}

// POST /api/auth/complete-profile
// { name, gstin, displayName, dispatchSameAsRegistered, dispatchAddress?, dispatchPincode?, dispatchState? }
export async function completeProfile(req, res) {
  const {
    name, gstin, displayName,
    dispatchSameAsRegistered, dispatchAddress, dispatchPincode, dispatchState,
  } = req.body || {};

  if (!name || name.trim().length < 2) return res.status(400).json({ success: false, message: "Enter your name." });

  
  const gstCheck = validateGSTIN(gstin);
  if (!gstCheck.valid) return res.status(400).json({ success: false, message: gstCheck.reason });
  if (!displayName || displayName.trim().length < 2) {
    return res.status(400).json({ success: false, message: "Enter a display name for your storefront." });
  }
  if (!dispatchSameAsRegistered && (!dispatchAddress || !dispatchPincode || !dispatchState)) {
    return res.status(400).json({ success: false, message: "Fill in the dispatch address." });
  }

  const { data: existing } = await supabaseAdmin
    .from("business_profiles").select("user_id").eq("gstin", gstCheck.gstin).maybeSingle();
  if (existing && existing.user_id !== req.user.id) {
    return res.status(409).json({ success: false, message: "This GSTIN is already registered to another account." });
  }

  // inside completeProfile, alongside the existing validation
  const { data: currentProfile } = await supabaseAdmin
    .from("profiles").select("phone_verified").eq("id", req.user.id).single();
  if (!currentProfile?.phone_verified) {
    return res.status(400).json({ success: false, message: "Verify your mobile number to continue." });
  }

  const result = await fetchGstinDetails(gstCheck.gstin);
  if (!result.mapped) return res.status(400).json({ success: false, message: result.reason });
  const g = result.mapped;

  const { error: profileErr } = await supabaseAdmin
    .from("profiles")
    .update({ name: name.trim(), onboarding_step: "done" })
    .eq("id", req.user.id);
  if (profileErr) {
    console.error("[complete-profile] profile update failed:", profileErr.message);
    return res.status(500).json({ success: false, message: "Couldn't save your details. Try again." });
  }

  const { data: businessProfile, error: bizErr } = await supabaseAdmin
    .from("business_profiles")
    .upsert({
      user_id: req.user.id,
      gstin: gstCheck.gstin,
      legal_name: g.legal_name,
      trade_name: g.trade_name,
      display_name: displayName.trim(),
      gstin_status: g.gstin_status,
      constitution: g.constitution,
      taxpayer_type: g.taxpayer_type,
      gst_registration_date: g.gst_registration_date,
      gst_last_updated: g.gst_last_updated,
      state: g.state,
      state_code: g.state_code,
      pan: g.pan,
      registered_address: g.registered_address,
      district: g.district,
      pincode: g.pincode,
      nature_of_business: g.nature_of_business,
      dispatch_same_as_registered: !!dispatchSameAsRegistered,
      dispatch_address: dispatchSameAsRegistered ? null : dispatchAddress.trim(),
      dispatch_pincode: dispatchSameAsRegistered ? null : dispatchPincode.trim(),
      dispatch_state: dispatchSameAsRegistered ? null : dispatchState.trim(),
      gst_raw: g,
      gst_fetched_at: new Date().toISOString(),
    }, { onConflict: "user_id" })
    .select()
    .single();

  if (bizErr) {
    if (bizErr.code === "23505") {
      return res.status(409).json({ success: false, message: "This GSTIN is already registered to another account." });
    }
    console.error("[complete-profile] business upsert failed:", bizErr.message);
    return res.status(500).json({ success: false, message: "Couldn't save your company details. Try again." });
  }

  const { data: profile } = await supabaseAdmin.from("profiles").select("email, name").eq("id", req.user.id).single();
  if (profile?.email) {
    sendWelcomeEmail(profile.email, profile.name).catch((e) => console.error("[complete-profile] welcome email failed:", e.message));
    if (g.gstin_status === "Active") {
      sendBusinessVerifiedEmail(profile.email, g.legal_name).catch((e) => console.error("[complete-profile] verified email failed:", e.message));
    }
  }

  return res.json({ success: true, businessProfile });
}

export async function saveProgress(req, res) {
  const { name } = req.body || {};
  const patch = {};
  if (typeof name === "string" && name.trim()) patch.name = name.trim();
  if (!Object.keys(patch).length) return res.json({ success: true });

  const { error } = await supabaseAdmin.from("profiles").update(patch).eq("id", req.user.id);
  if (error) return res.status(500).json({ success: false, message: "Couldn't save." });
  return res.json({ success: true });
}