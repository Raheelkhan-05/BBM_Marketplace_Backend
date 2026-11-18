// controllers/adminCatalogImages.controller.js
// Admin-only endpoints for AI product images on unfinished bulk-upload products.
import { supabase } from "../config/supabase.js";
import { startCatalogImageWorker, kickCatalogImageWorker } from "../services/catalogImageQueue.service.js";

const JOBS = "admin_catalog_image_jobs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 300;
const MAX_ACTIVE = 600; // per admin, a guard against runaway spend

const fail = (res, e, label) => {
    console.error(`[adminCatalogImages] ${label}:`, e?.stack || e?.message || e);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again.", detail: e?.message || String(e), step: label });
};
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
function parseIds(raw, max) {
    const ids = [...new Set((Array.isArray(raw) ? raw : []).filter((x) => UUID_RE.test(String(x))))];
    if (!ids.length || ids.length > max) return { error: `Select between 1 and ${max} products at a time.` };
    return { ids };
}

// POST /ai-images/enqueue { ids, useReference }
export async function enqueueImages(req, res) {
    const p = parseIds(req.body?.ids, MAX_IDS);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    try {
        const uid = req.user.id;
        const { count, error: cErr } = await supabase.from(JOBS).select("id", { count: "exact", head: true }).eq("created_by", uid).in("status", ["queued", "running"]);
        if (cErr) throw cErr;
        if ((count || 0) + p.ids.length > MAX_ACTIVE) {
            return res.status(400).json({ success: false, message: "Too many images are already being made. Wait for some to finish, then try again." });
        }

        // only products that have a name and a brand can be generated
        const eligible = [];
        for (const c of chunks(p.ids, 50)) {
            const { data, error } = await supabase.from("admin_catalog_drafts").select("id, data").eq("created_by", uid).in("id", c);
            if (error) throw error;
            (data || []).forEach((r) => {
                const d = r.data || {};
                if (String(d.n || "").trim().length >= 2 && String(d.b || "").trim()) eligible.push(r.id);
            });
        }
        if (!eligible.length) return res.json({ success: true, queued: 0, skipped: p.ids.length });

        const { data: queued, error } = await supabase.rpc("enqueue_catalog_image_jobs", {
            p_admin: uid, p_ids: eligible, p_use_reference: req.body?.useReference !== false,
        });
        if (error) throw error;

        startCatalogImageWorker();
        kickCatalogImageWorker();
        const n = (queued || []).length;
        res.json({ success: true, queued: n, skipped: p.ids.length - n });
    } catch (e) { return fail(res, e, "enqueue images"); }
}

// GET /ai-images/jobs  -> everything the screen needs: waiting, running, failed, and finished-but-not-yet-attached
export async function listJobs(req, res) {
    try {
        startCatalogImageWorker(); // makes sure the worker is alive (idempotent)
        const { data, error } = await supabase.from(JOBS)
            .select("draft_id, status, error, result_url, attempts, use_reference, started_at, created_at")
            .eq("created_by", req.user.id)
            .or("status.in.(queued,running,failed),and(status.eq.done,applied.eq.false)")
            .order("created_at", { ascending: true })
            .limit(2000);
        if (error) throw error;
        const now = Date.now();
        const jobs = (data || []).map((j) => ({
            ...j,
            elapsed: Math.max(0, Math.round((now - new Date(j.started_at || j.created_at).getTime()) / 1000)), // server clock, so no skew
        }));
        if (jobs.some((j) => j.status === "queued")) kickCatalogImageWorker();
        res.json({ success: true, jobs });
    } catch (e) { return fail(res, e, "list image jobs"); }
}

// POST /ai-images/ack { ids }  -> the screen attached these images to the drafts
export async function ackImages(req, res) {
    const p = parseIds(req.body?.ids, MAX_IDS);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    try {
        for (const c of chunks(p.ids, 50)) {
            const { error } = await supabase.from(JOBS).update({ applied: true, updated_at: new Date().toISOString() })
                .eq("created_by", req.user.id).eq("status", "done").in("draft_id", c);
            if (error) throw error;
        }
        res.json({ success: true });
    } catch (e) { return fail(res, e, "ack images"); }
}

// POST /ai-images/cancel { ids | all, failed, active }
//   active (default true): stop queued / running jobs     failed: also clear failed jobs from the list
export async function cancelImages(req, res) {
    const all = req.body?.all === true;
    const stopActive = req.body?.active !== false;
    const dropFailed = req.body?.failed === true;
    let ids = null;
    if (!all) {
        const p = parseIds(req.body?.ids, MAX_IDS);
        if (p.error) return res.status(400).json({ success: false, message: p.error });
        ids = p.ids;
    }
    try {
        const uid = req.user.id;
        for (const c of ids ? chunks(ids, 50) : [null]) {
            if (stopActive) {
                let q = supabase.from(JOBS).update({ status: "cancelled", locked_at: null, updated_at: new Date().toISOString() })
                    .eq("created_by", uid).in("status", ["queued", "running"]);
                if (c) q = q.in("draft_id", c);
                const { error } = await q;
                if (error) throw error;
            }
            if (dropFailed) {
                let q = supabase.from(JOBS).delete().eq("created_by", uid).eq("status", "failed");
                if (c) q = q.in("draft_id", c);
                const { error } = await q;
                if (error) throw error;
            }
        }
        res.json({ success: true });
    } catch (e) { return fail(res, e, "cancel images"); }
}