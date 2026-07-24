import { supabase } from "../config/supabase.js";

export async function getShopBySlug(req, res) {
  const { slug } = req.params;

  const { data: seller, error } = await supabase
    .from("seller_profiles")
    .select("*")
    .eq("shop_slug", slug)
    .eq("status", "approved") // never expose unapproved shops publicly
    .maybeSingle();

  if (error || !seller) return res.status(404).json({ success: false, message: "Shop not found." });

  const [{ data: photos }, { data: certifications }, { data: products }] = await Promise.all([
    supabase.from("seller_photos").select("category, url").eq("seller_id", seller.id).eq("pending", false).order("sort_order"),
    supabase.from("seller_certifications").select("type, name, issued_by, issued_date, file_url").eq("seller_id", seller.id).eq("pending", false),
    supabase.from("seller_products").select("*").eq("seller_id", seller.id).eq("is_active", true).order("sort_order"),
  ]);

  // Strip internal-only fields before sending to the public
  const { user_id, business_profile_id, reviewed_by, rejection_reason, annual_turnover, show_turnover_publicly, pan, cin, ...publicSeller } = seller;

  res.json({
    success: true,
    seller: { ...publicSeller, annual_turnover: show_turnover_publicly ? annual_turnover : null },
    photos: photos || [],
    certifications: certifications || [],
    products: products || [],
  });
}