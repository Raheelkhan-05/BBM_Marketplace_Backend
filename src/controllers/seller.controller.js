import { supabase } from "../config/supabase.js";
import { notifyAdmins, notifyUser } from "../utils/notify.js";
import { sendOtp, verifyOtpCode } from "../utils/otp.js";

const REQUIRED_FIELDS = [
  "display_name", "business_type", "year_established",
  "contact_person", "whatsapp_number",
  "address", "pincode", "city", "state", "logo_url",
];

// Fields that require re-review once a shop is already approved
const GATED_FIELDS = [
  "display_name", "business_type", "year_established", "employee_range", "annual_turnover",
  "contact_person", "whatsapp_number", "whatsapp_verified", "website",
  "address", "pincode", "city", "state", "country", "dispatch_same_as_registered",
  "logo_url", "primary_color", "secondary_color",
  "pan", "iec_code", "udyam_number", "cin",
  "export_countries", "working_days", "order_acceptance_start", "order_acceptance_end", "holidays",
];

const THEME_FIELDS = ["primary_color", "secondary_color"];

const WRITABLE_FIELDS = [...GATED_FIELDS, "onboarding_step"];

function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
async function generateUniqueSlug(base) {
  let slug = slugify(base) || "shop";
  let suffix = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await supabase.from("seller_profiles").select("id").eq("shop_slug", slug).maybeSingle();
    if (!data) return slug;
    suffix += 1;
    slug = `${slugify(base)}-${suffix}`;
  }
}

function mergeEffective(seller) {
  if (!seller) return seller;
  if (!seller.has_pending_changes || !seller.pending_changes) return { ...seller, is_preview: false };
  return { ...seller, ...seller.pending_changes, is_preview: true };
}

// New: WhatsApp OTP for onboarding. If the number matches the account's
// already-verified phone, the frontend skips this entirely and just sets
// whatsapp_verified = true directly via saveSellerProgress.
export async function requestSellerWhatsappOtp(req, res) {
  const { whatsapp_number } = req.body || {};
  if (!/^\d{10}$/.test(whatsapp_number || "")) {
    return res.status(400).json({ success: false, message: "Enter a valid 10-digit number." });
  }
  try {
    await sendOtp(whatsapp_number);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || "Couldn't send OTP." });
  }
}

export async function verifySellerWhatsappOtp(req, res) {
  const userId = req.user.id;
  const { whatsapp_number, otp } = req.body || {};
  const ok = await verifyOtpCode(whatsapp_number, otp);
  if (!ok) return res.status(400).json({ success: false, message: "Incorrect or expired OTP." });

  const { data, error } = await supabase
    .from("seller_profiles")
    .update({ whatsapp_number, whatsapp_verified: true })
    .eq("user_id", userId)
    .select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, seller: data });
}

// ---------- Onboarding (pre-approval) ----------
// getSellerOnboarding — attach the full GST reference block (business_profiles),
// so the frontend can render it as read-only context without a second fetch.
export async function getSellerOnboarding(req, res) {
  const userId = req.user.id;
  const [{ data: profile }, { data: business }, { data: seller }] = await Promise.all([
    supabase.from("profiles").select("name, phone, phone_verified, email, email_verified").eq("id", userId).maybeSingle(),
    supabase.from("business_profiles").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("seller_profiles").select("*").eq("user_id", userId).maybeSingle(),
  ]);

  let photos = [], certifications = [];
  if (seller) {
    const [{ data: p }, { data: c }] = await Promise.all([
      supabase.from("seller_photos").select("*").eq("seller_id", seller.id).order("sort_order"),
      supabase.from("seller_certifications").select("*").eq("seller_id", seller.id),
    ]);
    photos = p || []; certifications = c || [];
  }

  res.json({ success: true, profile, business, seller, photos, certifications });
}

export async function saveSellerOnboarding(req, res) {
  const userId = req.user.id;
  const body = req.body || {};
  const update = {};
  for (const key of WRITABLE_FIELDS) if (body[key] !== undefined) update[key] = body[key];

  const { data: business } = await supabase.from("business_profiles").select("id").eq("user_id", userId).maybeSingle();

  const { data, error } = await supabase
    .from("seller_profiles")
    .upsert({ user_id: userId, business_profile_id: business?.id ?? null, status: "draft", ...update }, { onConflict: "user_id" })
    .select().single();

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, seller: data });
}

// submitSellerOnboarding — add whatsapp_verified check + auto-derive
// manufacturing_facility from the GST nature_of_business array instead of
// asking the seller.
export async function submitSellerOnboarding(req, res) {
  const userId = req.user.id;
  const body = req.body || {};
  const update = {};
  for (const key of WRITABLE_FIELDS) if (body[key] !== undefined) update[key] = body[key];

  if (!update.whatsapp_verified) {
    return res.status(400).json({ success: false, message: "Please verify your WhatsApp number before submitting." });
  }

  const { data: business } = await supabase.from("business_profiles").select("id, nature_of_business").eq("user_id", userId).maybeSingle();
  update.manufacturing_facility = Array.isArray(business?.nature_of_business)
    && business.nature_of_business.some((n) => /factory|manufactur/i.test(n));

  const merged = { user_id: userId, ...update };
  const missing = REQUIRED_FIELDS.filter((f) => {
    const v = merged[f];
    return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
  });
  if (missing.length) {
    const { data: existing } = await supabase.from("seller_profiles").select("*").eq("user_id", userId).maybeSingle();
    const stillMissing = missing.filter((f) => {
      const v = existing?.[f];
      return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    });
    if (stillMissing.length) {
      return res.status(400).json({ success: false, message: "Please complete all required fields.", missing: stillMissing });
    }
  }

  const { data: existing } = await supabase.from("seller_profiles").select("id, shop_slug, display_name").eq("user_id", userId).maybeSingle();
  const displayName = merged.display_name || existing?.display_name;
  const shopSlug = existing?.shop_slug || await generateUniqueSlug(displayName);

  const { data, error } = await supabase
    .from("seller_profiles")
    .upsert({ user_id: userId, business_profile_id: business?.id ?? null, ...update, shop_slug: shopSlug, status: "pending_review", submitted_at: new Date().toISOString() }, { onConflict: "user_id" })
    .select().single();

  if (error) return res.status(500).json({ success: false, message: error.message });

  notifyAdmins({
    type: "seller_submitted",
    title: "New seller application",
    body: `${data.display_name} submitted their shop for review.`,
    link: `/admin/sellers/${data.id}`,
    emailSubject: `New seller application: ${data.display_name}`,
    emailHtml: `<p>A new seller application was submitted.</p><p><strong>${data.display_name}</strong> (${data.business_type || "—"}, ${data.city || "—"})</p><p><a href="${process.env.APP_BASE_URL}/admin/sellers/${data.id}">Review application</a></p>`,
  }).catch((e) => console.error("[submitSellerOnboarding] notify admins failed", e));

  res.json({ success: true, seller: data });
}

// ---------- Post-approval dashboard ----------

// GET /api/seller/dashboard
// getSellerDashboard — same addition, plus strip internal-only fields from
// what gets sent down so the frontend never has to remember to hide them.
const INTERNAL_FIELDS = ["onboarding_step", "user_id", "business_profile_id", "reviewed_by"];

function stripInternal(seller) {
  if (!seller) return seller;
  const clean = { ...seller };
  INTERNAL_FIELDS.forEach((f) => delete clean[f]);
  return clean;
}

export async function getSellerDashboard(req, res) {
  const userId = req.user.id;
  const { data: seller, error } = await supabase.from("seller_profiles").select("*").eq("user_id", userId).maybeSingle();
  if (error || !seller) return res.status(404).json({ success: false, message: "No shop found for this account." });

  const [{ data: business }, { data: photos }, { data: certifications }, { data: products }] = await Promise.all([
    supabase.from("business_profiles").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("seller_photos").select("*").eq("seller_id", seller.id).order("sort_order"),
    supabase.from("seller_certifications").select("*").eq("seller_id", seller.id),
    supabase.from("seller_products").select("*").eq("seller_id", seller.id).order("sort_order"),
  ]);

  res.json({
    success: true,
    seller: stripInternal(seller),
    effective: stripInternal(mergeEffective(seller)),
    business,   // full GST reference block — read-only in UI
    photos: photos || [],
    certifications: certifications || [],
    products: products || [],
  });
}

// PATCH /api/seller/profile — content edits. Pre-approval: writes live (draft/pending/rejected).
// Post-approval: stages into pending_changes and flags for re-review.
export async function updateSellerProfile(req, res) {
  const userId = req.user.id;
  const body = req.body || {};

  const { data: seller } = await supabase.from("seller_profiles").select("*").eq("user_id", userId).maybeSingle();
  if (!seller) return res.status(404).json({ success: false, message: "No shop found for this account." });

  const gatedUpdate = {};
  for (const key of GATED_FIELDS) if (body[key] !== undefined) gatedUpdate[key] = body[key];
  if (!Object.keys(gatedUpdate).length) return res.status(400).json({ success: false, message: "No fields provided." });

  if (seller.status !== "approved") {
    // Not live yet — safe to write straight through, same as onboarding save
    const { data, error } = await supabase.from("seller_profiles").update(gatedUpdate).eq("id", seller.id).select().single();
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, seller: data, staged: false });
  }

  // Already live: stage the edit
  const merged = { ...(seller.pending_changes || {}), ...gatedUpdate };
  const { data, error } = await supabase
    .from("seller_profiles")
    .update({ pending_changes: merged, has_pending_changes: true })
    .eq("id", seller.id)
    .select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });

  notifyAdmins({
    type: "seller_edit_submitted",
    title: "Shop update pending review",
    body: `${seller.display_name} updated their shop details — changes are staged, not yet live.`,
    link: `/admin/sellers/${seller.id}`,
    emailSubject: `Shop update pending review: ${seller.display_name}`,
    emailHtml: `<p><strong>${seller.display_name}</strong> edited their live shop. Changes are staged pending your review.</p><p><a href="${process.env.APP_BASE_URL}/admin/sellers/${seller.id}">Review changes</a></p>`,
  }).catch((e) => console.error("[updateSellerProfile] notify admins failed", e));

  res.json({ success: true, seller: data, staged: true });
}

// PATCH /api/seller/theme — always live immediately, no review
export async function updateSellerTheme(req, res) {
  const userId = req.user.id;
  const { primary_color, secondary_color } = req.body || {};
  const update = {};
  if (primary_color) update.primary_color = primary_color;
  if (secondary_color) update.secondary_color = secondary_color;
  if (!Object.keys(update).length) return res.status(400).json({ success: false, message: "No theme fields provided." });

  const { data, error } = await supabase.from("seller_profiles").update(update).eq("user_id", userId).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, seller: data });
}

// ---------- Uploads ----------

export async function uploadSellerFile(req, res) {
  const userId = req.user.id;
  const { folder = "misc", bucket = "seller-assets" } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ success: false, message: "No file provided." });

  const ext = (file.originalname.split(".").pop() || "bin").toLowerCase();
  const path = `${userId}/${folder}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) return res.status(500).json({ success: false, message: error.message });

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  res.json({ success: true, url: data.publicUrl, path });
}

// ---------- Photos ----------

async function getOwnedSeller(userId) {
  const { data } = await supabase.from("seller_profiles").select("id, status").eq("user_id", userId).maybeSingle();
  return data;
}

// POST /api/seller/photos  { category, url }
export async function addSellerPhoto(req, res) {
  const seller = await getOwnedSeller(req.user.id);
  if (!seller) return res.status(404).json({ success: false, message: "No shop found." });
  const { category, url } = req.body || {};
  if (!category || !url) return res.status(400).json({ success: false, message: "category and url are required." });

  const pending = seller.status === "approved"; // new photos on a live shop wait for review
  const { data, error } = await supabase
    .from("seller_photos")
    .insert({ seller_id: seller.id, category, url, pending })
    .select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });

  if (pending) {
    await supabase.from("seller_profiles").update({ has_pending_changes: true }).eq("id", seller.id);
  }
  res.json({ success: true, photo: data });
}

// DELETE /api/seller/photos/:id
export async function deleteSellerPhoto(req, res) {
  const seller = await getOwnedSeller(req.user.id);
  if (!seller) return res.status(404).json({ success: false, message: "No shop found." });
  const { error } = await supabase.from("seller_photos").delete().eq("id", req.params.id).eq("seller_id", seller.id);
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true });
}

// ---------- Certifications ----------

// POST /api/seller/certifications
export async function addSellerCertification(req, res) {
  const seller = await getOwnedSeller(req.user.id);
  if (!seller) return res.status(404).json({ success: false, message: "No shop found." });
  const { type, name, issued_by, issued_date, file_url } = req.body || {};
  if (!type || !name) return res.status(400).json({ success: false, message: "type and name are required." });

  const pending = seller.status === "approved";
  const { data, error } = await supabase
    .from("seller_certifications")
    .insert({ seller_id: seller.id, type, name, issued_by, issued_date, file_url, pending })
    .select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });

  if (pending) await supabase.from("seller_profiles").update({ has_pending_changes: true }).eq("id", seller.id);
  res.json({ success: true, certification: data });
}

// DELETE /api/seller/certifications/:id
export async function deleteSellerCertification(req, res) {
  const seller = await getOwnedSeller(req.user.id);
  if (!seller) return res.status(404).json({ success: false, message: "No shop found." });
  const { error } = await supabase.from("seller_certifications").delete().eq("id", req.params.id).eq("seller_id", seller.id);
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true });
}

// ---------- Products (ungated — live immediately) ----------

export async function listOwnSellerProducts(req, res) {
  const seller = await getOwnedSeller(req.user.id);
  if (!seller) return res.status(404).json({ success: false, message: "No shop found." });
  const { data, error } = await supabase.from("seller_products").select("*").eq("seller_id", seller.id).order("sort_order");
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, products: data });
}

export async function createSellerProduct(req, res) {
  const seller = await getOwnedSeller(req.user.id);
  if (!seller) return res.status(404).json({ success: false, message: "No shop found." });
  const { name, description, price, unit, moq, image_url } = req.body || {};
  if (!name) return res.status(400).json({ success: false, message: "Product name is required." });

  const { data, error } = await supabase
    .from("seller_products")
    .insert({ seller_id: seller.id, name, description, price, unit, moq, image_url })
    .select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, product: data });
}

export async function updateSellerProduct(req, res) {
  const seller = await getOwnedSeller(req.user.id);
  if (!seller) return res.status(404).json({ success: false, message: "No shop found." });
  const body = req.body || {};
  const update = {};
  for (const k of ["name", "description", "price", "unit", "moq", "image_url", "is_active", "sort_order"]) {
    if (body[k] !== undefined) update[k] = body[k];
  }
  const { data, error } = await supabase
    .from("seller_products").update(update).eq("id", req.params.id).eq("seller_id", seller.id).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, product: data });
}

export async function deleteSellerProduct(req, res) {
  const seller = await getOwnedSeller(req.user.id);
  if (!seller) return res.status(404).json({ success: false, message: "No shop found." });
  const { error } = await supabase.from("seller_products").delete().eq("id", req.params.id).eq("seller_id", seller.id);
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true });
}