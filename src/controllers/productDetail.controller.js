// backend/controllers/productDetail.controller.js
import { supabase } from "../config/supabase.js";

// GET /api/products/:id
// Single product page — pulls the product itself, its category chain,
// the brands that sell it, and how many active sellers list it.
export async function getProductDetail(req, res) {
    const { id } = req.params;

    const { data: product, error } = await supabase
        .from("hs_products")
        .select(`
            id, name, slug, image, description, generic_name,
            variants, attributes, is_ai_generated,
            subcategory:hs_subcategories (
                id, name, slug,
                category:hs_categories ( id, name, slug )
            )
        `)
        .eq("id", id)
        .single();

    if (error || !product) {
        return res.status(404).json({ success: false, message: "Product not found." });
    }

    const [brandsRes, sellerCountRes] = await Promise.all([
        supabase
            .from("hs_product_brands")
            .select("id, name, brand_name, image, slug")
            .eq("product_id", id)
            .order("name")
            .limit(12),
        supabase
            .from("hs_product_sellers")
            .select("id", { count: "exact", head: true })
            .eq("product_id", id)
            .eq("is_active", true),
    ]);

    res.json({
        success: true,
        product,
        brands: brandsRes.data || [],
        sellerCount: sellerCountRes.count || 0,
    });
}