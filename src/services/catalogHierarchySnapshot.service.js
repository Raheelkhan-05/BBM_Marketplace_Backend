// backend/services/catalogHierarchySnapshot.service.js
//
// Feeds the AI a compact view of what already exists so it reuses names
// instead of creating near-duplicate categories/subcategories. Cached
// briefly since it's read on every AI-resolve call but changes rarely.
//
// NOTE: this dumps the full category/subcategory list into the prompt,
// capped below. Fine for a catalog of dozens-to-low-hundreds of entries.
// If your catalog grows into the thousands, swap this for an embedding-
// based shortlist (fetch only the ~15 most semantically similar entries)
// instead of a full dump — the full dump would start costing real tokens
// on every single search.

import { supabase } from "../config/supabase.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CATEGORIES = 120;
const MAX_SUBS_PER_CATEGORY = 12;

let cache = { text: "", categories: [], subcategories: [], expiresAt: 0 };

export async function getHierarchySnapshot() {
    if (cache.expiresAt > Date.now()) return cache;

    const [{ data: categories }, { data: subcategories }] = await Promise.all([
        supabase.from("hs_categories").select("id, name").order("name").limit(MAX_CATEGORIES),
        supabase.from("hs_subcategories").select("id, name, category_id").order("name"),
    ]);

    const byCategory = new Map();
    for (const sub of subcategories || []) {
        const list = byCategory.get(sub.category_id) || [];
        if (list.length < MAX_SUBS_PER_CATEGORY) list.push(sub.name);
        byCategory.set(sub.category_id, list);
    }

    const lines = (categories || []).map((c) => {
        const subs = byCategory.get(c.id) || [];
        return subs.length ? `${c.name} > ${subs.join(", ")}` : c.name;
    });

    cache = {
        text: lines.join("\n"),
        categories: categories || [],
        subcategories: subcategories || [],
        expiresAt: Date.now() + CACHE_TTL_MS,
    };
    return cache;
}

// Loose equality for catching phrasing variants ("Stationery & Office
// Supplies" vs "stationery and office supplies") without another AI call.
export function normalizeName(name = "") {
    return name
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

export function invalidateHierarchyCache() {
    cache.expiresAt = 0;
}