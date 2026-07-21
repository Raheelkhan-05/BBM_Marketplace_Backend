// src/controllers/auth.controller.js

import { supabaseAdmin } from "../config/supabase.js";
import { validateGSTIN, lookupGstinWithProvider } from "../services/gst.service.js";
import {
  sendWelcomeEmail,
  sendBusinessPendingEmail,
  sendBusinessVerifiedEmail,
} from "../services/mail.service.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PINCODE_RE = /^[1-9][0-9]{5}$/;
const WHATSAPP_RE = /^[6-9]\d{9}$/;
const BUSINESS_TYPES = [
  "manufacturer", "distributor", "wholesaler",
  "retailer", "exporter", "importer", "service_provider",
];

function isSeller(roles) {
  return Array.isArray(roles) && roles.includes("seller");
}

// POST /api/auth/register  { name, email?, designation?, whatsappNumber?, roles }
// Step A: contact details. `roles` here is the user's declared intent
// (['buyer'] | ['seller'] | ['buyer','seller']) — NOT a grant of seller
// privileges; that only happens once GSTIN is verified (see runVerificationJob).
export async function registerProfile(req, res) {
  const { name, email, designation, whatsappNumber, roles } = req.body || {};

  const wantsSeller = isSeller(roles);

  if (wantsSeller) {
    if (!name || name.trim().length < 2) {
      return res.status(400).json({ success: false, message: "Contact person is required for a seller account." });
    }
    if (!designation || designation.trim().length < 2) {
      return res.status(400).json({ success: false, message: "Designation is required for a seller account." });
    }
  } else if (name && name.trim().length < 2) {
    return res.status(400).json({ success: false, message: "Enter a valid full name." });
  }

  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, message: "Enter a valid email address." });
  }
  if (whatsappNumber && !WHATSAPP_RE.test(whatsappNumber)) {
    return res.status(400).json({ success: false, message: "Enter a valid 10-digit WhatsApp number." });
  }

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .update({
      name: name?.trim() || null,
      email: email?.trim() || null,
      designation: designation?.trim() || null,
      whatsapp_number: whatsappNumber || null,
      // intent, not a grant — capped to buyer until seller verification passes
      roles: wantsSeller ? ["buyer"] : ["buyer"],
      onboarding_step: "company",
    })
    .eq("id", req.user.id)
    .select()
    .single();

  if (error) {
    console.error("[register] supabase error:", error.message);
    return res.status(500).json({ success: false, message: "Couldn't save your details. Try again." });
  }

  sendWelcomeEmail(data.email, data.name).catch((e) =>
    console.error("[register] welcome email failed:", e.message)
  );

  return res.json({ success: true, user: data, intendsToSell: wantsSeller });
}

// POST /api/auth/company
// { companyName, displayName?, businessType, industry, categories[], productsBrands[],
//   yearEstablished?, employeeCount?, annualTurnover?, turnoverVisible?, website?,
//   pincode, gstin?, wantsSeller }
// Step B: company details, shared by buyer & seller. GSTIN required only if wantsSeller.
export async function submitCompany(req, res) {
  const {
    companyName, displayName, businessType, industry,
    categories, productsBrands, yearEstablished, employeeCount,
    annualTurnover, turnoverVisible, website, pincode, gstin, wantsSeller,
  } = req.body || {};

  if (!companyName || companyName.trim().length < 2) {
    return res.status(400).json({ success: false, message: "Enter a valid company name." });
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
  if (wantsSeller && (!displayName || displayName.trim().length < 2)) {
    return res.status(400).json({ success: false, message: "Display name is required for a seller storefront." });
  }
  if (!pincode || !PINCODE_RE.test(pincode)) {
    return res.status(400).json({ success: false, message: "Enter a valid 6-digit pincode." });
  }
  if (website && !/^https?:\/\/.+/.test(website)) {
    return res.status(400).json({ success: false, message: "Website must start with http:// or https://" });
  }

  let gstCheck = { valid: true, gstin: null };
  if (wantsSeller) {
    gstCheck = validateGSTIN(gstin);
    if (!gstCheck.valid) {
      return res.status(400).json({ success: false, message: gstCheck.reason });
    }
    const { data: existing } = await supabaseAdmin
      .from("business_profiles")
      .select("id, user_id")
      .eq("gstin", gstCheck.gstin)
      .maybeSingle();
    if (existing && existing.user_id !== req.user.id) {
      return res.status(409).json({ success: false, message: "This GSTIN is already registered to another account." });
    }
  }

  const { data: businessProfile, error } = await supabaseAdmin
    .from("business_profiles")
    .upsert(
      {
        user_id: req.user.id,
        company_name: companyName.trim(),
        display_name: displayName?.trim() || null,
        business_type: businessType,
        industry: industry.trim(),
        categories,
        products_brands: productsBrands || [],
        year_established: yearEstablished || null,
        employee_count: employeeCount || null,
        annual_turnover: annualTurnover || null,
        turnover_visible: !!turnoverVisible,
        website: website?.trim() || null,
        pincode,
        gstin: wantsSeller ? gstCheck.gstin : null,
        verification_status: wantsSeller ? "pending" : "verified", // buyers need no compliance check
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

  if (!wantsSeller) {
    return res.json({ success: true, verificationStatus: "verified" });
  }

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("email")
    .eq("id", req.user.id)
    .single();

  sendBusinessPendingEmail(profile?.email, businessProfile.company_name).catch((e) =>
    console.error("[company] pending email failed:", e.message)
  );

  runVerificationJob(req.user.id, businessProfile.gstin, businessProfile.company_name, profile?.email);

  return res.json({ success: true, verificationStatus: businessProfile.verification_status });
}

async function runVerificationJob(userId, gstin, companyName, email) {
  try {
    const result = await lookupGstinWithProvider(gstin);
    if (result.verified === null) return;

    const status = result.verified ? "verified" : "rejected";
    await supabaseAdmin
      .from("business_profiles")
      .update({ verification_status: status, verified_at: new Date().toISOString() })
      .eq("gstin", gstin);

    if (status === "verified") {
      await supabaseAdmin.from("profiles").update({ roles: ["buyer", "seller"] }).eq("id", userId);
      sendBusinessVerifiedEmail(email, companyName).catch((e) =>
        console.error("[verify-job] verified email failed:", e.message)
      );
    }
  } catch (e) {
    console.error("[verify-job] failed:", e.message);
  }
}

// GET /api/auth/me
export async function getMe(req, res) {
  const { data: profile, error: profileErr } = await supabaseAdmin
    .from("profiles")
    .select("id, phone, email, name, designation, whatsapp_number, roles, onboarding_step, created_at")
    .eq("id", req.user.id)
    .maybeSingle();

  if (profileErr) {
    console.error("[me] supabase error:", profileErr.message);
    return res.status(500).json({ success: false, message: "Couldn't load your profile." });
  }

  const { data: businessProfile } = await supabaseAdmin
    .from("business_profiles")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();

  return res.json({ success: true, profile, businessProfile: businessProfile || null });
}