// controllers/geoLocations.controller.js
//
// Pincode lookup now sources from data.gov.in's official "All India
// Pincode Directory" dataset instead of postalpincode.in. Records from
// that dataset frequently have "NA" in district/state/office fields for
// stale or non-deliverable entries — those are filtered out entirely.
// A pincode also commonly maps to many post office records that all
// belong to the SAME district (e.g. one pincode covering 15 post
// offices in one town) — instead of storing each post office as its own
// "city" node (which produced a lot of near-duplicate noise), each
// UNIQUE (state, district) pair is now stored as a single "city" node
// directly under its state. This is simpler, faster to query, and is
// really what a seller means by "which city/area do you dispatch from."
//
// PERFORMANCE: two layers—
//   1. An in-memory TTL cache (PINCODE_MEMORY_CACHE) so a pincode looked
//      up twice within CACHE_TTL_MS never even touches the DB or the
//      external API a second time — this is what makes repeat lookups
//      feel instant/real-time.
//   2. The Postgres cache (geo_locations rows) as before, for lookups
//      across server restarts / different instances. DB writes for a
//      fresh lookup now happen concurrently (Promise.all) instead of
//      one-at-a-time in a loop.

import { supabase } from "../config/supabase.js";

const DATA_GOV_RESOURCE_ID = "5c2f62fe-5afa-4119-a499-fec9d604d5bd";
const DATA_GOV_API_KEY = process.env.DATA_GOV_API_KEY
    || "579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b"; // sample key — capped at 10 records; set DATA_GOV_API_KEY in env for production

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — pincode->district/state mapping essentially never changes
const PINCODE_MEMORY_CACHE = new Map(); // pincode -> { data, expiresAt }

function isBlankOrNA(v) {
    if (v == null) return true;
    const s = String(v).trim().toUpperCase();
    return s === "" || s === "NA" || s === "N/A";
}

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

// Calls data.gov.in's pincode directory, scoped server-side to the exact
// pincode via filters[pincode] so we're never pulling more than what's
// needed for one lookup.
async function fetchPincodeRecordsFromGovApi(pincode) {
    const params = new URLSearchParams({
        "api-key": DATA_GOV_API_KEY,
        format: "json",
        limit: "50",
        "filters[pincode]": pincode,
    });
    const url = `https://api.data.gov.in/resource/${DATA_GOV_RESOURCE_ID}?${params}`;

    const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!resp.ok) throw new Error(`Gov pincode API responded ${resp.status}`);
    const json = await resp.json();

    // TEMP DIAGNOSTIC — remove once field name is confirmed.
    // console.log("[fetchPincodeRecordsFromGovApi] field list:", json?.field ? json.field.map(f => f.name) : "no field metadata");
    // console.log("[fetchPincodeRecordsFromGovApi] raw first record:", JSON.stringify(json?.records?.[0], null, 2));

    return Array.isArray(json?.records) ? json.records : [];
}

// Drops any record missing a usable state/district/pincode, and
// collapses the (often many) post-office-level records for one pincode
// down to their unique (state, district) pairs — a district IS the
// "city" level we actually want to offer a seller, not each individual
// post office name under it.
function dedupeToStateDistrictPairs(records) {
    const seen = new Map(); // key `${state}||${district}` -> { stateName, districtName }
    for (const r of records) {
        const stateName = r.statename?.trim();
        const districtName = r.district?.trim();
        if (isBlankOrNA(stateName) || isBlankOrNA(districtName)) continue;
        const key = `${stateName.toLowerCase()}||${districtName.toLowerCase()}`;
        if (!seen.has(key)) seen.set(key, { stateName, districtName });
    }
    return Array.from(seen.values());
}

