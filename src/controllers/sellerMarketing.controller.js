import { supabase } from "../config/supabase.js";
import { publishListingChange } from "../services/listingRealtime.service.js";
import { resolveMarketingFields } from "../services/marketing.service.js";
import { computeNextServices, isKnownServiceKey } from "../../shared/marketingServices.js";

const MAX_IDS = 200;
const FIELDS = "id, marketing_services, marketing_commission_percent, marketing_legacy_percent";

// PATCH /api/seller/catalog/marketing/bulk  { submissionIds, mode: set|add|remove, services }
export async function bulkUpdateMarketing(req, res) {
    const sellerId = req.sellerId;
    const { submissionIds, mode = "set", services } = req.body || {};

    if (!Array.isArray(submissionIds) || !submissionIds.length) return res.status(400).json({ success: false, message: "Select at least one listing." });
    if (!["set", "add", "remove"].includes(mode)) return res.status(400).json({ success: false, message: "Invalid mode." });
    if (!Array.isArray(services) || services.some((k) => !isKnownServiceKey(k))) return res.status(400).json({ success: false, message: "Unknown marketing service." });
    if (mode !== "set" && !services.length) return res.status(400).json({ success: false, message: "Choose at least one service." });

    const ids = [...new Set(submissionIds.filter((x) => typeof x === "string"))];
    if (ids.length > MAX_IDS) return res.status(400).json({ success: false, message: `Update at most ${MAX_IDS} listings at a time.` });

    const { data: rows, error } = await supabase
        .from("seller_product_submissions").select("id, marketing_services")
        .eq("seller_id", sellerId).in("id", ids);
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!rows?.length) return res.status(404).json({ success: false, message: "Listings not found." });

    // One UPDATE per distinct resulting plan (usually 1-2), not one per listing.
    const groups = new Map();
    for (const r of rows) {
        const next = computeNextServices(r.marketing_services, mode, services);
        const k = next.join(",");
        if (!groups.has(k)) groups.set(k, { next, ids: [] });
        groups.get(k).ids.push(r.id);
    }

    const results = await Promise.all([...groups.values()].map(async (g) => {
        const { data, error: e } = await supabase.from("seller_product_submissions")
            .update(resolveMarketingFields(g.next))
            .eq("seller_id", sellerId).in("id", g.ids).select(FIELDS);
        return { data: data || [], error: e };
    }));

    const items = results.flatMap((r) => r.data);
    items.forEach((it) => void publishListingChange(it.id));

    if (results.some((r) => r.error)) {
        return res.status(500).json({ success: false, items, message: "Some listings couldn't be updated. Please retry." });
    }
    res.json({ success: true, items, skipped: ids.length - rows.length, message: `Updated ${items.length} listing${items.length === 1 ? "" : "s"}.` });
}