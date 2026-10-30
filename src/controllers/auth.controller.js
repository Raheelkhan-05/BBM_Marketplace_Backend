// src/controllers/auth.controller.js
import { supabaseAdmin, supabase } from "../config/supabase.js";
import { validateGSTIN, fetchGstinDetails } from "../services/gst.service.js";
import { channelTokenFor } from "../services/channelToken.js";
import { sendWelcomeEmail, sendBusinessVerifiedEmail } from "../services/mail.service.js";
import { getTeamContext } from "../services/team.service.js";
import { applyPendingCustomPricesForBuyer } from "../services/salesQuotePricing.service.js";

// Team members never register a company of their own; the admin's company is theirs.
async function blockTeamMember(req, res) {
  const ctx = await getTeamContext(req.user.id);
  if (ctx.isMember) {
    res.status(403).json({ success: false, code: "TEAM_MEMBER", message: "Your account is part of a company team. Only your team admin can change company details." });
    return true;
  }
  return false;
}

// GET /api/auth/me
//
// TEAM MODE: for a team member this returns the COMPANY's profile / business / seller data
// (profile.id is the company id, which is what chat, orders and sockets key on). The person
// who is actually signed in is in `team.actorId`. Solo users get `team: null` and behave
// exactly as before.
//
// Profile, seller and business lookups are independent, so seller + business run in parallel.
// sellerLocation: the seller's ship-from location, used by the GROW Transport page.
export async function getMe(req, res) {
  let ctx;
  try {
    ctx = await getTeamContext(req.user.id);
  } catch (e) {
    console.error("[getMe] team context failed:", e?.message || e);
    return res.status(503).json({ success: false, message: "Couldn't load your account. Please try again." });
  }
  const companyId = ctx.companyId;

  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("id, phone, phone_verified, email, email_verified, name, onboarding_step, created_at, role")
    .eq("id", companyId)
    .eq("role", "user")
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !profile) {
    console.log("[getMe] rejecting — error:", error?.message, "profile:", profile);
    return res.status(401).json({ success: false, message: "Session out of date — please log in again." });
  }

  let actor = null;
  if (ctx.isMember) {
    const { data } = await supabaseAdmin.from("profiles").select("name, phone, email").eq("id", ctx.actorId).maybeSingle();
    actor = data || null;
  }
  // A team-member profile that is no longer in any team has lost its access.
  if (!ctx.teamId && profile.onboarding_step === "team_member") {
    return res.status(401).json({ success: false, code: "TEAM_ACCESS_REMOVED", message: "You no longer have access to this team. Please contact your team admin." });
  }

  const [sellerResult, businessResult] = await Promise.allSettled([
    supabase
      .from("seller_profiles")
      .select("status, shop_slug, city, state, dispatch_same_as_registered, dispatch_district, dispatch_state")
      .eq("user_id", companyId)
      .maybeSingle(),
    supabaseAdmin.from("business_profiles").select("*").eq("user_id", companyId).maybeSingle(),
  ]);
  const seller = sellerResult.status === "fulfilled" ? sellerResult.value.data : null;
  const businessProfile = businessResult.status === "fulfilled" ? businessResult.value.data : null;

  return res.json({
    success: true,
    profile,
    businessProfile: businessProfile || null,
    notificationChannel: channelTokenFor(companyId),
    shop_slug: seller?.shop_slug ?? null,
    seller_status: seller?.status ?? null,
    // team: ctx.teamId ? { id: ctx.teamId, role: ctx.role, isAdmin: ctx.isAdmin, isOwner: !ctx.isMember, actorId: ctx.actorId } : null,
    team: ctx.teamId ? { id: ctx.teamId, role: ctx.role, isAdmin: ctx.isAdmin, isOwner: !ctx.isMember, actorId: ctx.actorId, actor } : null,
    sellerLocation: seller
      ? {
        city: seller.city ?? null,
        state: seller.state ?? null,
        dispatch_same_as_registered: seller.dispatch_same_as_registered ?? true,
        dispatch_district: seller.dispatch_district ?? null,
        dispatch_state: seller.dispatch_state ?? null,
      }
      : null,
  });
}

export async function getMeAdmin(req, res) {
  console.log("[getMeAdmin] req.user.id:", req.user?.id);

  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("id, phone, phone_verified, email, email_verified, name, onboarding_step, created_at, role")
    .eq("id", req.user.id)
    .eq("role", "admin")
    .is("deleted_at", null)
    .maybeSingle();

  console.log("[getMeAdmin] query result:", { profile, error });

  if (!profile) {
    console.log("[getMeAdmin] rejecting — no admin profile matched id:", req.user.id);
    return res.status(401).json({ success: false, message: "Profile Not Found" });
  }

  if (error) {
    console.log("[getMeAdmin] rejecting — query error:", error.message);
    return res.status(401).json({ success: false, message: "Session out of date — please log in again." });
  }

  const [sellerResult, businessResult] = await Promise.allSettled([
    supabase.from("seller_profiles").select("status, shop_slug").eq("user_id", req.user.id).maybeSingle(),
    supabaseAdmin.from("business_profiles").select("*").eq("user_id", req.user.id).maybeSingle(),
  ]);
  const seller = sellerResult.status === "fulfilled" ? sellerResult.value.data : null;
  const businessProfile = businessResult.status === "fulfilled" ? businessResult.value.data : null;

  return res.json({
    success: true,
    profile,
    businessProfile: businessProfile || null,
    notificationChannel: channelTokenFor(req.user.id),
    shop_slug: seller?.shop_slug ?? null,
    seller_status: seller?.status ?? null,
  });
}

// POST /api/auth/gst-lookup  { gstin }
export async function lookupGstin(req, res) {
  if (await blockTeamMember(req, res)) return;

  const check = validateGSTIN(req.body?.gstin);
  if (!check.valid) return res.status(400).json({ success: false, message: check.reason });

  const { data: existing } = await supabaseAdmin
    .from("business_profiles")
    .select("user_id, profiles!inner(deleted_at)")
    .eq("gstin", check.gstin)
    .is("profiles.deleted_at", null)   // only counts as "taken" if the owning profile is still active
    .maybeSingle();
  if (existing && existing.user_id !== req.user.id) {
    return res.status(409).json({ success: false, code: "GSTIN_TAKEN", message: "This GSTIN is already registered to another account." });
  }

  const result = await fetchGstinDetails(check.gstin);
  if (!result.mapped) return res.status(400).json({ success: false, message: result.reason });

  return res.json({ success: true, data: result.mapped });
}

// POST /api/auth/complete-profile
// { name, gstin, displayName, dispatchSameAsRegistered, dispatchAddress?, dispatchPincode?, dispatchState? }
export async function completeProfile(req, res) {
  if (await blockTeamMember(req, res)) return;

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
    .from("business_profiles")
    .select("user_id, profiles!inner(deleted_at)")
    .eq("gstin", gstCheck.gstin)
    .is("profiles.deleted_at", null)
    .maybeSingle();
  if (existing && existing.user_id !== req.user.id) {
    return res.status(409).json({ success: false, code: "GSTIN_TAKEN", message: "This GSTIN is already registered to another account." });
  }

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
      return res.status(409).json({ success: false, code: "GSTIN_TAKEN", message: "This GSTIN is already registered to another account." });
    }
    console.error("[complete-profile] business upsert failed:", bizErr.message);
    return res.status(500).json({ success: false, message: "Couldn't save your company details. Try again." });
  }

  // Prices a salesperson quoted / punched for this GST number before the buyer joined become their custom prices now
  // (background, idempotent, never blocks or fails signup). Only for an Active GST registration, like the "verified" email.
  if (g.gstin_status === "Active") {
    void applyPendingCustomPricesForBuyer({ userId: req.user.id, gstin: gstCheck.gstin })
      .catch((e) => console.error("[complete-profile] applying remembered custom prices failed:", e?.message || e));
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