// services/pincodeDistance.js
import { supabase } from "../config/supabase.js";

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Road distance in India runs ~1.2-1.4x straight-line distance due to
// highway routing around terrain/water — this factor lets transit-day
// bands reflect actual travel time rather than as-the-crow-flies km.
const ROAD_FACTOR = 1.3;

export async function getRoadDistanceKm(originPincode, destPincode) {
    if (!originPincode || !destPincode) return null;
    if (originPincode === destPincode) return 0;

    const { data, error } = await supabase
        .from("pincode_geo")
        .select("pincode, lat, lng")
        .in("pincode", [originPincode, destPincode]);
    if (error || !data || data.length < 2) return null; // fall back to old heuristic

    const origin = data.find((r) => r.pincode === originPincode);
    const dest = data.find((r) => r.pincode === destPincode);
    if (!origin || !dest) return null;

    return haversineKm(origin.lat, origin.lng, dest.lat, dest.lng) * ROAD_FACTOR;
}