// scripts/mergeDuplicateCatalogProducts.js
//
// One-off / periodic admin utility — NOT part of the request-time
// pipeline, doesn't touch LLM tokens at all. Finds existing hs_products
// rows within the same subcategory whose stored embeddings are highly
// similar — i.e. likely duplicates created before the dedup fix, like your
// "Engine Oil" / "10W-40 Engine Oil" / "Passenger Car Engine Oil" trio —
// and reports (or merges) them onto a single canonical row.
//
// Check the table/column names below against your actual schema before
// running for real (hs_product_sellers in particular — adjust to whatever
// your seller-listing table is actually called).
//
// Usage:
//   node scripts/mergeDuplicateCatalogProducts.js --dry-run   (review only)
//   node scripts/mergeDuplicateCatalogProducts.js             (actually merges)
//
// Run with --dry-run first, review the printed candidates yourself, and
// only run for real once you're confident none of the flagged pairs are
// genuinely distinct products that just happen to be textually close
// (e.g. "Hydraulic Oil" vs "Gear Oil" could plausibly embed close together
// depending on your data — a merge there would be wrong).

import "dotenv/config";
import { supabase } from "../config/supabase.js";

const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Deliberately conservative — a false merge (deleting a real distinct
// product) is worse than leaving some leftover duplicates for manual
// review, so this sits above the request-time PRODUCT_DEDUPE_FLOOR (0.78).
const MERGE_THRESHOLD = 0.75;

function cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function run({ dryRun }) {
    const { data: products, error } = await supabase
        .from("hs_products")
        .select("id, name, subcategory_id, embedding, created_at")
        .order("subcategory_id");
    if (error) throw error;

    const bySubcategory = new Map();
    for (const p of products) {
        if (!bySubcategory.has(p.subcategory_id)) bySubcategory.set(p.subcategory_id, []);
        bySubcategory.get(p.subcategory_id).push(p);
    }

    let candidateCount = 0;

    for (const rows of bySubcategory.values()) {
        if (rows.length < 2) continue;
        for (let i = 0; i < rows.length; i++) {
            for (let j = i + 1; j < rows.length; j++) {
                if (!rows[i].embedding || !rows[j].embedding) continue;
                const sim = cosineSim(rows[i].embedding, rows[j].embedding);
                if (sim < MERGE_THRESHOLD) continue;

                // Canonical = older row — more likely to already have
                // sellers/brands attached to it.
                const [canonical, dupe] =
                    rows[i].created_at < rows[j].created_at ? [rows[i], rows[j]] : [rows[j], rows[i]];

                candidateCount++;
                console.log(
                    `[MERGE CANDIDATE] "${dupe.name}" (${dupe.id}) -> "${canonical.name}" (${canonical.id}) ` +
                    `— similarity ${sim.toFixed(3)}`
                );

                if (dryRun) continue;

                await supabase.from("hs_product_brands").update({ product_id: canonical.id }).eq("product_id", dupe.id);
                await supabase.from("hs_product_sellers").update({ product_id: canonical.id }).eq("product_id", dupe.id);
                await supabase.from("hs_products").delete().eq("id", dupe.id);
            }
        }
    }

    console.log(`\n${candidateCount} candidate pair(s) found.`);
}

const dryRun = process.argv.includes("--dry-run");
run({ dryRun })
    .then(() => console.log(dryRun ? "Dry run complete — no changes made." : "Merge complete."))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });