// scripts/seedIndiaVillages.js
//
// Adds the 5th hierarchy level: Village, under each already-seeded taluka
// row.
//
// MATCHING STRATEGY (v3):
//
// STATE level: the Parquet's state names (e.g. "ANDAMAN & NICOBAR") don't
// always match LGD's official state names used to seed state rows (e.g.
// "Andaman and Nicobar Islands"). Resolution order: exact case-insensitive
// match -> known alias table (STATE_NAME_ALIASES) -> normalized comparison
// (lowercased, "&"->"and", punctuation stripped) against all seeded states.
// Any state that still can't be resolved is logged with the seeded state
// names printed alongside it, so a real gap is diagnosable immediately
// instead of silently skipping the whole state's villages.
//
// SUB-DISTRICT level: matched by LGD sub-district code first (this
// Parquet's `_lgd`-suffixed columns, e.g. `subdt_lgd`, ARE the actual LGD
// codes — NOT the same as the Census-2011 codes like `sdtcode11`, which
// exist in the same file but would give confidently-wrong matches if used).
// Falls back to normalized-name matching for any taluka row that predates
// scripts/backfillTalukaCodes.js and so has no code yet. Two independently
// maintained exports of the same LGD data don't always agree on
// spacing/spelling for a sub-district name (e.g. "Kotda Sangani" vs
// "Kotdasangani") — the code match sidesteps that entirely; the normalized
// fallback narrows the remaining gap.
//
// Anything that still can't be resolved at either level is written in full
// (not just an aggregate count) to .cache/unmatched-subdistricts.log.
//
// DUPLICATE SAFETY (unchanged from v2): re-running this script, or running
// it after a partial prior run, is expected and safe.
//   1. Villages are deduped by (resolved parent taluka id, normalized
//      village name) in memory before ever being queued for insert.
//   2. The insert is an upsert on the (type, name, parent_id) unique
//      constraint, ignoring duplicates.
//   3. A case-insensitive unique index on (type, lower(name), parent_id)
//      catches near-duplicates differing only by case; on a 23505 conflict
//      from that index, the batch falls back to inserting row-by-row and
//      treats "already exists" as success.
// Fixing state/sub-district matching only means more villages correctly
// REACH the insert path — it cannot cause double-inserts for villages that
// already succeeded on a prior run.
//
// PREREQUISITE: scripts/seedIndiaLGD.js must have already run. Running
// scripts/backfillTalukaCodes.js first is strongly recommended (not
// required — normalized-name fallback still works for any taluka missing a
// code, just less reliably than a code match).
//
// SETUP:
//   npm install duckdb
//   node scripts/seedIndiaVillages.js
// Optional: node scripts/seedIndiaVillages.js "Gujarat" "Maharashtra"
//   to seed only specific states first (recommended for a first test run).
//
// The Parquet's exact column names aren't hardcoded blindly: on first run
// the script runs `DESCRIBE` against the file and auto-detects the state /
// district / subdistrict / subdistrict-code / village name columns by
// pattern-matching common LGD naming conventions. It PRINTS what it
// detected before doing anything — if that mapping looks wrong for your
// downloaded file, override it with flags, e.g.:
//   node scripts/seedIndiaVillages.js --state-col=STATE_NAME --village-col=VILLAGE_NAME --subdistrict-code-col=subdt_lgd

import { createClient } from "@supabase/supabase-js";
import duckdb from "duckdb";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = "https://xbkqwpeuoruijrwxvqga.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhia3F3cGV1b3J1aWpyd3h2cWdhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDYwMjQ2MSwiZXhwIjoyMTAwMTc4NDYxfQ.xx4X7cpdP98Qzc3ljASZtXFhnSTHRFyya-LehU9OdLU';

if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Set SUPABASE_SERVICE_ROLE_KEY in your environment before running this script.");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

// Confirmed live at time of writing via https://bharatlas.com/api/v1/layers
// (the `lgd_villages` entry's `downloads.parquet.url` field). If this ever
// 404s, re-fetch that endpoint to get the current URL.
const VILLAGES_PARQUET_URL = "https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/admin/villages/LGD_Villages.parquet";
const LOCAL_PARQUET_PATH = path.join(__dirname, ".cache", "LGD_Villages.parquet");
const UNMATCHED_LOG_PATH = path.join(__dirname, ".cache", "unmatched-subdistricts.log");

// --- column auto-detection -------------------------------------------------
const COLUMN_PATTERNS = {
    state: [/^stname$/i, /^st_?name$/i, /^state_?name$/i],
    district: [/^dtname$/i, /^dt_?name$/i, /^district_?name$/i],
    subdistrict: [/^sdtname$/i, /^sub_?dt_?name$/i, /^sd_?name$/i, /^subdistrict_?name$/i],
    // NOTE: `_lgd`-suffixed columns (e.g. subdt_lgd) ARE the real LGD codes.
    // Columns like sdtcode11/dtcode11/vilcode11 in the same file are
    // Census-2011 codes — a different numbering scheme entirely — and must
    // NOT be matched here, or matches will be confidently wrong.
    subdistrictCode: [/^subdt_lgd$/i, /^sub_?dt_?lgd$/i, /^sdtcode$/i, /^sub_?dt_?code$/i, /^sd_?code$/i, /^subdistrict_?code$/i, /^subdis_?cd$/i],
    village: [/^village_?na$/i, /^vlname$/i, /^village_?name$/i, /^vname$/i, /^vilname\d*$/i, /^vil_?name$/i],
};

function detectColumn(columnNames, patterns) {
    for (const pattern of patterns) {
        const match = columnNames.find((c) => pattern.test(c));
        if (match) return match;
    }
    return null;
}

function parseColumnOverrides(argv) {
    const overrides = {};
    for (const arg of argv) {
        const m = /^--(state|district|subdistrict|subdistrict-code|village)-col=(.+)$/.exec(arg);
        if (m) overrides[m[1].replace(/-code$/, "Code")] = m[2];
    }
    return overrides;
}

