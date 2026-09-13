// scripts/checkVillage.js
//
// Diagnostic: given a village name (or partial name), prints every matching
// row in geo_locations along with its full ancestor chain, so you can see
// exactly what's in the DB right now — regardless of what the UI's search
// does with limits/sorting/filters.
//
// Run with: node scripts/checkVillage.js Sapar

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://xbkqwpeuoruijrwxvqga.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhia3F3cGV1b3J1aWpyd3h2cWdhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDYwMjQ2MSwiZXhwIjoyMTAwMTc4NDYxfQ.xx4X7cpdP98Qzc3ljASZtXFhnSTHRFyya-LehU9OdLU';

if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Set SUPABASE_SERVICE_ROLE_KEY in your environment.");
    process.exit(1);
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

async function ancestorsOf(row) {
    const chain = [];
    let current = row;
    while (current?.parent_id) {
        const { data: parent } = await supabase
            .from("geo_locations")
            .select("id, type, name, parent_id")
            .eq("id", current.parent_id)
            .maybeSingle();
        if (!parent) break;
        chain.unshift(`${parent.type}:${parent.name}`);
        current = parent;
    }
    return chain.join(" > ");
}

async function main() {
    const term = process.argv[2];
    if (!term) {
        console.error("Usage: node scripts/checkVillage.js <name or partial name>");
        process.exit(1);
    }

    const { data: matches, error } = await supabase
        .from("geo_locations")
        .select("id, type, name, parent_id")
        .ilike("name", `%${term}%`)
        .eq("type", "village");
    if (error) throw error;

    console.log(`Found ${matches.length} village row(s) matching "${term}":\n`);
    for (const m of matches) {
        const chain = await ancestorsOf(m);
        console.log(`  id=${m.id}  name="${m.name}"  parent_id=${m.parent_id}`);
        console.log(`    path: ${chain} > village:${m.name}\n`);
    }

    if (matches.length === 0) {
        console.log("No rows at all — it never made it into the DB. Checking for near-matches (different casing/spacing)...");
        const { data: loose } = await supabase
            .from("geo_locations")
            .select("name")
            .eq("type", "village")
            .ilike("name", `%${term.slice(0, Math.max(3, term.length - 2))}%`)
            .limit(20);
        console.log(loose?.map((r) => r.name) || []);
    }

    process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });