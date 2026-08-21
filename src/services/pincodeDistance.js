// services/pincodeDistance.js
//
// FIXED: getRoadDistanceKm previously used haversine (straight-line)
// distance × a flat 1.3 "road factor" fudge multiplier. That breaks down
// badly on routes with real detours — e.g. Mumbai (400001) -> Rajkot
// (360003) needed a ~1.54x factor to match the real ~680km road distance,
// while Mumbai -> Chennai (600001) only needed ~1.30x. There's no single
// constant that's correct for both, because the actual detour depends on
// coastline/hills/river crossings on that specific route, not distance.
//
// FIX: call OSRM (Open Source Routing Machine) to get the real driving
// route distance between the two lat/lng points, instead of guessing from
// a straight line. This is the actual road network, not an approximation
// of it. Falls back to haversine × 1.3 only if the routing call itself
// fails (network issue, OSRM demo server down, etc.) — that fallback is
// now a last resort, not the primary path.
import { supabase } from "../config/supabase.js";

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Only used if the OSRM call itself fails — a rough placeholder so
// delivery estimates degrade gracefully instead of breaking entirely.
const FALLBACK_ROAD_FACTOR = 1.3;

// Public OSRM demo server. Fine for low/moderate volume; if this becomes
// a high-traffic path, self-host OSRM (or switch to a paid provider like
// Google Distance Matrix / Mapbox Directions) instead of relying on the
// public demo instance's rate limits and uptime.
const OSRM_BASE_URL = "https://router.project-osrm.org/route/v1/driving";
const OSRM_TIMEOUT_MS = 4000;

async function fetchOsrmRoadDistanceKm(originLat, originLng, destLat, destLng) {
    const url = `${OSRM_BASE_URL}/${originLng},${originLat};${destLng},${destLat}?overview=false`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);

    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return null;

        const data = await res.json();
        const meters = data?.routes?.[0]?.distance;
        if (typeof meters !== "number") return null;

        return meters / 1000; // OSRM returns meters
    } catch (err) {
        console.error("OSRM routing call failed:", err?.message || err);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

export async function getRoadDistanceKm(originPincode, destPincode) {
    if (!originPincode || !destPincode) return null;
    if (originPincode === destPincode) return 0;

    const { data, error } = await supabase
        .from("pincode_geo")
        .select("pincode, lat, lng")
        .in("pincode", [originPincode, destPincode]);
    if (error || !data || data.length < 2) return null; // fall back to old heuristic upstream

    const origin = data.find((r) => r.pincode === originPincode);
    const dest = data.find((r) => r.pincode === destPincode);
    if (!origin || !dest) return null;

    // Primary path: real road-network routing.
    const roadKm = await fetchOsrmRoadDistanceKm(origin.lat, origin.lng, dest.lat, dest.lng);
    if (roadKm != null) return roadKm;

    // Last resort only: OSRM was unreachable/failed, so approximate with
    // haversine × a flat factor rather than returning nothing. This is
    // knowingly less accurate (see file header) — it exists purely so a
    // transient network hiccup doesn't take delivery estimates down
    // entirely, not as a substitute for real routing.
    console.warn(`OSRM unavailable for ${originPincode}->${destPincode}, falling back to haversine estimate`);
    return haversineKm(origin.lat, origin.lng, dest.lat, dest.lng) * FALLBACK_ROAD_FACTOR;
}