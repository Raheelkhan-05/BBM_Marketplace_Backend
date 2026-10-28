// services/orderBook.service.js
// Shared helpers for the Order Book: DTOs, signed document URLs, realtime fan-out.
import { supabase } from "../config/supabase.js";
import { emitToUser } from "./realtimeBroadcast.js";
import { teamUserIdsOf } from "./team.service.js";

export const BUCKET = "sales-attachments";            // private bucket, files live under ob/<orderId>/
export const STATUSES = ["placed", "processed", "shipped", "completed", "cancelled"];
export const LIST_COLS = "id, order_no, status, customer_name, customer_gstin, items, total_amount, salesperson_id, salesperson_name, created_at, last_activity_at";

export function orderDto(r, docs = null) {
    const items = Array.isArray(r.items) ? r.items : [];
    return {
        id: r.id, orderNo: r.order_no, status: r.status,
        customerName: r.customer_name || "", customerGstin: r.customer_gstin || "",
        customerPhone: r.customer_phone || "", customerEmail: r.customer_email || "",
        customerAddress: r.customer_address || "", customerCity: r.customer_city || "",
        customerState: r.customer_state || "", customerPincode: r.customer_pincode || "",
        items, itemsCount: items.length, total: Number(r.total_amount) || 0, notes: r.notes || "",
        salespersonId: r.salesperson_id, salespersonName: r.salesperson_name || "",
        lrNumber: r.lr_number || "", lrNotes: r.lr_notes || "", cancelReason: r.cancel_reason || "",
        processedAt: r.processed_at || null, shippedAt: r.shipped_at || null,
        completedAt: r.completed_at || null, cancelledAt: r.cancelled_at || null,
        createdAt: r.created_at, lastActivityAt: r.last_activity_at || r.created_at,
        docs,
    };
}

export const eventDto = (e) => ({
    id: e.id, kind: e.kind, body: e.body || "", actorName: e.actor_name || "", createdAt: e.created_at,
});

// 1-hour signed links for the LR document and the bill.
export async function signDocs(row) {
    const paths = [row.lr_proof_path, row.bill_path].filter(Boolean);
    if (!paths.length) return null;
    const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
    const by = new Map((data || []).map((d) => [d.path, d.signedUrl]));
    return {
        lrUrl: row.lr_proof_path ? by.get(row.lr_proof_path) || null : null,
        billUrl: row.bill_path ? by.get(row.bill_path) || null : null,
    };
}

// Content-light ping that makes every open Order Book screen refetch quietly.
//  - the salesperson who owns the order gets { mine: true }
//  - the company owner, admins and members get the same event without it
export async function broadcast({ companyId, salespersonId, payload }) {
    try {
        const at = new Date().toISOString();
        const team = await teamUserIdsOf([companyId]);
        const ids = new Set(team.map(String).filter((id) => id !== String(salespersonId)));
        ids.add(String(companyId));
        ids.forEach((id) => emitToUser(id, "orderbook:changed", { ...payload, at }));
        if (salespersonId) emitToUser(String(salespersonId), "orderbook:changed", { ...payload, mine: true, at });
    } catch (e) { console.error("[order book] broadcast failed:", e?.message || e); }
}