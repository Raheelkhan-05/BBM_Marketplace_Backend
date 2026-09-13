// scripts/stripCensusSuffixes.js
//
// One-time cleanup: strips trailing census/admin-status annotations —
// (CT) Census Town, (M) Municipality, (NA) Notified Area, (OG) Out Growth,
// (CB) Cantonment Board, (P) Part, (NP) Notified Area/Nagar Panchayat,
// (TP) Town Panchayat — from `name` on geo_locations rows, so sellers see
// and can search for "Shapar" instead of "Shapar (CT)".
//
// SAFETY:
//   - Only touches type = 'village' and type = 'taluka' rows (these are
//     the two levels LGD/Census attaches such suffixes to; states and
//     districts don't carry them).
//   - Before renaming, checks whether a row with the STRIPPED name already
//     exists under the SAME parent_id. If so, this is a genuine collision
//     (e.g. both "Shapar" and "Shapar (CT)" already listed separately
//     under one taluka) and is logged rather than silently merged/dropped
//     — merging two distinct DB rows requires deciding what happens to any
//     data referencing the "loser" row, which this script does not assume
//     is safe to do automatically.
//   - Everything else is a plain UPDATE by primary key — no batch inserts,
//     no upserts, nothing that could duplicate a row.
//   - Idempotent: rows with no suffix are untouched; already-stripped rows
//     match nothing on re-run.
//
// DRY RUN by default — prints exactly what it would change without writing
// anything. Pass --apply to actually perform the updates.
//
// Run with:
//   node scripts/stripCensusSuffixes.js            (dry run, safe to run anytime)
//   node scripts/stripCensusSuffixes.js --apply     (applies the changes)


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

const SUFFIX_PATTERN = /\s*\((CT|M|NA|OG|CB|P|NP|TP)\)\s*$/i;

function stripSuffix(name) {
    return name.replace(SUFFIX_PATTERN, "").trim();
}

async function fetchAllOfType(type) {
    // Paginated fetch — Supabase default caps a single select around 1000
    // rows, and village-level tables nationwide are ~580k rows.
    const pageSize = 1000;
    let from = 0;
    const all = [];
    for (; ;) {
        const { data, error } = await supabase
            .from("geo_locations")
            .select("id, name, parent_id")
            .eq("type", type)
            .range(from, from + pageSize - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return all;
}

async function main() {
    const apply = process.argv.includes("--apply");
    console.log(apply ? "Running in APPLY mode — changes will be written.\n" : "Running in DRY RUN mode — no changes will be written. Pass --apply to write.\n");

    for (const type of ["village", "taluka"]) {
        console.log(`\n=== Scanning type="${type}" ===`);
        const rows = await fetchAllOfType(type);

        const candidates = rows.filter((r) => SUFFIX_PATTERN.test(r.name));
        console.log(`${rows.length} total rows, ${candidates.length} carry a stripable suffix.`);

        if (candidates.length === 0) continue;

        // Build a lookup of existing names per parent, from the SAME
        // fetched set, so we can detect collisions without one query per
        // row.
        const byParent = new Map(); // parent_id -> Set(name)
        for (const r of rows) {
            if (!byParent.has(r.parent_id)) byParent.set(r.parent_id, new Set());
            byParent.get(r.parent_id).add(r.name);
        }

        let renamed = 0;
        let collisions = 0;
        const collisionLines = [];

        for (const row of candidates) {
            const stripped = stripSuffix(row.name);
            if (!stripped || stripped === row.name) continue;

            const siblingNames = byParent.get(row.parent_id) || new Set();
            const collisionExists = [...siblingNames].some(
                (n) => n !== row.name && n.toLowerCase() === stripped.toLowerCase()
            );

            if (collisionExists) {
                collisions++;
                collisionLines.push(`[${type}] id=${row.id} "${row.name}" -> "${stripped}" collides with an existing sibling under parent_id=${row.parent_id} — SKIPPED, needs manual review.`);
                continue;
            }

            console.log(`  ${row.name}  ->  ${stripped}`);
            if (apply) {
                const { error } = await supabase
                    .from("geo_locations")
                    .update({ name: stripped })
                    .eq("id", row.id);
                if (error) {
                    console.error(`    FAILED to update id=${row.id}: ${error.message}`);
                    continue;
                }
            }
            renamed++;
        }

        console.log(`\n${type}: ${renamed} ${apply ? "renamed" : "would be renamed"}, ${collisions} collision(s) skipped.`);
        if (collisionLines.length) {
            console.log("Collisions needing manual review:");
            collisionLines.forEach((l) => console.log("  " + l));
        }
    }

    console.log(`\nDone.${apply ? "" : " Re-run with --apply to write these changes."}`);
    process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });