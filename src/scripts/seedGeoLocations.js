// One-time seed: populates geo_locations with every country, every
// state/province, and every city from the public countries-states-cities
// dataset. Safe to re-run — it upserts on (type, name, parent_id) so it
// won't duplicate rows, and it never touches India's existing
// pincode-sourced district/city rows (those stay as-is; this script
// attaches non-India cities directly to their state instead of a
// district, since most countries don't have district-level pincode data).
import fs from "fs";
// import { supabase } from "../config/supabase.js";

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://xbkqwpeuoruijrwxvqga.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhia3F3cGV1b3J1aWpyd3h2cWdhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDYwMjQ2MSwiZXhwIjoyMTAwMTc4NDYxfQ.xx4X7cpdP98Qzc3ljASZtXFhnSTHRFyya-LehU9OdLU";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn(
        "[supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing — set them in .env"
    );
}

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

const RAW = JSON.parse(fs.readFileSync(new URL("../data/countries-states-cities.json", import.meta.url)));
const BATCH_SIZE = 500;

async function insertBatch(rows) {
    if (!rows.length) return;
    const { error } = await supabase.from("geo_locations").upsert(rows, { onConflict: "type,name,parent_id", ignoreDuplicates: true });
    if (error) console.error("Batch insert error:", error.message);
}

async function run() {
    console.log(`Seeding ${RAW.length} countries…`);

    for (const country of RAW) {
        const { data: existingCountry } = await supabase
            .from("geo_locations").select("id").eq("type", "country").eq("name", country.name).maybeSingle();

        let countryId = existingCountry?.id;
        if (!countryId) {
            const { data: created, error } = await supabase
                .from("geo_locations").insert({ type: "country", name: country.name, code: country.iso2 }).select("id").single();
            if (error) { console.error(`Skip ${country.name}: ${error.message}`); continue; }
            countryId = created.id;
        }

        const stateRows = (country.states || []).map((s) => ({ type: "state", name: s.name, code: s.state_code, parent_id: countryId }));
        for (let i = 0; i < stateRows.length; i += BATCH_SIZE) await insertBatch(stateRows.slice(i, i + BATCH_SIZE));

        const { data: states } = await supabase.from("geo_locations").select("id, name").eq("type", "state").eq("parent_id", countryId);
        const stateIdByName = Object.fromEntries((states || []).map((s) => [s.name, s.id]));

        let cityRows = [];
        for (const state of country.states || []) {
            const stateId = stateIdByName[state.name];
            if (!stateId) continue;
            for (const city of state.cities || []) {
                cityRows.push({ type: "city", name: city.name, parent_id: stateId });
            }
        }
        for (let i = 0; i < cityRows.length; i += BATCH_SIZE) await insertBatch(cityRows.slice(i, i + BATCH_SIZE));

        console.log(`✓ ${country.name} — ${stateRows.length} states, ${cityRows.length} cities`);
    }

    console.log("Done.");
}

run();