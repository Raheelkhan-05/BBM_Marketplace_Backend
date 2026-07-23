import { supabase } from "../config/supabase.js";
import { notifyUser } from "../utils/notify.js";

// Same allowlist used by the seller-facing save endpoint — admin can touch
// any of these too, but never status/shop_slug/user_id directly (those go
// through the dedicated approve/reject endpoints to keep audit fields honest).
const EDITABLE_FIELDS = [
  "display_name", "business_type", "industry", "categories", "products_brands",
  "year_established", "employee_range", "annual_turnover", "show_turnover_publicly",
  "contact_person", "designation", "whatsapp_number", "website",
  "address", "pincode", "city", "state", "country",
  "logo_url", "banner_url", "description", "brochure_url", "video_url",
  "pan", "iec_code", "udyam_number", "cin",
  "manufacturing_facility", "export_countries", "industries_served", "production_capacity",
  "linkedin_url", "facebook_url", "instagram_url", "youtube_url",
  "primary_color", "secondary_color",
];

export async function listSellers(req, res) {
  const { status = "pending_review", q } = req.query;
  let query = supabase.from("seller_profiles").select("id, display_name, business_type, city, state, status, submitted_at, shop_slug, logo_url").order("submitted_at", { ascending: false, nullsFirst: false });
  if (status !== "all") query = query.eq("status", status);
  if (q) query = query.ilike("display_name", `%${q}%`);

  const { data, error } = await query;
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, sellers: data });
}

export async function getSellerDetail(req, res) {
  const { id } = req.params;
  const [{ data: seller, error }, { data: photos }, { data: certifications }] = await Promise.all([
    supabase.from("seller_profiles").select("*, profiles:user_id(name, phone, email)").eq("id", id).maybeSingle(),
    supabase.from("seller_photos").select("*").eq("seller_id", id).order("sort_order"),
    supabase.from("seller_certifications").select("*").eq("seller_id", id),
  ]);
  if (error || !seller) return res.status(404).json({ success: false, message: "Seller not found." });
  res.json({ success: true, seller, photos: photos || [], certifications: certifications || [] });
}

export async function updateSellerAsAdmin(req, res) {
  const { id } = req.params;
  const body = req.body || {};
  const update = {};
  for (const key of EDITABLE_FIELDS) if (body[key] !== undefined) update[key] = body[key];
  if (!Object.keys(update).length) return res.status(400).json({ success: false, message: "No editable fields provided." });

  const { data, error } = await supabase.from("seller_profiles").update(update).eq("id", id).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });

  // Only notify if the shop is already live — no point pinging a seller
  // still mid-review that "an admin updated your draft".
  if (data.status === "approved") {
    notifyUser({
      userId: data.user_id, type: "seller_updated_by_admin",
      title: "Your shop details were updated by our team",
      body: "An administrator made changes to your shop profile.",
      link: `/shop/${data.shop_slug}`,
    }).catch(() => {});
  }

  res.json({ success: true, seller: data });
}

export async function approveSeller(req, res) {
  const { id } = req.params;
  const adminId = req.user.id;

  const { data: seller, error } = await supabase
    .from("seller_profiles")
    .update({ status: "approved", reviewed_at: new Date().toISOString(), reviewed_by: adminId, rejection_reason: null })
    .eq("id", id)
    .select("*, profiles:user_id(email, phone, name)")
    .single();
  if (error) return res.status(500).json({ success: false, message: error.message });

  notifyUser({
    userId: seller.user_id, type: "seller_approved",
    title: "Your shop is live! 🎉",
    body: `${seller.display_name} is now visible to buyers on BBM.`,
    link: `/shop/${seller.shop_slug}`,
    email: seller.profiles?.email,
    emailSubject: "Your BBM seller shop is now live",
    emailHtml: `<p>Hi ${seller.profiles?.name || "there"},</p><p>Great news — your shop <strong>${seller.display_name}</strong> has been approved and is now live to buyers.</p><p><a href="${process.env.APP_BASE_URL}/shop/${seller.shop_slug}">View your shop</a></p>`,
  }).catch((e) => console.error("[approveSeller] notify failed", e));

  res.json({ success: true, seller });
}

export async function rejectSeller(req, res) {
  const { id } = req.params;
  const { reason } = req.body || {};
  if (!reason?.trim()) return res.status(400).json({ success: false, message: "A rejection reason is required." });

  const adminId = req.user.id;
  const { data: seller, error } = await supabase
    .from("seller_profiles")
    .update({ status: "rejected", reviewed_at: new Date().toISOString(), reviewed_by: adminId, rejection_reason: reason.trim() })
    .eq("id", id)
    .select("*, profiles:user_id(email, name)")
    .single();
  if (error) return res.status(500).json({ success: false, message: error.message });

  notifyUser({
    userId: seller.user_id, type: "seller_rejected",
    title: "Action needed on your shop details",
    body: reason.trim(),
    link: "/seller/onboarding",
    email: seller.profiles?.email,
    emailSubject: "Update needed on your BBM seller application",
    emailHtml: `<p>Hi ${seller.profiles?.name || "there"},</p><p>We reviewed your seller application for <strong>${seller.display_name}</strong> and need a few changes before approving it:</p><blockquote>${reason.trim()}</blockquote><p><a href="${process.env.APP_BASE_URL}/seller/onboarding">Update your details</a></p>`,
  }).catch((e) => console.error("[rejectSeller] notify failed", e));

  res.json({ success: true, seller });
}

// Search users by phone/email/name to promote — small result set, no need for pagination yet
export async function searchUsers(req, res) {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json({ success: true, users: [] });

  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, phone, email, role, created_at")
    .or(`phone.ilike.%${q}%,email.ilike.%${q}%,name.ilike.%${q}%`)
    .limit(15);

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, users: data });
}

export async function listAdmins(req, res) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, phone, email, role, created_at")
    .eq("role", "admin")
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, admins: data });
}

export async function promoteToAdmin(req, res) {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ success: false, message: "userId is required." });

  const { data, error } = await supabase.from("profiles").update({ role: "admin" }).eq("id", userId).select("id, name, email, phone, role").single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, profile: data });
}

export async function demoteAdmin(req, res) {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ success: false, message: "userId is required." });

  // Prevent an admin from demoting themselves and locking everyone out if
  // they're the only one — and prevent removing the last admin entirely.
  if (userId === req.user.id) {
    return res.status(400).json({ success: false, message: "You can't remove your own admin access." });
  }
  const { count } = await supabase.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin");
  if (count <= 1) {
    return res.status(400).json({ success: false, message: "At least one admin must remain." });
  }

  const { data, error } = await supabase.from("profiles").update({ role: "user" }).eq("id", userId).select("id, name, email, phone, role").single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, profile: data });
}