function normalizeName(s) {
    return String(s || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[.,()'-]/g, "");
}

// Known state-name mismatches between this Parquet export and LGD's
// official naming (used when seedIndiaLGD.js originally seeded state rows).
// Extend this table if the "no matching state row" warning fires below —
// it prints the seeded state names alongside the miss to help you spot it.
const STATE_NAME_ALIASES = {
    "andaman and nicobar": "Andaman and Nicobar Islands",
    "dadra and nagar haveli and daman and diu": "Dadra and Nagar Haveli and Daman and Diu",
    "jammu and kashmir": "Jammu and Kashmir",
    "nct of delhi": "Delhi",
    "pondicherry": "Puducherry",
    "orissa": "Odisha",
    "uttaranchal": "Uttarakhand",
};

// --- download with resume-friendly caching ---------------------------------
async function ensureParquetDownloaded() {
    fs.mkdirSync(path.dirname(LOCAL_PARQUET_PATH), { recursive: true });
    if (fs.existsSync(LOCAL_PARQUET_PATH) && fs.statSync(LOCAL_PARQUET_PATH).size > 0) {
        console.log(`Using cached download at ${LOCAL_PARQUET_PATH} (delete this file to force a re-download).`);
        return;
    }
    console.log(`Downloading LGD villages Parquet (~440MB) from bharatlas.com...`);
    console.log(`  ${VILLAGES_PARQUET_URL}`);
    const resp = await fetch(VILLAGES_PARQUET_URL);
    if (!resp.ok) throw new Error(`Parquet download failed: HTTP ${resp.status}`);
    const total = Number(resp.headers.get("content-length") || 0);
    let received = 0;
    const tmpPath = `${LOCAL_PARQUET_PATH}.part`;
    const fileStream = fs.createWriteStream(tmpPath);
    const reader = resp.body.getReader();
    let lastLogged = 0;
    for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        fileStream.write(Buffer.from(value));
        if (total && received - lastLogged > 20 * 1024 * 1024) {
            lastLogged = received;
            process.stdout.write(`\r  ${(received / 1e6).toFixed(0)}MB / ${(total / 1e6).toFixed(0)}MB`);
        }
    }
    await new Promise((resolve, reject) => fileStream.end((err) => (err ? reject(err) : resolve())));
    fs.renameSync(tmpPath, LOCAL_PARQUET_PATH);
    console.log(`\nDownload complete: ${LOCAL_PARQUET_PATH}`);
}

// --- DuckDB helpers ---------------------------------------------------------
function openDb() {
    return new duckdb.Database(":memory:");
}

function runQuery(db, sql) {
    return new Promise((resolve, reject) => {
        db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
}

async function describeColumns(db, parquetPath) {
    const rows = await runQuery(db, `DESCRIBE SELECT * FROM read_parquet('${parquetPath}') LIMIT 0`);
    return rows.map((r) => r.column_name);
}

// --- Supabase state resolution ----------------------------------------
async function resolveStateRow(stateName, allStatesCache) {
    // 1. exact case-insensitive match (fast path, works for most states)
    const { data: exact } = await supabase
        .from("geo_locations").select("id, name").eq("type", "state").ilike("name", stateName).maybeSingle();
    if (exact) return exact;

    // 2. known alias
    const alias = STATE_NAME_ALIASES[normalizeName(stateName)];
    if (alias) {
        const { data: aliased } = await supabase
            .from("geo_locations").select("id, name").eq("type", "state").ilike("name", alias).maybeSingle();
        if (aliased) return aliased;
    }

    // 3. normalized comparison against every seeded state ("&" vs "and",
    // stray punctuation) — cheap since there are only ~36 state/UT rows.
    const norm = normalizeName(stateName).replace(/&/g, "and");
    const match = allStatesCache.find((s) => normalizeName(s.name).replace(/&/g, "and") === norm);
    return match || null;
}

// --- Supabase taluka lookups ---------------------------------------------
// Builds, for one state, everything needed to resolve a Parquet
// sub-district row to a taluka id: by code first, by normalized name as
// fallback.
async function buildLookupForState(stateId) {
    const { data: districts } = await supabase
        .from("geo_locations").select("id, name").eq("type", "district").eq("parent_id", stateId);
    const districtByName = new Map((districts || []).map((d) => [d.name.toLowerCase(), d.id]));

    const talukaByCode = new Map();       // `${districtId}::${code}` -> talukaId
    const talukaByNormName = new Map();   // `${districtId}::${normalizedName}` -> talukaId

    for (const d of districts || []) {
        const { data: talukas } = await supabase
            .from("geo_locations").select("id, name, code").eq("type", "taluka").eq("parent_id", d.id);
        for (const t of talukas || []) {
            if (t.code) talukaByCode.set(`${d.id}::${t.code}`, t.id);
            talukaByNormName.set(`${d.id}::${normalizeName(t.name)}`, t.id);
        }
    }
    return { districtByName, talukaByCode, talukaByNormName };
}

function resolveTalukaId(lookup, districtId, subdistrictName, subdistrictCode) {
    if (subdistrictCode) {
        const byCode = lookup.talukaByCode.get(`${districtId}::${subdistrictCode}`);
        if (byCode) return { id: byCode, matchedBy: "code" };
    }
    const byName = lookup.talukaByNormName.get(`${districtId}::${normalizeName(subdistrictName)}`);
    if (byName) return { id: byName, matchedBy: "name" };
    return null;
}

async function insertVillageBatch(rows) {
    const payload = rows.map((r) => ({ type: "village", name: r.name, parent_id: r.parent_id }));
    const { error } = await supabase
        .from("geo_locations")
        .upsert(payload, { onConflict: "type,name,parent_id", ignoreDuplicates: true });
    if (!error) return;

    // The DB also has a case-insensitive unique index on (type, lower(name),
    // parent_id) — separate from the plain (type, name, parent_id) one this
    // upsert's ON CONFLICT targets. A batch can fail here if two LGD rows
    // differ only by casing. Rather than aborting the whole run, fall back
    // to inserting this batch row-by-row and treat "already exists" as
    // success.
    if (error.code === "23505") {
        for (const row of payload) {
            const { error: rowErr } = await supabase
                .from("geo_locations")
                .upsert([row], { onConflict: "type,name,parent_id", ignoreDuplicates: true });
            if (rowErr && rowErr.code !== "23505") throw rowErr;
        }
        return;
    }
    throw error;
}

function isBlankOrNA(v) {
    if (v == null) return true;
    const s = String(v).trim().toUpperCase();
    return s === "" || s === "NA" || s === "N/A";
}

async function main() {
    const argv = process.argv.slice(2);
    const onlyStates = argv.filter((a) => !a.startsWith("--"));
    const overrides = parseColumnOverrides(argv);

    await ensureParquetDownloaded();

    const db = openDb();
    const parquetPathEscaped = LOCAL_PARQUET_PATH.replace(/\\/g, "/");

    console.log("Inspecting Parquet schema...");
    const columnNames = await describeColumns(db, parquetPathEscaped);
    console.log(`Columns found: ${columnNames.join(", ")}`);

    const cols = {
        state: overrides.state || detectColumn(columnNames, COLUMN_PATTERNS.state),
        district: overrides.district || detectColumn(columnNames, COLUMN_PATTERNS.district),
        subdistrict: overrides.subdistrict || detectColumn(columnNames, COLUMN_PATTERNS.subdistrict),
        subdistrictCode: overrides.subdistrictCode || detectColumn(columnNames, COLUMN_PATTERNS.subdistrictCode),
        village: overrides.village || detectColumn(columnNames, COLUMN_PATTERNS.village),
    };

    console.log("\nDetected column mapping:");
    console.log(`  state             -> ${cols.state ?? "NOT FOUND"}`);
    console.log(`  district          -> ${cols.district ?? "NOT FOUND"}`);
    console.log(`  subdistrict       -> ${cols.subdistrict ?? "NOT FOUND"}`);
    console.log(`  subdistrict code  -> ${cols.subdistrictCode ?? "not found — will match by normalized name only"}`);
    console.log(`  village           -> ${cols.village ?? "NOT FOUND"}`);

    if (!cols.state || !cols.district || !cols.subdistrict || !cols.village) {
        console.error("\nCould not auto-detect one or more required columns.");
        console.error("Re-run with explicit overrides, e.g.:");
        console.error("  node scripts/seedIndiaVillages.js --state-col=stname --district-col=dtname --subdistrict-col=sdtname --village-col=vilname11 --subdistrict-code-col=subdt_lgd");
        process.exit(1);
    }
    console.log("\nIf any of these look wrong, Ctrl+C now and re-run with column overrides.\n");

    console.log("Reading all rows into memory (this is ~580k short string rows, a few hundred MB)...");
    const codeSelect = cols.subdistrictCode ? `, "${cols.subdistrictCode}" AS subdistrict_code` : "";
    const sql = `
        SELECT
            "${cols.state}" AS state_name,
            "${cols.district}" AS district_name,
            "${cols.subdistrict}" AS subdistrict_name,
            "${cols.village}" AS village_name
            ${codeSelect}
        FROM read_parquet('${parquetPathEscaped}')
    `;
    const rows = await runQuery(db, sql);
    console.log(`Loaded ${rows.length} village rows from the Parquet.`);

    // Group into state -> district -> subdistrict -> { code, villages: Set }
    const tree = new Map();
    for (const r of rows) {
        if (isBlankOrNA(r.state_name) || isBlankOrNA(r.district_name) || isBlankOrNA(r.subdistrict_name) || isBlankOrNA(r.village_name)) continue;
        const stateName = r.state_name.trim();
        const districtName = r.district_name.trim();
        const subdistrictName = r.subdistrict_name.trim();
        const subdistrictCode = r.subdistrict_code != null && !isBlankOrNA(r.subdistrict_code) ? String(r.subdistrict_code).trim() : null;
        const villageName = r.village_name.trim();

        if (!tree.has(stateName)) tree.set(stateName, new Map());
        const districtMap = tree.get(stateName);
        if (!districtMap.has(districtName)) districtMap.set(districtName, new Map());
        const subMap = districtMap.get(districtName);
        if (!subMap.has(subdistrictName)) subMap.set(subdistrictName, { code: subdistrictCode, villages: new Set() });
        subMap.get(subdistrictName).villages.add(villageName);
    }

    const allStateNamesInParquet = Array.from(tree.keys()).sort();
    const stateNames = onlyStates.length ? onlyStates : allStateNamesInParquet;
    console.log(`\nSeeding villages for ${stateNames.length} state(s)${onlyStates.length ? ` (filtered: ${onlyStates.join(", ")})` : ""}...`);

    const { data: allSeededStates } = await supabase.from("geo_locations").select("id, name").eq("type", "state");

    let totalInserted = 0;
    let totalSkipped = 0;
    let totalMatchedByCode = 0;
    let totalMatchedByName = 0;
    const unmatchedLines = [];

    for (const stateName of stateNames) {
        const districtMap = tree.get(stateName);
        if (!districtMap) {
            console.warn(`No rows found for "${stateName}" in the Parquet — check spelling/casing against: ${allStateNamesInParquet.join(", ")}`);
            continue;
        }

        const stateRow = await resolveStateRow(stateName, allSeededStates || []);
        if (!stateRow) {
            console.warn(`\nSkipping ${stateName} — no matching state row in Supabase.`);
            console.warn(`  Seeded state names: ${(allSeededStates || []).map((s) => s.name).join(", ")}`);
            console.warn(`  Add an alias to STATE_NAME_ALIASES mapping normalizeName("${stateName}") to the correct seeded name, then re-run.`);
            const totalVillagesInState = Array.from(districtMap.values())
                .flatMap((subMap) => Array.from(subMap.values()))
                .reduce((n, s) => n + s.villages.size, 0);
            unmatchedLines.push(`${stateName} (STATE NOT FOUND) — ${totalVillagesInState} villages across all districts/sub-districts`);
            continue;
        }

        const lookup = await buildLookupForState(stateRow.id);

        let stateInserted = 0;
        let stateSkipped = 0;

        // Dedup within this state's run: (resolved taluka id, normalized
        // village name) -> already queued. Guards against a village being
        // queued twice even if it were reachable via more than one resolved
        // path in the same run.
        const seenInThisRun = new Set();
        let batch = [];
        const BATCH_SIZE = 500;

        const flush = async () => {
            if (!batch.length) return;
            await insertVillageBatch(batch);
            stateInserted += batch.length;
            batch = [];
        };

        for (const [districtName, subMap] of districtMap.entries()) {
            const districtId = lookup.districtByName.get(districtName.toLowerCase());
            if (!districtId) {
                for (const [subdistrictName, { villages }] of subMap.entries()) {
                    stateSkipped += villages.size;
                    unmatchedLines.push(`${stateRow.name} > ${districtName} (district not found) > ${subdistrictName} — ${villages.size} villages`);
                }
                continue;
            }

            for (const [subdistrictName, { code, villages }] of subMap.entries()) {
                const match = resolveTalukaId(lookup, districtId, subdistrictName, code);
                if (!match) {
                    stateSkipped += villages.size;
                    unmatchedLines.push(`${stateRow.name} > ${districtName} > ${subdistrictName} (code=${code || "none"}) — ${villages.size} villages`);
                    continue;
                }
                if (match.matchedBy === "code") totalMatchedByCode++; else totalMatchedByName++;

                for (const villageName of villages) {
                    const dedupeKey = `${match.id}::${normalizeName(villageName)}`;
                    if (seenInThisRun.has(dedupeKey)) continue; // already queued this run
                    seenInThisRun.add(dedupeKey);

                    batch.push({ name: villageName, parent_id: match.id });
                    if (batch.length >= BATCH_SIZE) {
                        await flush();
                        process.stdout.write(".");
                    }
                }
            }
        }
        await flush();

        console.log(`\n${stateRow.name}: inserted ${stateInserted}, skipped ${stateSkipped} (no matching district/taluka found).`);
        totalInserted += stateInserted;
        totalSkipped += stateSkipped;
    }

    if (unmatchedLines.length) {
        fs.mkdirSync(path.dirname(UNMATCHED_LOG_PATH), { recursive: true });
        fs.writeFileSync(UNMATCHED_LOG_PATH, unmatchedLines.join("\n"));
        console.log(`\n${unmatchedLines.length} sub-districts (or whole states) had no match — full list written to:\n  ${UNMATCHED_LOG_PATH}`);
    } else if (fs.existsSync(UNMATCHED_LOG_PATH)) {
        fs.unlinkSync(UNMATCHED_LOG_PATH); // clean stale log from a previous run
    }

    console.log(`\n\nDone — ${totalInserted} villages inserted (${totalMatchedByCode} sub-districts matched by code, ${totalMatchedByName} by normalized name), ${totalSkipped} village rows skipped nationwide.`);
    process.exit(0);
}

main().catch((err) => {
    console.error("\nVillage seed script failed:", err);
    process.exit(1);
});