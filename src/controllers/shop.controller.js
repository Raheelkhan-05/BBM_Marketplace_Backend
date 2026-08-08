import { supabase } from "../config/supabase.js";

// See catalogHierarchySearch.controller.js for the same pattern — search
// terms can contain characters meaningful to ILIKE (%, _) or to
// PostgREST's .or() filter syntax (, ( ) "), e.g. a term with a comma
// and a percent sign like "...Size, 200 g 8% off" will otherwise get
// split mid-string by .or() and have its % read as a wildcard, so the
// query either 500s or silently matches nothing.

// Escapes ILIKE wildcard characters so they're matched literally.
function escapeIlike(term) {
  return term.replace(/[%_\\]/g, (m) => `\\${m}`);
}

// Wraps any raw value in PostgREST's quoted-value syntax so it can sit
// safely inside a comma-separated .or() filter list, even if it itself
// contains commas, parentheses, or quotes.
function orValue(raw) {
  return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function orIlikePattern(term) {
  return orValue(`%${escapeIlike(term)}%`);
}

// .cs. (array-contains) expects a JSON array literal as its value —
// JSON.stringify handles quoting/escaping the term correctly inside the
// array, then orValue quotes the whole literal so its own top-level
// commas/parens don't get mistaken for .or() separators.
function orContainsPattern(term) {
  return orValue(JSON.stringify([term]));
}

export async function getShopBySlug(req, res) {
  const { slug } = req.params;

  const { data: seller, error } = await supabase
    .from("seller_profiles")
    .select("*")
    .eq("shop_slug", slug)
    .eq("status", "approved")
    .maybeSingle();

  if (error || !seller) return res.status(404).json({ success: false, message: "Shop not found." });

  const [{ data: photos }, { data: certifications }, { data: submissions }] = await Promise.all([
    supabase.from("seller_photos").select("category, url").eq("seller_id", seller.id).eq("pending", false).order("sort_order"),
    supabase.from("seller_certifications").select("type, name, issued_by, issued_date, file_url").eq("seller_id", seller.id).eq("pending", false),
    supabase
      .from("seller_product_submissions")
      .select(`
      id, price, moq, unit, lead_time, image, review_status, created_at,
      brand:hs_generic_product_brands (
        id, name, brand_name, image,
        generic_product:hs_generic_products (
          id, name,
          subcategory:hs_subcategories (
            id, name,
            category:hs_categories ( id, name )
          )
        )
      )
    `)
      .eq("seller_id", seller.id)
      .eq("review_status", "approved") // public storefront: approved only, never pending or rejected
      .order("created_at", { ascending: false }),
  ]);

  // Flatten into { id, name, brand_name, image_url, price, unit, moq,
  // lead_time, pending_approval, category, subcategory, generic_product }
  // so the frontend can group without knowing about the join shape.
  const products = (submissions || []).map((s) => {
    const gp = s.brand?.generic_product;
    const sub = gp?.subcategory;
    const cat = sub?.category;
    return {
      id: s.id,
      name: s.brand?.name || "Product",
      brand_name: s.brand?.brand_name || null,
      image_url: s.image || s.brand?.image || null,
      price: s.price,
      unit: s.unit,
      moq: s.moq,
      lead_time: s.lead_time,
      pending_approval: s.review_status === "pending_review",
      category: cat ? { id: cat.id, name: cat.name } : null,
      subcategory: sub ? { id: sub.id, name: sub.name } : null,
      generic_product: gp ? { id: gp.id, name: gp.name } : null,
    };
  });

  const { user_id, business_profile_id, reviewed_by, rejection_reason, annual_turnover, show_turnover_publicly, pan, cin, ...publicSeller } = seller;

  res.json({
    success: true,
    seller: { ...publicSeller, annual_turnover: show_turnover_publicly ? annual_turnover : null },
    photos: photos || [],
    certifications: certifications || [],
    products,
  });
}

// GET /api/shop/search?q=steel&limit=8
export async function searchShops(req, res) {
  const { q, limit = 8 } = req.query;
  if (!q || q.trim().length < 2) return res.json({ success: true, shops: [] });

  const term = q.trim();
  const namePattern = orIlikePattern(term);
  const arrayPattern = orContainsPattern(term);

  const { data, error } = await supabase
    .from("seller_profiles")
    .select("id, shop_slug, display_name, logo_url, city, state, business_type, categories, products_brands")
    .eq("status", "approved") // only ever surface live, approved shops publicly
    .or(`display_name.ilike.${namePattern},categories.cs.${arrayPattern},products_brands.cs.${arrayPattern}`)
    .order("display_name")
    .limit(Number(limit) || 8);

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, shops: data || [] });
}