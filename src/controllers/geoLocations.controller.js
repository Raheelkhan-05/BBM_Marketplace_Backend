// controllers/geoLocations.controller.js
//
// Powers DispatchingLocationsPicker's search box. Only country/state are
// backed by the geo_locations table (see migration 003). City/district
// entries aren't looked up — the frontend lets the seller type a free-text
// city/district and adds it as its own node in the tree (see the picker
// component below for how that's disambiguated in the UI).

import { supabase } from "../config/supabase.js";

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

// GET /api/geo/pincode/:pincode
// Proxies India Post's free pincode API, caches state/district as
// geo_locations rows (type='district', parent=state), and caches every
// post-office name under that pincode as type='city' so the
// DispatchingLocationsPicker's city search gets real matches over time.
export async function lookupPincode(req, res) {
    const { pincode } = req.params;
    if (!/^\d{6}$/.test(pincode)) {
        return res.status(400).json({ success: false, message: "Enter a valid 6-digit pincode." });
    }

    // Serve from cache first — avoids hammering the external API for
    // pincodes we've already resolved.
    const { data: cached } = await supabase
        .from("geo_locations").select("id, name, type, parent_id").eq("pincode", pincode).eq("type", "district").maybeSingle();
    if (cached) {
        const { data: state } = await supabase.from("geo_locations").select("id, name").eq("id", cached.parent_id).maybeSingle();
        const { data: cities } = await supabase.from("geo_locations").select("name").eq("pincode", pincode).eq("type", "city");
        return res.json({ success: true, state: state?.name, district: cached.name, offices: (cities || []).map((c) => c.name), fromCache: true });
    }

    let apiData;
    try {
        const resp = await fetch(`https://api.postalpincode.in/pincode/${pincode}`);
        const json = await resp.json();
        apiData = json?.[0];
    } catch {
        return res.status(502).json({ success: false, message: "Couldn't reach the pincode lookup service. You can still type your location manually." });
    }
    if (!apiData || apiData.Status !== "Success" || !apiData.PostOffice?.length) {
        return res.status(404).json({ success: false, message: "That pincode wasn't found." });
    }

    const first = apiData.PostOffice[0];
    const stateName = first.State;
    const districtName = first.District;
    const officeNames = [...new Set(apiData.PostOffice.map((o) => o.Name))];

    const { data: india } = await supabase.from("geo_locations").select("id").eq("type", "country").eq("name", "India").maybeSingle();
    let { data: state } = await supabase.from("geo_locations").select("id, name").eq("type", "state").ilike("name", stateName).eq("parent_id", india?.id).maybeSingle();
    if (!state && india) {
        const { data: created } = await supabase.from("geo_locations").insert({ type: "state", name: stateName, parent_id: india.id }).select("id, name").single();
        state = created;
    }

    let { data: district } = await supabase.from("geo_locations").select("id").eq("type", "district").ilike("name", districtName).eq("parent_id", state?.id).maybeSingle();
    if (!district && state) {
        const { data: created } = await supabase.from("geo_locations").insert({ type: "district", name: districtName, parent_id: state.id, pincode }).select("id").single();
        district = created;
    }

    if (district) {
        for (const office of officeNames) {
            await supabase.from("geo_locations").insert({ type: "city", name: office, parent_id: district.id, pincode }).select("id").maybeSingle().then(() => { }, () => { });
        }
    }

    res.json({ success: true, state: stateName, district: districtName, offices: officeNames, fromCache: false });
}

// GET /api/geo/search?q=&type=  — extended to optionally filter by type
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
// Cities are stored two levels under state (state -> district -> city), so
// this resolves the district IDs under the state first, then pulls every
// city under those districts. Returns the full list (no query) so the
// frontend can offer a proper "select all" checkbox list, or a filtered
// subset when the seller types to narrow it down.
export async function listCities(req, res) {
    const { stateId, q = "" } = req.query;
    if (!stateId) return res.status(400).json({ success: false, message: "stateId is required." });

    const { data: districts, error: districtErr } = await supabase
        .from("geo_locations")
        .select("id")
        .eq("type", "district")
        .eq("parent_id", stateId);
    if (districtErr) return res.status(500).json({ success: false, message: districtErr.message });

    const districtIds = (districts || []).map((d) => d.id);
    if (!districtIds.length) return res.json({ success: true, items: [] });

    let query = supabase
        .from("geo_locations")
        .select("id, name, parent_id")
        .eq("type", "city")
        .in("parent_id", districtIds)
        .order("name")
        .limit(500);
    if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}