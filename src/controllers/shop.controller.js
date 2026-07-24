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

// GET /api/shop/search?q=steel&limit=8
export async function searchShops(req, res) {
  const { q, limit = 8 } = req.query;
  if (!q || q.trim().length < 2) return res.json({ success: true, shops: [] });

  const term = q.trim();

  const { data, error } = await supabase
    .from("seller_profiles")
    .select("id, shop_slug, display_name, logo_url, city, state, business_type, categories, products_brands")
    .eq("status", "approved") // only ever surface live, approved shops publicly
    .or(`display_name.ilike.%${term}%,categories.cs.["${term}"],products_brands.cs.["${term}"]`)
    .order("display_name")
    .limit(Number(limit) || 8);

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, shops: data || [] });
}