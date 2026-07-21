// src/controllers/auth.controller.js

import { supabaseAdmin } from "../config/supabase.js";
import { validateGSTIN, fetchGstinDetails } from "../services/gst.service.js";
import {
  sendWelcomeEmail,
  sendBusinessVerifiedEmail,
} from "../services/mail.service.js";

const BUSINESS_TYPES = [
  "manufacturer", "distributor", "wholesaler",
  "retailer", "exporter", "importer", "service_provider",
];

// POST /api/auth/register  { name, designation }
// Every account is buyer + seller — no role selection anymore. This step
// only ever writes name/designation; email/phone (whichever wasn't the
// login identifier) are written directly by the contact-otp verify
// endpoint the moment they're confirmed, not deferred to here.
export async function registerProfile(req, res) {
  const { name, designation } = req.body || {};

  if (!name || name.trim().length < 2) {
    return res.status(400).json({ success: false, message: "Enter your name." });
  }
  if (!designation || designation.trim().length < 2) {
    return res.status(400).json({ success: false, message: "Enter your designation." });
  }

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .update({
      name: name.trim(),
      designation: designation.trim(),
      onboarding_step: "company",
    })
    .eq("id", req.user.id)
    .select()
    .single();

  if (error) {
    console.error("[register] supabase error:", error.message);
    return res.status(500).json({ success: false, message: "Couldn't save your details. Try again." });
  }

  if (data.email) {
    sendWelcomeEmail(data.email, data.name).catch((e) =>
      console.error("[register] welcome email failed:", e.message)
    );
  }

  return res.json({ success: true, user: data });
}

// POST /api/auth/gst-lookup  { gstin }
// Used by CompanyDetailsStep to pre-fill everything the GST portal
// already knows, before the person commits to submitting the form.
// Checks business_profiles first — if someone has already verified this
// exact GSTIN, reuse it instead of spending an API credit.
export async function lookupGstin(req, res) {
  const check = validateGSTIN(req.body?.gstin);
  if (!check.valid) {
    return res.status(400).json({ success: false, message: check.reason });
  }

  const { data: cached } = await supabaseAdmin
    .from("business_profiles")
    .select("legal_name, trade_name, gstin_status, constitution, taxpayer_type, gst_registration_date, gst_last_updated, state, state_code, pan, registered_address, district, pincode, nature_of_business")
    .eq("gstin", check.gstin)
    .maybeSingle();

  if (cached) {
    return res.json({ success: true, data: cached, cached: true });
  }

  const result = await fetchGstinDetails(check.gstin);
  if (!result.mapped) {
    return res.status(400).json({ success: false, message: result.reason });
  }

  return res.json({ success: true, data: result.mapped, cached: false });
}

// POST /api/auth/company
// { gstin, displayName, businessType, industry, categories[], productsBrands[],
//   yearEstablished?, employeeCount?, annualTurnover?, turnoverVisible?, website? }
// GSTIN is always required now — every account is a seller. GST data is
// re-fetched/re-validated server-side rather than trusted from the client.
export async function submitCompany(req, res) {
  const {
    gstin, displayName, businessType, industry,
    categories, productsBrands, yearEstablished, employeeCount,
    annualTurnover, turnoverVisible, website,
  } = req.body || {};

  const gstCheck = validateGSTIN(gstin);
  if (!gstCheck.valid) {
    return res.status(400).json({ success: false, message: gstCheck.reason });
  }
  if (!BUSINESS_TYPES.includes(businessType)) {
    return res.status(400).json({ success: false, message: "Select a valid business type." });
  }
  if (!industry || industry.trim().length < 2) {
    return res.status(400).json({ success: false, message: "Select an industry." });
  }
  if (!Array.isArray(categories) || categories.length === 0) {
    return res.status(400).json({ success: false, message: "Select at least one category." });
  }
  if (!displayName || displayName.trim().length < 2) {
    return res.status(400).json({ success: false, message: "Enter a display name for your storefront." });
  }
  if (website && !/^https?:\/\/.+/.test(website)) {
    return res.status(400).json({ success: false, message: "Website must start with http:// or https://" });
  }

  const { data: existing } = await supabaseAdmin
    .from("business_profiles")
    .select("id, user_id, legal_name, trade_name, gstin_status, constitution, taxpayer_type, gst_registration_date, gst_last_updated, state, state_code, pan, registered_address, district, pincode, nature_of_business")
    .eq("gstin", gstCheck.gstin)
    .maybeSingle();

  if (existing && existing.user_id !== req.user.id) {
    return res.status(409).json({ success: false, message: "This GSTIN is already registered to another account." });
  }

  let gstFields;
  if (existing) {
    gstFields = existing; // already fetched and cached by another/earlier attempt
  } else {
    const result = await fetchGstinDetails(gstCheck.gstin);
    if (!result.mapped) {
      return res.status(400).json({ success: false, message: result.reason });
    }
    gstFields = result.mapped;
  }

  const verificationStatus = gstFields.gstin_status === "Active" ? "verified" : "rejected";

  const { data: businessProfile, error } = await supabaseAdmin
    .from("business_profiles")
    .upsert(
      {
        user_id: req.user.id,
        company_name: gstFields.legal_name,
        display_name: displayName.trim(),
        business_type: businessType,
        industry: industry.trim(),
        categories,
        products_brands: productsBrands || [],
        year_established: yearEstablished || null,
        employee_count: employeeCount || null,
        annual_turnover: annualTurnover || null,
        turnover_visible: !!turnoverVisible,
        website: website?.trim() || null,
        gstin: gstCheck.gstin,
        pincode: gstFields.pincode,
        verification_status: verificationStatus,
        verified_at: verificationStatus === "verified" ? new Date().toISOString() : null,
        legal_name: gstFields.legal_name,
        trade_name: gstFields.trade_name,
        gstin_status: gstFields.gstin_status,
        constitution: gstFields.constitution,
        taxpayer_type: gstFields.taxpayer_type,
        gst_registration_date: gstFields.gst_registration_date,
        gst_last_updated: gstFields.gst_last_updated,
        state: gstFields.state,
        state_code: gstFields.state_code,
        pan: gstFields.pan,
        registered_address: gstFields.registered_address,
        district: gstFields.district,
        nature_of_business: gstFields.nature_of_business,
        gst_raw: gstFields, // fine even if it's already-mapped data on reuse
        gst_fetched_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    )
    .select()
    .single();

  if (error) {
    console.error("[company] supabase error:", error.message);
    return res.status(500).json({ success: false, message: "Couldn't save your company details. Try again." });
  }

  await supabaseAdmin
    .from("profiles")
    .update({ onboarding_step: "done" })
    .eq("id", req.user.id);

  if (verificationStatus === "verified") {
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("email, name")
      .eq("id", req.user.id)
      .single();
    if (profile?.email) {
      sendBusinessVerifiedEmail(profile.email, businessProfile.company_name).catch((e) =>
        console.error("[company] verified email failed:", e.message)
      );
    }
  }

  return res.json({ success: true, verificationStatus });
}

// GET /api/auth/me
// Also handles the "first time this user's JWT has hit the backend"
// case for email logins — the phone dev-bypass creates its own profile
// row eagerly, but Supabase email OTP doesn't touch our `profiles` table
// at all, so we upsert one here if it's missing.
// GET /api/auth/me
export async function getMe(req, res) {
  let { data: profile, error: profileErr } = await supabaseAdmin
    .from("profiles")
    .select("id, phone, phone_verified, email, email_verified, name, designation, onboarding_step, created_at")
    .eq("id", req.user.id)
    .maybeSingle();

  if (profileErr) {
    console.error("[me] supabase error:", profileErr.message);
    return res.status(500).json({ success: false, message: "Couldn't load your profile." });
  }

  if (!profile) {
    if (req.user.auth_mode === "dev_bypass") {
      return res.status(401).json({ success: false, message: "Session out of date — please log in again." });
    }

    // Confirm the auth.users row still exists before attempting the insert.
    // A JWT can still verify (signature/expiry are fine) even after the
    // underlying user was deleted — jwtVerify against the JWKS never checks this.
    const { data: authUser, error: authUserErr } =
      await supabaseAdmin.auth.admin.getUserById(req.user.id);

    if (authUserErr || !authUser?.user) {
      return res.status(401).json({ success: false, message: "Session out of date — please log in again." });
    }

    const { data: created, error: createErr } = await supabaseAdmin
      .from("profiles")
      .insert({
        id: req.user.id,
        email: req.user.email || null,
        email_verified: !!req.user.email,
        onboarding_step: "contact",
      })
      .select("id, phone, phone_verified, email, email_verified, name, designation, onboarding_step, created_at")
      .single();
    if (createErr) {
      console.error("[me] profile create failed:", createErr.message);
      return res.status(500).json({ success: false, message: "Couldn't load your profile." });
    }
    profile = created;
  }

  const { data: businessProfile } = await supabaseAdmin
    .from("business_profiles")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();

  return res.json({ success: true, profile, businessProfile: businessProfile || null });
}