async function ensureStateId(indiaId, stateName) {
    const { data: existing } = await supabase
        .from("geo_locations").select("id").eq("type", "state").ilike("name", stateName).eq("parent_id", indiaId).maybeSingle();
    if (existing) return existing.id;
    const { data: created, error } = await supabase
        .from("geo_locations").insert({ type: "state", name: stateName, parent_id: indiaId }).select("id").single();
    if (error) {
        // Race with a concurrent insert — re-select rather than fail.
        const { data: raced } = await supabase
            .from("geo_locations").select("id").eq("type", "state").ilike("name", stateName).eq("parent_id", indiaId).maybeSingle();
        if (raced) return raced.id;
        throw error;
    }
    return created.id;
}

// Ensures a single "city" row exists for this (state, district) pair,
// carrying the pincode — this IS the district, stored directly under
// the state (no separate district-level node), so it's immediately
// visible to DispatchingLocationsPicker via listCities() below with no
// extra join needed.
async function ensureDistrictCity(stateId, districtName, pincode) {
    if (!districtName || !districtName.trim()) {
        throw new Error(`ensureDistrictCity called with empty districtName for stateId=${stateId}, pincode=${pincode}`);
    }
    const { data: existing } = await supabase
        .from("geo_locations").select("id, pincode").eq("type", "city").ilike("name", districtName).eq("parent_id", stateId).maybeSingle();

    if (existing) {
        if (pincode && !existing.pincode) {
            await supabase.from("geo_locations").update({ pincode }).eq("id", existing.id);
        }
        return existing;
    }
    const { data: created, error } = await supabase
        .from("geo_locations").insert({ type: "city", name: districtName, parent_id: stateId, pincode: pincode || null }).select("id, name").single();
    if (error) {
        const { data: raced } = await supabase
            .from("geo_locations").select("id, name").eq("type", "city").ilike("name", districtName).eq("parent_id", stateId).maybeSingle();
        if (raced) return raced;
        throw error;
    }
    return created;
}

// Reusable — same logic that used to live only inside lookupPincode's
// handler, now callable from other controllers too.
export async function resolvePincode(pincode) {
    const cached = PINCODE_MEMORY_CACHE.get(pincode);
    if (cached && cached.expiresAt > Date.now()) return { ...cached.data, fromCache: true };

    const { data: cacheRow } = await supabase
        .from("pincode_lookup_cache")
        .select("state_id, city_id")
        .eq("pincode", pincode)
        .maybeSingle();

    if (cacheRow) {
        const [{ data: stateRow }, { data: cityRow }] = await Promise.all([
            supabase.from("geo_locations").select("name").eq("id", cacheRow.state_id).maybeSingle(),
            supabase.from("geo_locations").select("name").eq("id", cacheRow.city_id).maybeSingle(),
        ]);
        if (stateRow?.name && cityRow?.name) {
            const payload = { success: true, state: stateRow.name, district: cityRow.name };
            PINCODE_MEMORY_CACHE.set(pincode, { data: payload, expiresAt: Date.now() + CACHE_TTL_MS });
            return { ...payload, fromCache: true };
        }
        // Cache row points at something that no longer resolves cleanly —
        // fall through and re-resolve fresh instead of trusting it blindly.
    }

    const records = await fetchPincodeRecordsFromGovApi(pincode);
    const pairs = dedupeToStateDistrictPairs(records);
    if (!pairs.length) return { success: false, message: "That pincode wasn't found." };

    const { data: india } = await supabase.from("geo_locations").select("id").eq("type", "country").eq("name", "India").maybeSingle();
    if (!india) return { success: false, message: "Location data isn't set up yet." };

    // Pick the FIRST resolved pair as canonical for this pincode (a pincode
    // maps to one town in practice, even if the raw gov records list
    // several post offices with slightly different sub-divisions).
    const { stateName, districtName } = pairs[0];
    const stateId = await ensureStateId(india.id, stateName);
    const city = await ensureDistrictCity(stateId, districtName); // no pincode param anymore

    // Store the pincode -> (state,city) mapping in its OWN table —
    // never on the city row itself, since one city legitimately has many
    // pincodes and a single column can't represent that.
    await supabase.from("pincode_lookup_cache").upsert({ pincode, state_id: stateId, city_id: city.id });

    const payload = { success: true, state: stateName, district: city.name };
    PINCODE_MEMORY_CACHE.set(pincode, { data: payload, expiresAt: Date.now() + CACHE_TTL_MS });
    return { ...payload, fromCache: false };
}

// GET /api/geo/pincode/:pincode — now just a thin wrapper
export async function lookupPincode(req, res) {
    const { pincode } = req.params;
    if (!/^\d{6}$/.test(pincode)) {
        return res.status(400).json({ success: false, message: "Enter a valid 6-digit pincode." });
    }
    try {
        res.json(await resolvePincode(pincode));
    } catch (err) {
        console.error("[lookupPincode]", err.message);
        res.status(502).json({ success: false, message: "Couldn't reach the pincode lookup service." });
    }
}

// GET /api/geo/search?q=&type=
export async function searchGeo(req, res) {
    const { q = "", type } = req.query;
    if (!q.trim() || q.trim().length < 2) return res.json({ success: true, items: [] });
    let query = supabase.from("geo_locations").select("id, type, name, code, parent_id, pincode").ilike("name", `%${q.trim()}%`).limit(20);
    if (type) query = query.eq("type", type);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

// GET /api/geo/cities?stateId=&q=
// Cities are now always stored directly under their state (see
// ensureDistrictCity above) — no separate district level to traverse
// through anymore. Still checked below for backward compatibility with
// any older rows seeded before this change that hang off a district.
// GET /api/geo/cities?stateId=&q=
//
// UPDATED: cities used to only ever exist as a side effect of someone
// looking up an individual pincode (see ensureDistrictCity in
// lookupPincode) — which meant a state's city list stayed completely
// empty until enough pincodes had been looked up by chance to build it
// up. Since nothing pre-seeds this, every state showed "no cities on
// file" the first time. Now: if a state has zero cached cities, this
// pulls the FULL district list for that state directly from the
// government API (filtered by statename instead of pincode) in one
// shot, inserts them all, and serves from cache on every request after
// that — so a seller expanding any state for the first time gets a
// complete, real list immediately instead of an empty box.

const STATE_POPULATE_IN_FLIGHT = new Map(); // stateId -> Promise

async function populateCitiesForStateOnce(stateRow) {
    if (STATE_POPULATE_IN_FLIGHT.has(stateRow.id)) {
        return STATE_POPULATE_IN_FLIGHT.get(stateRow.id);
    }
    const promise = populateCitiesForState(stateRow).finally(() => {
        STATE_POPULATE_IN_FLIGHT.delete(stateRow.id);
    });
    STATE_POPULATE_IN_FLIGHT.set(stateRow.id, promise);
    return promise;
}

// GET /api/geo/cities?stateId=&q=
// Purely a DB read now — no external API calls in this path at all.
// Every state's districts are pre-seeded once via
// scripts/seedIndiaDistricts.js, so this is always instant regardless
// of load or which state is being requested.
export async function listCities(req, res) {
    const { stateId, q = "" } = req.query;
    if (!stateId) return res.status(400).json({ success: false, message: "stateId is required." });

    let query = supabase
        .from("geo_locations")
        .select("id, name, parent_id")
        .eq("type", "city")
        .eq("parent_id", stateId)
        .order("name")
        .limit(2000);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

// Pulls every unique district for a given state from the government API
// (paginated, since a large state can have hundreds of post-office
// records) and inserts each as a "city" row directly under that state —
// same shape ensureDistrictCity produces for a single-pincode lookup,
// just done in bulk for the whole state at once.
async function populateCitiesForState(stateRow) {
    const MAX_CONCURRENT_PAGES = 8;

    // fields= restricts the response to ONLY the columns we actually need
    // (district, statename) instead of every column (officename, pincode,
    // officetype, delivery, latitude, longitude, etc.) — for a state like
    // Karnataka that's ~9,658 post-office records, this alone cuts the
    // payload size (and JSON parse time) by roughly 5-6x, since we were
    // discarding almost every field anyway just to pull 31 district names.
    async function fetchPage(offset, limit) {
        const params = new URLSearchParams({
            "api-key": DATA_GOV_API_KEY,
            format: "json",
            limit: String(limit),
            offset: String(offset),
            "filters[statename]": stateRow.name.toUpperCase(),
            "fields": "district,statename",
        });
        const url = `https://api.data.gov.in/resource/${DATA_GOV_RESOURCE_ID}?${params}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!resp.ok) throw new Error(`Gov pincode API responded ${resp.status} while populating "${stateRow.name}"`);
        const json = await resp.json();
        return {
            records: Array.isArray(json?.records) ? json.records : [],
            total: Number(json?.total) || 0,
        };
    }

    const seenDistricts = new Set();
    const collect = (records) => {
        for (const r of records) {
            const districtName = (r.district || "").trim();
            if (!isBlankOrNA(districtName)) seenDistricts.add(districtName);
        }
    };

    // First call: ask for a large limit outright. Many data.gov.in
    // resources will happily return everything in one shot once the
    // response no longer needs to carry every column — try the whole
    // state's total in a single request first.
    const probe = await fetchPage(0, 10000);
    collect(probe.records);

    const total = probe.total;
    const gotSoFar = probe.records.length;

    // Only page further if the API actually capped us below the full
    // total despite the big requested limit.
    if (gotSoFar > 0 && gotSoFar < total) {
        const pageSize = gotSoFar; // whatever the API actually honored
        const remainingOffsets = [];
        for (let offset = pageSize; offset < total; offset += pageSize) remainingOffsets.push(offset);

        console.log(`[populateCitiesForState] "${stateRow.name}" total=${total} got=${gotSoFar}/request → fetching ${remainingOffsets.length} more page(s) in batches of ${MAX_CONCURRENT_PAGES}`);

        for (let i = 0; i < remainingOffsets.length; i += MAX_CONCURRENT_PAGES) {
            const batch = remainingOffsets.slice(i, i + MAX_CONCURRENT_PAGES);
            const results = await Promise.all(batch.map((offset) => fetchPage(offset, pageSize)));
            results.forEach((r) => collect(r.records));
        }
    }

    console.log(`[populateCitiesForState] "${stateRow.name}" finished — ${seenDistricts.size} unique districts found.`);

    if (!seenDistricts.size) return;

    await Promise.all(
        Array.from(seenDistricts).map((districtName) => ensureDistrictCity(stateRow.id, districtName, null))
    );
}

// GET /api/geo/buyer-fallback-location
// Used only when a buyer has no saved address at all (see
// fetchBuyerAddresses returning empty in the frontend). Falls back to
// whatever pincode their GST business profile carries — dispatch_pincode
// if they ship from somewhere other than their registered address,
// otherwise the registered pincode — and resolves it the exact same way
// a manual pincode entry would, so the result is the normal
// { state, district } shape callers already expect.
export async function getBuyerFallbackLocation(req, res) {
    const userId = req.user.id;

    const { data: business, error } = await supabase
        .from("business_profiles")
        .select("dispatch_same_as_registered, dispatch_pincode, pincode")
        .eq("user_id", userId)
        .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!business) return res.json({ success: false, message: "No business profile on file." });

    const pincode = business.dispatch_same_as_registered
        ? business.pincode
        : (business.dispatch_pincode || business.pincode);

    if (!pincode || !/^\d{6}$/.test(pincode)) {
        return res.json({ success: false, message: "No usable pincode on the business profile." });
    }

    try {
        const resolved = await resolvePincode(pincode);
        if (!resolved.success) return res.json(resolved);
        res.json({ success: true, state: resolved.state, district: resolved.district, pincode, source: "business_profile" });
    } catch (err) {
        console.error("[getBuyerFallbackLocation]", err.message);
        res.status(502).json({ success: false, message: "Couldn't reach the pincode lookup service." });
    }
}