// scripts/checkVillageInParquet.js
//
// Diagnostic: searches the raw Parquet for a village name and prints its
// state/district/subdistrict/code exactly as the source has it — so you
// can compare against what's seeded in Supabase.
//
// Run with: node scripts/checkVillageInParquet.js Sapar

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
    const term = process.argv[2];
    if (!term) {
        console.error("Usage: node scripts/checkVillageInParquet.js <name or partial name>");
        process.exit(1);
    }

    const db = new duckdb.Database(":memory:");
    const p = LOCAL_PARQUET_PATH.replace(/\\/g, "/");

    const rows = await runQuery(db, `
        SELECT stname, dtname, sdtname, subdt_lgd, vilname11, vil_lgd
        FROM read_parquet('${p}')
        WHERE vilname11 ILIKE '%${term}%'
    `);

    console.log(`Found ${rows.length} row(s) in the Parquet matching "${term}":\n`);
    for (const r of rows) {
        console.log(`  ${r.vilname11}  |  state=${r.stname}  district=${r.dtname}  subdistrict=${r.sdtname} (lgd code=${r.subdt_lgd})  vil_lgd=${r.vil_lgd}`);
    }
    process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });