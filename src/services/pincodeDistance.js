// services/pincodeDistance.js
//
// CHANGED: added a cache table (road_distance_cache) in front of the
// OSRM call. OSRM is a free public demo server with no latency
// guarantee — every quote fetch (which fires on every quantity/basis
// change in BuyNowModal) was paying its full round trip live, commonly
// 500ms-4s. Most quote requests are the same seller <-> same buyer
// pincode pair repeated (a buyer trying different quantities, or the
// debounced re-fetch firing again), so a cache makes almost every quote
// after the first one for a given route effectively free. A haversine
// fallback result is cached too (tagged so it's easy to identify/backfill
// later), so a transient OSRM outage doesn't cause repeated slow retries
// for the same route within the outage window.
import { supabase } from "../config/supabase.js";

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const FALLBACK_ROAD_FACTOR = 1.3;
const OSRM_BASE_URL = "https://router.project-osrm.org/route/v1/driving";
// CHANGED: was 4000ms — with caching in front, a slow/failed OSRM call
// only ever happens once per route ever (or once per cache-expiry
// window), so it's safe to fail fast and fall back rather than making a
// buyer wait up to 4s on a cold route.
const OSRM_TIMEOUT_MS = 2000;
// Re-fetch a cached route occasionally in case road infrastructure
// changes — 90 days is generous; road distances don't change often.
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

async function fetchOsrmRoadDistanceKm(originLat, originLng, destLat, destLng) {
    const url = `${OSRM_BASE_URL}/${originLng},${originLat};${destLng},${destLat}?overview=false`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return null;
        const data = await res.json();
        const meters = data?.routes?.[0]?.distance;
        return typeof meters === "number" ? meters / 1000 : null;
    } catch (err) {
        console.error("OSRM routing call failed:", err?.message || err);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function getCachedDistance(originPincode, destPincode) {
    const { data } = await supabase
        .from("road_distance_cache")
        .select("distance_km, computed_at")
        .eq("origin_pincode", originPincode)
        .eq("dest_pincode", destPincode)
        .maybeSingle();
    if (!data) return null;
    if (Date.now() - new Date(data.computed_at).getTime() > CACHE_TTL_MS) return null;
    return data.distance_km;
}

async function cacheDistance(originPincode, destPincode, km, source) {
    // Fire-and-forget — a caching failure should never slow down or break
    // the quote response itself.
    supabase
        .from("road_distance_cache")
        .upsert({ origin_pincode: originPincode, dest_pincode: destPincode, distance_km: km, source, computed_at: new Date().toISOString() })
        .then(() => { }, (err) => console.error("[pincodeDistance] cache write failed:", err?.message || err));
}

export async function getRoadDistanceKm(originPincode, destPincode) {
    if (!originPincode || !destPincode) return null;
    if (originPincode === destPincode) return 0;

    // CHANGED: check the cache before doing anything else — this is the
    // fast path that now serves almost every repeat request.
    const cached = await getCachedDistance(originPincode, destPincode);
    if (cached != null) return cached;

    const { data, error } = await supabase
        .from("pincode_geo")
        .select("pincode, lat, lng")
        .in("pincode", [originPincode, destPincode]);
    if (error || !data || data.length < 2) return null;

    const origin = data.find((r) => r.pincode === originPincode);
    const dest = data.find((r) => r.pincode === destPincode);
    if (!origin || !dest) return null;

    const roadKm = await fetchOsrmRoadDistanceKm(origin.lat, origin.lng, dest.lat, dest.lng);
    if (roadKm != null) {
        cacheDistance(originPincode, destPincode, roadKm, "osrm");
        return roadKm;
    }

    console.warn(`OSRM unavailable for ${originPincode}->${destPincode}, falling back to haversine estimate`);
    const fallbackKm = haversineKm(origin.lat, origin.lng, dest.lat, dest.lng) * FALLBACK_ROAD_FACTOR;
    cacheDistance(originPincode, destPincode, fallbackKm, "haversine_fallback");
    return fallbackKm;
}