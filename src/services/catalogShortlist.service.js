// backend/services/catalogShortlist.service.js
//
// Embedding-based shortlist so nothing in the resolver ever needs a full
// table dump — cost stays flat as the catalog grows. Covers all four
// levels: brands (checked first, most specific), then products,
// subcategories, then categories.
//
// FIX (product duplicate bug): the embedding shortlist alone was letting
// products like "Engine Oil" / "10W-40 Engine Oil" / "Passenger Car Engine
// Oil" pile up as separate rows in the same subcategory, because the
// products array here was a *global* top-10 by raw text similarity to the
// query — not scoped to "what already exists in the subcategory this term
// is about to land in." A true sibling product can easily fall outside a
// global top 10 purely on embedding distance even though a human would
// instantly recognize it as the same product line. See the "completeness
// supplement" block below.

import { supabase } from "../config/supabase.js";
import { embedText } from "./embeddings.service.js";

const SHORTLIST_SIZE = 10;

// Below this, the "top" subcategory embedding match is too weak to trust
// for supplementing — the query is probably genuinely novel, so we don't
// want to drag an unrelated subcategory's whole product list in as noise.
const SUBCATEGORY_SUPPLEMENT_FLOOR = 0.55;
const MAX_SUPPLEMENT_SUBCATEGORIES = 2;

export async function getShortlists(query) {
    const embedding = await embedText(query);

    const [
        { data: categories, error: catErr },
        { data: subcategories, error: subErr },
        { data: products, error: prodErr },
        { data: brands, error: brandErr },
    ] = await Promise.all([
        supabase.rpc("match_categories", { query_embedding: embedding, match_count: SHORTLIST_SIZE }),
        supabase.rpc("match_subcategories", { query_embedding: embedding, match_count: SHORTLIST_SIZE }),
        supabase.rpc("match_products", { query_embedding: embedding, match_count: SHORTLIST_SIZE }),
        supabase.rpc("match_product_brands", { query_embedding: embedding, match_count: SHORTLIST_SIZE }),
    ]);
    if (catErr) throw catErr;
    if (subErr) throw subErr;
    if (prodErr) throw prodErr;
    if (brandErr) throw brandErr;

    const subcategoryList = subcategories || [];
    const productList = products || [];

    // ---- completeness supplement ----
    // Once we have a reasonable guess at the subcategory (from the
    // shortlist we just fetched), pull EVERY existing product filed under
    // it directly — a plain filtered query, no embedding math. Subcategories
    // realistically hold a handful to a few dozen products, so this is a
    // cheap read, and it's the only way to *guarantee* the classifier sees
    // every real sibling instead of hoping embedding similarity surfaces it.
    //
    // These supplemented rows get similarity: 0 so they can never trigger
    // the automatic embedding-floor override in resolveProduct() — they
    // exist purely to widen what the LLM is shown, not to bypass it.
    const supplementSubcategoryIds = subcategoryList
        .filter((s) => s.similarity >= SUBCATEGORY_SUPPLEMENT_FLOOR)
        .slice(0, MAX_SUPPLEMENT_SUBCATEGORIES)
        .map((s) => s.id);

    if (supplementSubcategoryIds.length) {
        const { data: siblingProducts, error: siblingErr } = await supabase
            .from("hs_products")
            .select("id, name, subcategory_id, hs_subcategories(name, category_id, hs_categories(name))")
            .in("subcategory_id", supplementSubcategoryIds);
        if (siblingErr) throw siblingErr;

        const seenIds = new Set(productList.map((p) => p.id));
        for (const row of siblingProducts || []) {
            if (seenIds.has(row.id)) continue;
            seenIds.add(row.id);
            productList.push({
                id: row.id,
                name: row.name,
                subcategory_id: row.subcategory_id,
                subcategory_name: row.hs_subcategories?.name,
                category_name: row.hs_subcategories?.hs_categories?.name,
                similarity: 0, // display-only candidate — not eligible for the auto-override floor
            });
        }
    }

    return {
        embedding,
        categories: categories || [],
        subcategories: subcategoryList,
        products: productList,
        brands: brands || [],
    };
}