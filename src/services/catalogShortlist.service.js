// backend/services/catalogShortlist.service.js
//
// Embedding-based shortlist so nothing in the resolver ever needs a full
// table dump — cost stays flat as the catalog grows. Covers all four
// levels: brands (checked first, most specific), then products,
// subcategories, then categories.

import { supabase } from "../config/supabase.js";
import { embedText } from "./embeddings.service.js";

const SHORTLIST_SIZE = 10;

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

    return {
        embedding,
        categories: categories || [],
        subcategories: subcategories || [],
        products: products || [],
        brands: brands || [],
    };
}