// scripts/seedIndiaLGD.js
//
// One-time (idempotent, safe to re-run) seed of India's full administrative
// hierarchy: State -> District -> Sub-district (called "taluka" in Gujarat/
// Maharashtra, "tehsil" in Rajasthan/MP, "mandal" in AP/Telangana, "block" in
// WB/Bihar — LGD's own umbrella term is "sub-district", stored here under
// type "taluka" since that's the term the seller-facing UI conceptually maps
// to; the actual local name per row is preserved verbatim regardless).
//
// SOURCE: Local Government Directory (lgdirectory.gov.in), Ministry of
// Panchayati Raj — the *only* authoritative source for this hierarchy. There
// is no working live API for it (data.gov.in's own resource page confirms
// this: "The API for this resource does not exist"), so this pulls the
// community-maintained CSV export of that same directory instead of
// scraping the government site directly. Columns confirmed by inspection:
//   S.No., State Code, State Name (In English), District Code,
//   District Name (In English), Sub-District Code, Sub-District Version,
//   Sub-District Name, Sub-District Name (In Local), Census 2001 Code,
//   Census 2011 Code
//
// Run with: node scripts/seedIndiaLGD.js
// Needs network access to api.github.com + gist.githubusercontent.com.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://xbkqwpeuoruijrwxvqga.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhia3F3cGV1b3J1aWpyd3h2cWdhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDYwMjQ2MSwiZXhwIjoyMTAwMTc4NDYxfQ.xx4X7cpdP98Qzc3ljASZtXFhnSTHRFyya-LehU9OdLU';

if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Set SUPABASE_SERVICE_ROLE_KEY in your environment before running this script.");
    process.exit(1);
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

// Gist id for "Latest subdistrict list exported from
// https://lgdirectory.gov.in/downloadDirectory.do" — fetched via the GitHub
// Gist API (not a hardcoded raw URL) so we always get the current revision's
// raw_url regardless of commit hash.
const LGD_SUBDISTRICT_GIST_ID = "b2195c7feb506f8436659f36da1e58af";
const LGD_SUBDISTRICT_FILENAME = "india-subdistricts-lgd.csv";

function isBlankOrNA(v) {
    if (v == null) return true;
    const s = String(v).trim().toUpperCase();
    return s === "" || s === "NA" || s === "N/A" || s === "0" || s === "00000";
}

// Minimal RFC4180-ish CSV line parser — handles quoted fields containing
// commas (state/district names are plain, but local-language sub-district
// names occasionally are quoted upstream, so this is defensive).
function parseCsvLine(line) {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
            } else cur += ch;
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ",") {
            out.push(cur);
            cur = "";
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out;
}

async function fetchLgdSubdistrictCsv() {
    console.log("Resolving latest LGD sub-district export via GitHub Gist API...");
    const metaResp = await fetch(`https://api.github.com/gists/${LGD_SUBDISTRICT_GIST_ID}`);
    if (!metaResp.ok) throw new Error(`Gist API responded ${metaResp.status}`);
    const meta = await metaResp.json();
    const file = meta.files?.[LGD_SUBDISTRICT_FILENAME];
    if (!file?.raw_url) throw new Error(`Could not find ${LGD_SUBDISTRICT_FILENAME} in gist ${LGD_SUBDISTRICT_GIST_ID}`);

    console.log(`Downloading ${file.raw_url} ...`);
    const csvResp = await fetch(file.raw_url);
    if (!csvResp.ok) throw new Error(`Raw CSV fetch responded ${csvResp.status}`);
    return csvResp.text();
}

function parseLgdCsv(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());

    const stateIdx = header.findIndex((h) => h.startsWith("state name"));
    const districtIdx = header.findIndex((h) => h.startsWith("district name"));
    const subDistrictIdx = header.findIndex((h) => h === "sub-district name" || h.startsWith("sub-district name") && !h.includes("local"));

    if (stateIdx === -1 || districtIdx === -1 || subDistrictIdx === -1) {
        throw new Error(`Could not locate expected columns in header: ${header.join(" | ")}`);
    }

    // state -> district -> Set(subdistrict names)
    const tree = new Map();

    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        const stateName = cols[stateIdx]?.trim();
        const districtName = cols[districtIdx]?.trim();
        const subDistrictName = cols[subDistrictIdx]?.trim();

        if (isBlankOrNA(stateName) || isBlankOrNA(districtName) || isBlankOrNA(subDistrictName)) continue;

        if (!tree.has(stateName)) tree.set(stateName, new Map());
        const districtMap = tree.get(stateName);
        if (!districtMap.has(districtName)) districtMap.set(districtName, new Set());
        districtMap.get(districtName).add(subDistrictName);
    }

    return tree;
}

async function ensureNode(type, name, parentId) {
    const { data: existing } = await supabase
        .from("geo_locations")
        .select("id")
        .eq("type", type)
        .ilike("name", name)
        .eq("parent_id", parentId)
        .maybeSingle();
    if (existing) return existing.id;

    const { data: created, error } = await supabase
        .from("geo_locations")
        .insert({ type, name, parent_id: parentId })
        .select("id")
        .single();
    if (error) {
        // Race with a concurrent insert (or a prior partial run) — re-select.
        const { data: raced } = await supabase
            .from("geo_locations")
            .select("id")
            .eq("type", type)
            .ilike("name", name)
            .eq("parent_id", parentId)
            .maybeSingle();
        if (raced) return raced.id;
        throw error;
    }
    return created.id;
}

async function runInBatches(items, batchSize, worker) {
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await Promise.all(batch.map(worker));
    }
}

async function main() {
    const { data: india } = await supabase
        .from("geo_locations").select("id").eq("type", "country").eq("name", "India").maybeSingle();
    if (!india) throw new Error(`No "India" row found — run the migration first (it inserts the root row).`);

    const csvText = await fetchLgdSubdistrictCsv();
    const tree = parseLgdCsv(csvText);

    const states = Array.from(tree.keys()).sort();
    console.log(`Parsed ${states.length} states from the LGD export.`);

    let totalDistricts = 0;
    let totalTalukas = 0;

    for (const stateName of states) {
        const districtMap = tree.get(stateName);
        const districtNames = Array.from(districtMap.keys());
        process.stdout.write(`\n${stateName}: ${districtNames.length} districts... `);

        const stateId = await ensureNode("state", stateName, india.id);

        // Districts within a state are few (usually <50) — safe to do with
        // modest concurrency.
        await runInBatches(districtNames, 8, async (districtName) => {
            const districtId = await ensureNode("district", districtName, stateId);
            const talukaNames = Array.from(districtMap.get(districtName));
            totalDistricts += 1;
            totalTalukas += talukaNames.length;

            // Talukas within a district are also few (typically <30) —
            // small batches keep us well within Supabase connection limits
            // even when running many districts concurrently above.
            await runInBatches(talukaNames, 10, (talukaName) => ensureNode("taluka", talukaName, districtId));
        });

        process.stdout.write("done.");
    }

    console.log(`\n\nFinished — ${states.length} states, ${totalDistricts} districts, ${totalTalukas} talukas/sub-districts seeded.`);
    process.exit(0);
}

main().catch((err) => {
    console.error("\nSeed script failed:", err);
    process.exit(1);
});