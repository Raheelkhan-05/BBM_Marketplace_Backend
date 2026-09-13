// scripts/checkTalukaVillagesInParquet.js
//
// Diagnostic: lists every village the Parquet has under a given
// state/district/subdistrict combination, so you can see the taluka's full
// village list as the source has it — useful for confirming whether a
// specific settlement (e.g. Shapar-Veraval) is present under that taluka
// at all, independent of any matching/normalization logic.
//
// Run with: node scripts/checkTalukaVillagesInParquet.js Gujarat Rajkot "Kotda Sangani"

import duckdb from "duckdb";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_PARQUET_PATH = path.join(__dirname, ".cache", "LGD_Villages.parquet");

function runQuery(db, sql) {
    return new Promise((resolve, reject) => {
        db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
}

async function main() {
    const [state, district, subdistrict] = process.argv.slice(2);
    if (!state || !district || !subdistrict) {
        console.error('Usage: node scripts/checkTalukaVillagesInParquet.js <state> <district> <subdistrict>');
        process.exit(1);
    }

    const db = new duckdb.Database(":memory:");
    const p = LOCAL_PARQUET_PATH.replace(/\\/g, "/");

    // Loose match on all three so slightly-off casing/spacing still surfaces
    const rows = await runQuery(db, `
        SELECT stname, dtname, sdtname, subdt_lgd, vilname11, vil_lgd
        FROM read_parquet('${p}')
        WHERE stname ILIKE '%${state}%'
          AND dtname ILIKE '%${district}%'
          AND sdtname ILIKE '%${subdistrict}%'
        ORDER BY vilname11
    `);

    console.log(`Found ${rows.length} village row(s) under state~"${state}" district~"${district}" subdistrict~"${subdistrict}":\n`);
    for (const r of rows) {
        console.log(`  ${r.vilname11}  (subdistrict as stored: "${r.sdtname}", lgd code=${r.subdt_lgd})`);
    }

    if (rows.length === 0) {
        console.log("No rows at all under that subdistrict name. Checking what subdistrict names DO exist for this district...");
        const subdistricts = await runQuery(db, `
            SELECT DISTINCT sdtname, subdt_lgd
            FROM read_parquet('${p}')
            WHERE stname ILIKE '%${state}%' AND dtname ILIKE '%${district}%'
            ORDER BY sdtname
        `);
        console.log(subdistricts.map(s => `${s.sdtname} (lgd=${s.subdt_lgd})`));
    }

    process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });