// scripts/fix-imgbb-links.js
// One-off: resolves ibb.co viewer links -> real i.ibb.co direct links
// by scraping the og:image meta tag off each viewer page, then updates
// every row in hs_generic_product_brands whose `image` column still
// points at a viewer page.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://xbkqwpeuoruijrwxvqga.supabase.co"
const SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhia3F3cGV1b3J1aWpyd3h2cWdhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDYwMjQ2MSwiZXhwIjoyMTAwMTc4NDYxfQ.xx4X7cpdP98Qzc3ljASZtXFhnSTHRFyya-LehU9OdLU"


const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY // needs write access
);

async function resolveDirectImageUrl(viewerUrl) {
    const res = await fetch(viewerUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${viewerUrl}`);
    const html = await res.text();
    const match = html.match(/<meta property="og:image" content="([^"]+)"/);
    if (!match) throw new Error(`No og:image found on ${viewerUrl}`);
    return match[1];
}

async function main() {
    // Pull every brand-item row whose image is still an ibb.co viewer link
    const { data: rows, error } = await supabase
        .from("hs_generic_product_brands")
        .select("id, image")
        .ilike("image", "https://ibb.co/%");

    if (error) throw error;
    console.log(`Found ${rows.length} rows to fix.`);

    for (const row of rows) {
        try {
            const direct = await resolveDirectImageUrl(row.image);
            const { error: updErr } = await supabase
                .from("hs_generic_product_brands")
                .update({ image: direct })
                .eq("id", row.id);
            if (updErr) throw updErr;
            console.log(`✔ ${row.id}: ${row.image} -> ${direct}`);
        } catch (e) {
            console.error(`✘ ${row.id} (${row.image}) failed: ${e.message}`);
        }
        // gentle pacing so we don't hammer imgbb
        await new Promise((r) => setTimeout(r, 300));
    }

    console.log("Done.");
}

main();