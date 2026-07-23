import { supabase } from "../config/supabase.js";
import { notifyAdmins } from "../utils/notify.js";

const REQUIRED_FIELDS = [
  "display_name", "business_type", "industry", "categories", "products_brands",
  "year_established", "contact_person", "designation", "whatsapp_number",
  "address", "pincode", "city", "state", "logo_url", "banner_url",
  "description", "brochure_url",
];

// Only these keys are writable from the client — never trust an arbitrary payload
const WRITABLE_FIELDS = [
  "display_name", "business_type", "industry", "categories", "products_brands",
  "year_established", "employee_range", "annual_turnover", "show_turnover_publicly",
  "contact_person", "designation", "whatsapp_number", "website",
  "address", "pincode", "city", "state", "country",
  "logo_url", "banner_url", "description", "brochure_url", "video_url",
  "pan", "iec_code", "udyam_number", "cin",
  "manufacturing_facility", "export_countries", "industries_served", "production_capacity",
  "linkedin_url", "facebook_url", "instagram_url", "youtube_url",
  "primary_color", "secondary_color",
  "onboarding_step",
];

function slugify(str) {
  return str.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
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

// GET /api/seller/onboarding — prefill + any saved progress
export async function getSellerOnboarding(req, res) {
  const userId = req.user.id;

  const [{ data: profile }, { data: business }, { data: seller }] = await Promise.all([
    supabase.from("profiles").select("name, phone, phone_verified, email, email_verified").eq("id", userId).maybeSingle(),
    supabase.from("business_profiles").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("seller_profiles").select("*").eq("user_id", userId).maybeSingle(),
  ]);

  let photos = [];
  let certifications = [];
  if (seller) {
    const [{ data: p }, { data: c }] = await Promise.all([
      supabase.from("seller_photos").select("*").eq("seller_id", seller.id).order("sort_order"),
      supabase.from("seller_certifications").select("*").eq("seller_id", seller.id),
    ]);
    photos = p || [];
    certifications = c || [];
  }

  res.json({
    success: true,
    profile,
    business,     // GST-derived data to prefill company name, PAN, address, etc.
    seller,       // null if seller hasn't started onboarding yet
    photos,
    certifications,
  });
}

// POST /api/seller/onboarding/save — partial autosave, called on each step
export async function saveSellerOnboarding(req, res) {
  const userId = req.user.id;
  const body = req.body || {};

  const update = {};
  for (const key of WRITABLE_FIELDS) {
    if (body[key] !== undefined) update[key] = body[key];
  }

  const { data: business } = await supabase.from("business_profiles").select("id").eq("user_id", userId).maybeSingle();

  const { data, error } = await supabase
    .from("seller_profiles")
    .upsert(
      { user_id: userId, business_profile_id: business?.id ?? null, status: "draft", ...update },
      { onConflict: "user_id" }
    )
    .select()
    .single();

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, seller: data });
}

// POST /api/seller/onboarding/submit
export async function submitSellerOnboarding(req, res) {
  const userId = req.user.id;
  const body = req.body || {};

  const update = {};
  for (const key of WRITABLE_FIELDS) {
    if (body[key] !== undefined) update[key] = body[key];
  }

  const merged = { user_id: userId, ...update };
  const missing = REQUIRED_FIELDS.filter((f) => {
    const v = merged[f];
    return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
  });
  // Note: for fields already saved in a prior step but not resent in this payload,
  // re-fetch and merge before validating so we don't false-flag them as missing.
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
    .upsert(
      { user_id: userId, ...update, shop_slug: shopSlug, status: "pending_review", submitted_at: new Date().toISOString() },
      { onConflict: "user_id" }
    )
    .select()
    .single();

  if (error) return res.status(500).json({ success: false, message: error.message });

  // replace the TODO comment from earlier with:
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

// POST /api/seller/upload — multipart, field name "file"
export async function uploadSellerFile(req, res) {
  const userId = req.user.id;
  const { folder = "misc", bucket = "seller-assets" } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ success: false, message: "No file provided." });

  const ext = (file.originalname.split(".").pop() || "bin").toLowerCase();
  const path = `${userId}/${folder}/${Date.now()}.${ext}`;

  const { error } = await supabase.storage.from(bucket).upload(path, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
  });
  if (error) return res.status(500).json({ success: false, message: error.message });

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  res.json({ success: true, url: data.publicUrl, path });
}