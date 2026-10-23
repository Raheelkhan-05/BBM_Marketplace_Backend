// services/catalogMapping.service.js
// The single place that maps catalog brand items to a generic product.
import { supabase } from "../config/supabase.js";

export async function genericProductUsable(id) {
    const { data, error } = await supabase.from("hs_generic_products")
        .select("id, review_status").eq("id", id).is("deleted_at", null).maybeSingle();
    if (error) throw error;
    return !!data && data.review_status !== "rejected";
}

// onlyUnmapped: leave brand items that already have a generic product untouched.
export async function mapBrandItems(ids, parentId, { onlyUnmapped = false } = {}) {
    let updated = 0;
    for (let i = 0; i < ids.length; i += 100) {
        let q = supabase.from("hs_generic_product_brands")
            .update({ generic_product_id: parentId }).in("id", ids.slice(i, i + 100)).is("deleted_at", null);
        if (onlyUnmapped) q = q.is("generic_product_id", null);
        const { data, error } = await q.select("id");
        if (error) throw error;
        updated += data?.length || 0;
    }
    return updated;
}