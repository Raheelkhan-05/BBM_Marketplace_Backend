// scripts/backfillTalukaCodes.js
//
// One-time backfill: adds LGD Sub-District Code to already-seeded taluka
// rows (seedIndiaLGD.js originally didn't capture it). Safe to re-run —
// only updates rows where code is currently null.
//
// Run with: node scripts/backfillTalukaCodes.js

import { supabase } from "./seedIndiaLGD.js";

const LGD_SUBDISTRICT_GIST_ID = "b2195c7feb506f8436659f36da1e58af";
const LGD_SUBDISTRICT_FILENAME = "india-subdistricts-lgd.csv";

function parseCsvLine(line) {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
            else cur += ch;
        } else if (ch === '"') inQuotes = true;
        else if (ch === ",") { out.push(cur); cur = ""; }
        else cur += ch;
    }
    out.push(cur);
    return out;
}

function isBlankOrNA(v) {
    if (v == null) return true;
    const s = String(v).trim().toUpperCase();
    return s === "" || s === "NA" || s === "N/A" || s === "0" || s === "00000";
}

async function fetchCsv() {
    const metaResp = await fetch(`https://api.github.com/gists/${LGD_SUBDISTRICT_GIST_ID}`);
    if (!metaResp.ok) throw new Error(`Gist API responded ${metaResp.status}`);
    const meta = await metaResp.json();
    const file = meta.files?.[LGD_SUBDISTRICT_FILENAME];
    if (!file?.raw_url) throw new Error(`Could not find ${LGD_SUBDISTRICT_FILENAME} in gist`);
    const csvResp = await fetch(file.raw_url);
    if (!csvResp.ok) throw new Error(`Raw CSV fetch responded ${csvResp.status}`);
    return csvResp.text();
}

async function main() {
    console.log("Fetching LGD sub-district CSV...");
    const text = await fetchCsv();
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());

    const stateIdx = header.findIndex((h) => h.startsWith("state name"));
    const districtIdx = header.findIndex((h) => h.startsWith("district name"));
    const subDistrictIdx = header.findIndex((h) => h === "sub-district name" || (h.startsWith("sub-district name") && !h.includes("local")));
    const subDistrictCodeIdx = header.findIndex((h) => h.startsWith("sub-district code"));

    if ([stateIdx, districtIdx, subDistrictIdx, subDistrictCodeIdx].includes(-1)) {
        throw new Error(`Could not locate expected columns in header: ${header.join(" | ")}`);
    }

    // Build state::district::subdistrict(lower) -> code map from the CSV
    const codeByKey = new Map();
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        const stateName = cols[stateIdx]?.trim();
        const districtName = cols[districtIdx]?.trim();
        const subDistrictName = cols[subDistrictIdx]?.trim();
        const code = cols[subDistrictCodeIdx]?.trim();
        if (isBlankOrNA(stateName) || isBlankOrNA(districtName) || isBlankOrNA(subDistrictName) || isBlankOrNA(code)) continue;
        codeByKey.set(`${stateName}::${districtName}::${subDistrictName.toLowerCase()}`, code);
    }
    console.log(`Parsed ${codeByKey.size} sub-district codes from CSV.`);

    // Walk all taluka rows missing a code, resolve their state/district
    // names via parent_id, and patch in the code.
    const { data: talukas, error } = await supabase
        .from("geo_locations")
        .select("id, name, parent_id")
        .eq("type", "taluka")
        .is("code", null);
    if (error) throw error;
    console.log(`${talukas.length} taluka rows missing a code.`);

    const districtCache = new Map(); // districtId -> { name, stateId }
    const stateCache = new Map();    // stateId -> name

    let updated = 0, notFound = 0;
    for (const t of talukas) {
        let district = districtCache.get(t.parent_id);
        if (!district) {
            const { data: d } = await supabase.from("geo_locations").select("id, name, parent_id").eq("id", t.parent_id).maybeSingle();
            if (!d) { notFound++; continue; }
            district = { name: d.name, stateId: d.parent_id };
            districtCache.set(t.parent_id, district);
        }
        let stateName = stateCache.get(district.stateId);
        if (!stateName) {
            const { data: s } = await supabase.from("geo_locations").select("name").eq("id", district.stateId).maybeSingle();
            if (!s) { notFound++; continue; }
            stateName = s.name;
            stateCache.set(district.stateId, stateName);
        }

        const code = codeByKey.get(`${stateName}::${district.name}::${t.name.toLowerCase()}`);
        if (!code) { notFound++; continue; }

        const { error: updErr } = await supabase.from("geo_locations").update({ code }).eq("id", t.id);
        if (updErr) throw updErr;
        updated++;
    }

    console.log(`\nDone — ${updated} taluka rows updated with codes, ${notFound} left without a match (name mismatch vs CSV; village script will still match these by normalized name).`);
    process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });