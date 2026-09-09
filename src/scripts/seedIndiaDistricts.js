// scripts/seedIndiaDistricts.js
//
// Run this ONCE (e.g. `node scripts/seedIndiaDistricts.js`) to fully
// pre-populate every Indian state's districts from the official
// data.gov.in pincode directory, ahead of time — NOT lazily on a
// seller's first pick in DispatchingLocationsPicker.
//
// Why this exists: fetching a state's districts from the live
// government API at request time can never feel instant, no matter how
// optimized the request is — it's still a real network round trip to
// an external server (and for big states, more than one). India's full
// state/district list is small and effectively static (~36 states,
// ~750 districts total), so the right fix is to load it all ONE TIME
// into our own DB, and have every actual user-facing request (listCities)
// serve purely from Postgres from then on — genuinely instant, no
// external calls in the hot path ever again.
//
// Safe to re-run — it's idempotent (skips districts already present).

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

const DATA_GOV_RESOURCE_ID = "5c2f62fe-5afa-4119-a499-fec9d604d5bd";
const DATA_GOV_API_KEY = '579b464db66ec23bdd000001b4669202e8724be945e1ac30a739b78b';

if (!DATA_GOV_API_KEY) {
    console.error("Set DATA_GOV_API_KEY in your environment before running this script.");
    process.exit(1);
}

function isBlankOrNA(v) {
    if (v == null) return true;
    const s = String(v).trim().toUpperCase();
    return s === "" || s === "NA" || s === "N/A";
}

async function fetchAllDistrictsForState(stateName) {
    const seen = new Set();
    let offset = 0;
    const limit = 10000; // large enough that almost every state resolves in one call

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const params = new URLSearchParams({
            "api-key": DATA_GOV_API_KEY,
            format: "json",
            limit: String(limit),
            offset: String(offset),
            "filters[statename]": stateName.toUpperCase(),
            "fields": "district,statename",
        });
        const url = `https://api.data.gov.in/resource/${DATA_GOV_RESOURCE_ID}?${params}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`API responded ${resp.status} for "${stateName}"`);
        const json = await resp.json();
        const records = Array.isArray(json?.records) ? json.records : [];
        const total = Number(json?.total) || 0;

        for (const r of records) {
            const d = (r.district || "").trim();
            if (!isBlankOrNA(d)) seen.add(d);
        }

        offset += records.length;
        if (records.length === 0 || offset >= total) break;
    }

    return Array.from(seen);
}

async function ensureStateId(indiaId, stateName) {
    const { data: existing } = await supabase
        .from("geo_locations").select("id").eq("type", "state").ilike("name", stateName).eq("parent_id", indiaId).maybeSingle();
    if (existing) return existing.id;
    const { data: created, error } = await supabase
        .from("geo_locations").insert({ type: "state", name: stateName, parent_id: indiaId }).select("id").single();
    if (error) throw error;
    return created.id;
}

async function ensureDistrictCity(stateId, districtName) {
    const { data: existing } = await supabase
        .from("geo_locations").select("id").eq("type", "city").ilike("name", districtName).eq("parent_id", stateId).maybeSingle();
    if (existing) return;
    const { error } = await supabase
        .from("geo_locations").insert({ type: "city", name: districtName, parent_id: stateId, pincode: null });
    if (error) throw error;
}

const INDIA_STATES = [
    "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar",
    "Chhattisgarh", "Goa", "Gujarat", "Haryana",
    "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala",
    "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya",
    "Mizoram", "Nagaland", "Odisha", "Punjab",
    "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana",
    "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
    "Andaman and Nicobar Islands", "Chandigarh",
    "Dadra and Nagar Haveli and Daman and Diu", "Delhi",
    "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry",
];

async function main() {
    const { data: india } = await supabase.from("geo_locations").select("id").eq("type", "country").eq("name", "India").maybeSingle();
    if (!india) throw new Error(`No "India" row found in geo_locations — insert it first.`);

    for (const stateName of INDIA_STATES) {
        process.stdout.write(`Fetching ${stateName}... `);
        const stateId = await ensureStateId(india.id, stateName);
        const districts = await fetchAllDistrictsForState(stateName);
        await Promise.all(districts.map((d) => ensureDistrictCity(stateId, d)));
        console.log(`${districts.length} districts saved.`);
    }

    console.log("\nDone — every state's districts are now pre-seeded in the DB.");
    process.exit(0);
}

main().catch((err) => {
    console.error("Seed script failed:", err);
    process.exit(1);
});