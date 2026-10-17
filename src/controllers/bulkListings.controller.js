// controllers/bulkListings.controller.js
// Soft-saved bulk-upload queue. Listings themselves are still created by the normal
// createSubmission / createListingForExistingBrand endpoints; this only stores drafts.
import { supabase } from "../config/supabase.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PENDING = 500;
const MAX_CHUNK = 50;
const MAX_ITEM_CHARS = 60000;
const COLS = "id, batch_id, file_name, row_no, data, status, submission_id, created_at";

const validData = (d) => d && typeof d === "object" && !Array.isArray(d) && JSON.stringify(d).length <= MAX_ITEM_CHARS;

// GET /api/seller/bulk/summary
export async function bulkSummary(req, res) {
    const { count, error } = await supabase
        .from("seller_bulk_items").select("id", { count: "exact", head: true })
        .eq("seller_id", req.sellerId).eq("status", "pending");
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, pending: count || 0 });
}

// GET /api/seller/bulk/items — everything still waiting to be submitted
export async function listBulkItems(req, res) {
    const { data, error } = await supabase
        .from("seller_bulk_items").select(COLS)
        .eq("seller_id", req.sellerId).eq("status", "pending")
        .order("created_at", { ascending: true }).order("row_no", { ascending: true })
        .limit(MAX_PENDING);
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, items: data || [] });
}

// POST /api/seller/bulk/items  { batchId, fileName, items: [{ rowNo, data }] }  (<= 50 per call)
// Idempotent on (batch_id,row_no): a retried chunk never creates duplicates.
export async function createBulkItems(req, res) {
    const { batchId, fileName, items } = req.body || {};
    if (!UUID_RE.test(String(batchId || ""))) return res.status(400).json({ success: false, message: "Invalid batch." });
    if (!Array.isArray(items) || !items.length || items.length > MAX_CHUNK) {
        return res.status(400).json({ success: false, message: `Send between 1 and ${MAX_CHUNK} products at a time.` });
    }
    for (const it of items) {
        if (!Number.isInteger(it?.rowNo) || it.rowNo < 1 || !validData(it.data)) {
            return res.status(400).json({ success: false, message: "One of the products is invalid or too large." });
        }
    }

    const { count, error: cErr } = await supabase
        .from("seller_bulk_items").select("id", { count: "exact", head: true })
        .eq("seller_id", req.sellerId).eq("status", "pending");
    if (cErr) return res.status(500).json({ success: false, message: cErr.message });
    if ((count || 0) + items.length > MAX_PENDING) {
        return res.status(400).json({ success: false, message: `You can keep at most ${MAX_PENDING} unfinished products. Submit or discard some first.` });
    }

    const rows = items.map((it) => ({
        seller_id: req.sellerId, batch_id: batchId, file_name: String(fileName || "").slice(0, 200) || null,
        row_no: it.rowNo, data: it.data,
    }));
    const { error } = await supabase
        .from("seller_bulk_items").upsert(rows, { onConflict: "batch_id,row_no", ignoreDuplicates: true });
    if (error) return res.status(500).json({ success: false, message: error.message });

    const { data, error: sErr } = await supabase
        .from("seller_bulk_items").select(COLS)
        .eq("seller_id", req.sellerId).eq("batch_id", batchId)
        .in("row_no", items.map((i) => i.rowNo))
        .order("row_no", { ascending: true });
    if (sErr) return res.status(500).json({ success: false, message: sErr.message });
    res.json({ success: true, items: data || [] });
}

// PATCH /api/seller/bulk/items/:id  { data }
export async function updateBulkItem(req, res) {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: "Invalid item." });
    if (!validData(req.body?.data)) return res.status(400).json({ success: false, message: "Invalid or too large." });
    const { data, error } = await supabase
        .from("seller_bulk_items")
        .update({ data: req.body.data, updated_at: new Date().toISOString() })
        .eq("id", id).eq("seller_id", req.sellerId).eq("status", "pending")
        .select("id").maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Item not found or already submitted." });
    res.json({ success: true });
}

// POST /api/seller/bulk/items/:id/mark  { status: 'submitted' | 'skipped', submissionId? }
export async function markBulkItem(req, res) {
    const { id } = req.params;
    const { status, submissionId } = req.body || {};
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: "Invalid item." });
    if (!["submitted", "skipped"].includes(status)) return res.status(400).json({ success: false, message: "Invalid status." });
    const { error } = await supabase
        .from("seller_bulk_items")
        .update({
            status, submission_id: UUID_RE.test(String(submissionId || "")) ? submissionId : null,
            updated_at: new Date().toISOString(),
        })
        .eq("id", id).eq("seller_id", req.sellerId).eq("status", "pending");
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true });
}

// DELETE /api/seller/bulk/items/:id — discard one unfinished product
export async function deleteBulkItem(req, res) {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: "Invalid item." });
    const { error } = await supabase
        .from("seller_bulk_items").delete().eq("id", id).eq("seller_id", req.sellerId).eq("status", "pending");
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true });
}

// DELETE /api/seller/bulk/items — discard every unfinished product
export async function clearBulkItems(req, res) {
    const { error } = await supabase
        .from("seller_bulk_items").delete().eq("seller_id", req.sellerId).eq("status", "pending");
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true });
}