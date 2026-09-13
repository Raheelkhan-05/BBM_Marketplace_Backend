// scripts/verifyVillageCounts.js
//
// Cross-checks every taluka's village count in Supabase against the
// Parquet's own count for that taluka, and reports any taluka where they
// don't match — along with the specific village names present in the
// Parquet but missing from the DB. Catches silent batch-level drops that
// don't show up in seedIndiaVillages.js's own inserted/skipped counters.
//
// Run with: node scripts/verifyVillageCounts.js
// Optional: node scripts/verifyVillageCounts.js Gujarat

import duckdb from "duckdb";
import path from "node:path";
import { fileURLToPath } from "node:url";



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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_PARQUET_PATH = path.join(__dirname, ".cache", "LGD_Villages.parquet");

function normalizeName(s) {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,()'-]/g, "");
}
function isBlankOrNA(v) {
    if (v == null) return true;
    const s = String(v).trim().toUpperCase();
    return s === "" || s === "NA" || s === "N/A";
}

function runQuery(db, sql) {
    return new Promise((resolve, reject) => db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))));
}

async function main() {
    const onlyStates = process.argv.slice(2);
    const db = new duckdb.Database(":memory:");
    const p = LOCAL_PARQUET_PATH.replace(/\\/g, "/");

    console.log("Reading Parquet...");
    const rows = await runQuery(db, `
        SELECT stname, dtname, sdtname, subdt_lgd, vilname11
        FROM read_parquet('${p}')
    `);

    // state -> district -> subdistrict -> Set(normalized village names -> original name)
    const tree = new Map();
    for (const r of rows) {
        if (isBlankOrNA(r.stname) || isBlankOrNA(r.dtname) || isBlankOrNA(r.sdtname) || isBlankOrNA(r.vilname11)) continue;
        const stateName = r.stname.trim();
        if (onlyStates.length && !onlyStates.some((s) => stateName.toLowerCase().includes(s.toLowerCase()))) continue;
        const districtName = r.dtname.trim();
        const subdistrictName = r.sdtname.trim();
        const villageName = r.vilname11.trim();

        if (!tree.has(stateName)) tree.set(stateName, new Map());
        const dMap = tree.get(stateName);
        if (!dMap.has(districtName)) dMap.set(districtName, new Map());
        const sMap = dMap.get(districtName);
        if (!sMap.has(subdistrictName)) sMap.set(subdistrictName, new Map());
        sMap.get(subdistrictName).set(normalizeName(villageName), villageName);
    }

    let talukasChecked = 0;
    let talukasMismatched = 0;
    let totalMissingVillages = 0;
    const mismatchLines = [];

    for (const [stateName, dMap] of tree.entries()) {
        const { data: stateRow } = await supabase.from("geo_locations").select("id").eq("type", "state").ilike("name", `%${stateName}%`).maybeSingle();
        if (!stateRow) continue;

        for (const [districtName, sMap] of dMap.entries()) {
            const { data: districtRow } = await supabase.from("geo_locations").select("id").eq("type", "district").eq("parent_id", stateRow.id).ilike("name", `%${districtName}%`).maybeSingle();
            if (!districtRow) continue;

            const { data: talukas } = await supabase.from("geo_locations").select("id, name, code").eq("type", "taluka").eq("parent_id", districtRow.id);

            for (const [subdistrictName, villageMap] of sMap.entries()) {
                const taluka = (talukas || []).find((t) => normalizeName(t.name) === normalizeName(subdistrictName));
                if (!taluka) continue; // already covered by unmatched-subdistricts.log

                talukasChecked++;
                const { data: dbVillages } = await supabase.from("geo_locations").select("name").eq("type", "village").eq("parent_id", taluka.id);
                const dbNormNames = new Set((dbVillages || []).map((v) => normalizeName(v.name)));

                const missing = [];
                for (const [normName, originalName] of villageMap.entries()) {
                    if (!dbNormNames.has(normName)) missing.push(originalName);
                }

                if (missing.length > 0) {
                    talukasMismatched++;
                    totalMissingVillages += missing.length;
                    mismatchLines.push(`${stateName} > ${districtName} > ${subdistrictName}: missing ${missing.length} — ${missing.join(", ")}`);
                    console.log(`MISMATCH: ${stateName} > ${districtName} > ${subdistrictName} — Parquet has ${villageMap.size}, DB has ${dbNormNames.size}, missing: ${missing.join(", ")}`);
                }
            }
        }
    }

    console.log(`\nChecked ${talukasChecked} talukas. ${talukasMismatched} had missing villages (${totalMissingVillages} total).`);
    if (mismatchLines.length) {
        const fs = await import("node:fs");
        fs.writeFileSync(path.join(__dirname, ".cache", "village-count-mismatches.log"), mismatchLines.join("\n"));
        console.log("Full details written to .cache/village-count-mismatches.log");
    }
    process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });