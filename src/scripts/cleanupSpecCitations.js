// scripts/cleanupSpecCitations.js — one-off, run once after deploying
import "dotenv/config";
import { supabase } from "../config/supabase.js";
import { sanitizeSpecValue } from "../utils/sanitizeSpecValue.js";

async function run() {
    const { data: rows } = await supabase.from("hs_product_brands").select("id, attributes");
    let fixed = 0;
    for (const row of rows || []) {
        const cleaned = {};
        let changed = false;
        for (const [key, value] of Object.entries(row.attributes || {})) {
            const v = sanitizeSpecValue(value);
            if (v !== value) changed = true;
            if (v) cleaned[key] = v;
        }
        if (changed) {
            await supabase.from("hs_product_brands").update({ attributes: cleaned }).eq("id", row.id);
            fixed++;
        }
    }
    console.log(`Cleaned ${fixed} rows.`);
}
run();