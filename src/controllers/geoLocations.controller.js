// controllers/geoLocations.controller.js
//
// Serves the pre-seeded India hierarchy: country -> state -> district ->
// taluka -> village. Every list/search endpoint here is a pure, fast DB
// read; there is no per-request external API call anywhere in this file
// except lookupPincode (unrelated, standalone address-autofill helper).
// All hierarchy data must be present ahead of time via the seed scripts
// (scripts/seedIndiaLGD.js, scripts/seedIndiaVillages.js).

import { supabase } from "../config/supabase.js";

const TYPE_ORDER = ["country", "state", "district", "taluka", "village"];

// GET /api/geo/countries
export async function listCountries(req, res) {
    const { data, error } = await supabase
        .from("geo_locations")
        .select("id, name, code")
        .eq("type", "country")
        .order("name");
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

// GET /api/geo/states?countryId=&q=
export async function listStates(req, res) {
    const { countryId, q = "" } = req.query;
    if (!countryId) return res.status(400).json({ success: false, message: "countryId is required." });
    let query = supabase
        .from("geo_locations")
        .select("id, name, code")
        .eq("type", "state")
        .eq("parent_id", countryId)
        .order("name");
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

// GET /api/geo/districts?stateId=&q=
export async function listDistricts(req, res) {
    const { stateId, q = "" } = req.query;
    if (!stateId) return res.status(400).json({ success: false, message: "stateId is required." });
    let query = supabase
        .from("geo_locations")
        .select("id, name")
        .eq("type", "district")
        .eq("parent_id", stateId)
        .order("name")
        .limit(200);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

// GET /api/geo/areas?districtId=&q=
// "Areas" are LGD sub-districts (taluka/tehsil/mandal/circle depending on
// the state) — named generically since the seller-facing UI never surfaces
// the word "taluka" itself.
export async function listAreas(req, res) {
    const { districtId, q = "" } = req.query;
    if (!districtId) return res.status(400).json({ success: false, message: "districtId is required." });
    let query = supabase
        .from("geo_locations")
        .select("id, name")
        .eq("type", "taluka")
        .eq("parent_id", districtId)
        .order("name")
        .limit(500);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

// GET /api/geo/villages?talukaId=&q=
export async function listVillages(req, res) {
    const { talukaId, q = "" } = req.query;
    if (!talukaId) return res.status(400).json({ success: false, message: "talukaId is required." });
    let query = supabase
        .from("geo_locations")
        .select("id, name")
        .eq("type", "village")
        .eq("parent_id", talukaId)
        .order("name")
        .limit(1000);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

// Walks parent_id up to the root for a single row. Hierarchy is only 5
// levels deep (country..village) so this is at most 4 round trips — fine
// for the handful of rows a search typically returns, and far simpler than
// a recursive CTE we'd have to maintain separately.
async function resolveAncestors(row) {
    const chain = [];
    let current = row;
    while (current?.parent_id) {
        const { data: parent } = await supabase
            .from("geo_locations")
            .select("id, type, name, parent_id")
            .eq("id", current.parent_id)
            .maybeSingle();
        if (!parent) break;
        chain.unshift({ type: parent.type, name: parent.name });
        current = parent;
    }
    return chain;
}

// GET /api/geo/search?q=&type=
// Used by the picker's quick-search bar. Returns each match together with
// its ancestor breadcrumb (state/district/taluka names) so the UI can show
// "Ribda — village, in Kotda Sangani, Rajkot, Gujarat" without the seller
// having to expand four levels of tree to find it.
export async function searchGeo(req, res) {
    const { q = "", type } = req.query;
    if (!q.trim() || q.trim().length < 2) return res.json({ success: true, items: [] });

    let query = supabase
        .from("geo_locations")
        .select("id, type, name, code, parent_id")
        .ilike("name", `%${q.trim()}%`)
        .neq("type", "country")
        .limit(25);
    if (type) query = query.eq("type", type);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    const rows = data || [];
    // Sort so more-specific matches (village/taluka) surface above broad
    // state/district matches, then alphabetically within a type.
    rows.sort((a, b) => TYPE_ORDER.indexOf(b.type) - TYPE_ORDER.indexOf(a.type) || a.name.localeCompare(b.name));

    const withBreadcrumbs = await Promise.all(
        rows.slice(0, 60).map(async (row) => ({
            id: row.id,
            type: row.type,
            name: row.name,
            parent_id: row.parent_id,
            ancestors: await resolveAncestors(row),
        }))
    );

    res.json({ success: true, items: withBreadcrumbs });
}

// GET /api/geo/pincode/:pincode
//
// Standalone lookup for address-autofill elsewhere in the app — decoupled
// from the State/District/Area/Village hierarchy used by
// DispatchingLocationsPicker (a pincode maps to an individual post office,
// not cleanly to a taluka or village).
const DATA_GOV_RESOURCE_ID = "5c2f62fe-5afa-4119-a499-fec9d604d5bd";
const DATA_GOV_API_KEY = process.env.DATA_GOV_API_KEY
    || "579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b"; // sample key — capped at 10 records; set DATA_GOV_API_KEY in env for production

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PINCODE_MEMORY_CACHE = new Map();

function isBlankOrNA(v) {
    if (v == null) return true;
    const s = String(v).trim().toUpperCase();
    return s === "" || s === "NA" || s === "N/A";
}

export async function lookupPincode(req, res) {
    const { pincode } = req.params;
    if (!/^\d{6}$/.test(pincode)) {
        return res.status(400).json({ success: false, message: "Enter a valid 6-digit pincode." });
    }

    const cached = PINCODE_MEMORY_CACHE.get(pincode);
    if (cached && cached.expiresAt > Date.now()) {
        return res.json({ ...cached.data, fromCache: true });
    }

    const params = new URLSearchParams({
        "api-key": DATA_GOV_API_KEY,
        format: "json",
        limit: "50",
        "filters[pincode]": pincode,
    });
    const url = `https://api.data.gov.in/resource/${DATA_GOV_RESOURCE_ID}?${params}`;

    let json;
    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!resp.ok) throw new Error(`Gov pincode API responded ${resp.status}`);
        json = await resp.json();
    } catch (err) {
        console.error("[lookupPincode] gov API fetch failed:", err.message);
        return res.status(502).json({ success: false, message: "Couldn't reach the pincode lookup service. You can still type your location manually." });
    }

    const records = Array.isArray(json?.records) ? json.records : [];
    const first = records.find((r) => !isBlankOrNA(r.statename) && !isBlankOrNA(r.district));
    if (!first) {
        return res.status(404).json({ success: false, message: "That pincode wasn't found." });
    }

    const payload = {
        success: true,
        state: first.statename?.trim(),
        district: first.district?.trim(),
    };
    PINCODE_MEMORY_CACHE.set(pincode, { data: payload, expiresAt: Date.now() + CACHE_TTL_MS });
    res.json({ ...payload, fromCache: false });
}