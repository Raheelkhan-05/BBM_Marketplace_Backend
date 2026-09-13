// scripts/debugSingleVillageInsert.js
//
// Isolates the exact insert path for one village name under one taluka, so
// silent failures (23505 swallowed for the wrong reason, onConflict target
// mismatch, etc.) become visible instead of being folded into an aggregate
// "inserted: N" count.
//
// Run with:
//   node scripts/debugSingleVillageInsert.js "Gujarat" "Rajkot" "Kotda Sangani" "Shapar (CT)"


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

function normalizeName(s) {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,()'-]/g, "");
}

async function main() {
    const [stateName, districtName, subdistrictName, villageName] = process.argv.slice(2);
    if (!villageName) {
        console.error('Usage: node scripts/debugSingleVillageInsert.js "<state>" "<district>" "<subdistrict>" "<village>"');
        process.exit(1);
    }

    console.log(`\n--- Step 1: resolve state ---`);
    const { data: state, error: stateErr } = await supabase
        .from("geo_locations").select("id, name").eq("type", "state").ilike("name", `%${stateName}%`).maybeSingle();
    console.log({ state, stateErr });
    if (!state) return process.exit(1);

    console.log(`\n--- Step 2: resolve district ---`);
    const { data: district, error: districtErr } = await supabase
        .from("geo_locations").select("id, name").eq("type", "district").eq("parent_id", state.id).ilike("name", `%${districtName}%`).maybeSingle();
    console.log({ district, districtErr });
    if (!district) return process.exit(1);

    console.log(`\n--- Step 3: resolve taluka (exact + normalized) ---`);
    const { data: talukas, error: talukaErr } = await supabase
        .from("geo_locations").select("id, name, code").eq("type", "taluka").eq("parent_id", district.id);
    console.log({ talukaCount: talukas?.length, talukaErr });
    const taluka = (talukas || []).find((t) => normalizeName(t.name) === normalizeName(subdistrictName));
    console.log({ resolvedTaluka: taluka });
    if (!taluka) return process.exit(1);

    console.log(`\n--- Step 4: check if this exact village name already exists under this taluka ---`);
    const { data: existingExact, error: existingErr } = await supabase
        .from("geo_locations").select("id, name").eq("type", "village").eq("parent_id", taluka.id).eq("name", villageName);
    console.log({ existingExact, existingErr });

    console.log(`\n--- Step 5: check for ANY row under this taluka whose name normalizes the same (case/format collision candidates) ---`);
    const { data: allVillagesHere } = await supabase
        .from("geo_locations").select("id, name").eq("type", "village").eq("parent_id", taluka.id);
    const collisionCandidates = (allVillagesHere || []).filter((v) => normalizeName(v.name) === normalizeName(villageName));
    console.log({ totalVillagesUnderThisTaluka: allVillagesHere?.length, collisionCandidates });

    console.log(`\n--- Step 6: attempt the actual insert, with full error surfaced (no swallowing) ---`);
    const { data: inserted, error: insertErr } = await supabase
        .from("geo_locations")
        .insert({ type: "village", name: villageName, parent_id: taluka.id })
        .select("id, name, parent_id");
    console.log({ inserted, insertErr });

    if (insertErr) {
        console.log(`\n--- Step 7: insert failed — full error object ---`);
        console.log(JSON.stringify(insertErr, null, 2));
    }

    process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });