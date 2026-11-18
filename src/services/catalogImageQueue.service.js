// services/catalogImageQueue.service.js
// Database-backed worker for AI product images. Jobs live in admin_catalog_image_jobs, so they survive page
// closes, deploys and restarts. Claiming uses FOR UPDATE SKIP LOCKED, so two workers can never take the same job.
import { supabase } from "../config/supabase.js";
import { JobError, generateProductImage, storeProductImage } from "./catalogProductImage.service.js";

const JOBS = "admin_catalog_image_jobs";
export const MAX_ATTEMPTS = 3;
const CONCURRENCY = Math.max(1, Number(process.env.CATALOG_IMAGE_CONCURRENCY) || 3);
const STALE_MIN = Number(process.env.CATALOG_IMAGE_STALE_MINUTES) || 6; // one attempt is capped at ~3 min
const POLL_MS = 3000;

let running = 0, ticking = false, timer = null, lastRecover = 0;

const nowIso = () => new Date().toISOString();

async function recover(minutes) {
    const { error } = await supabase.rpc("recover_stale_catalog_image_jobs", { p_stale_minutes: minutes, p_max_attempts: MAX_ATTEMPTS });
    if (error) console.error("[catalogImageQueue] recover:", error.message);
}

function classify(e) {
    if (e instanceof JobError) return { retry: e.retry, msg: e.message, delay: 8000 };
    const status = e?.status;
    const code = e?.code || e?.error?.code || "";
    const text = String(e?.message || "");
    if (status === 401 || status === 403) return { retry: false, msg: "The image service rejected our key. Please contact the developer.", delay: 0 };
    if (code === "moderation_blocked" || /safety system|moderation/i.test(text)) return { retry: false, msg: "The image service declined this product. Please upload a photo instead.", delay: 0 };
    if (status === 429) {
        if (code === "insufficient_quota" || /quota|billing/i.test(text)) return { retry: false, msg: "The image credits are used up. Please contact the developer.", delay: 0 };
        return { retry: true, msg: "The image service is busy. Trying again shortly.", delay: 30000 };
    }
    if (status === 400) return { retry: false, msg: "The image service could not use this product's details.", delay: 0 };
    return { retry: true, msg: "Image generation failed. Trying again.", delay: 8000 };
}

async function failJob(job, e) {
    const c = classify(e);
    console.error(`[catalogImageQueue] job ${job.id} attempt ${job.attempts}:`, e?.message || e);
    const again = c.retry && job.attempts < MAX_ATTEMPTS;
    const patch = again
        ? { status: "queued", error: c.msg, run_after: new Date(Date.now() + c.delay * job.attempts).toISOString(), locked_at: null, updated_at: nowIso() }
        : { status: "failed", error: c.retry ? "Could not create the image after several tries. Please try again." : c.msg, finished_at: nowIso(), locked_at: null, updated_at: nowIso() };
    const { error } = await supabase.from(JOBS).update(patch).eq("id", job.id).eq("status", "running");
    if (error) console.error("[catalogImageQueue] failJob update:", error.message);
}

async function runJob(job) {
    try {
        const { data: draft, error } = await supabase.from("admin_catalog_drafts").select("id, data").eq("id", job.draft_id).maybeSingle();
        if (error) throw error;
        if (!draft) return; // the draft was removed or submitted meanwhile; the job row is gone with it
        const x = draft.data && typeof draft.data === "object" ? draft.data : {};
        const d = {
            n: String(x.n ?? "").trim(), b: String(x.b ?? "").trim(), model: String(x.model ?? "").trim(), grade: String(x.grade ?? "").trim(),
            u: String(x.u ?? ""), ps: x.ps, spec: Array.isArray(x.spec) ? x.spec : [],
            im: Array.isArray(x.im) ? x.im.filter((u) => typeof u === "string" && u.trim()) : [],
        };
        if (d.n.length < 2 || !d.b) throw new JobError("Add the product name and brand first.", false);

        const png = await generateProductImage({ data: d, refUrl: job.use_reference ? d.im[0] : null });
        const url = await storeProductImage(png, job.draft_id);

        const { error: uErr } = await supabase.from(JOBS)
            .update({ status: "done", result_url: url, error: null, finished_at: nowIso(), locked_at: null, updated_at: nowIso() })
            .eq("id", job.id).eq("status", "running"); // a cancelled job must not come back to life
        if (uErr) throw uErr;
    } catch (e) {
        await failJob(job, e);
    }
}

async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        if (Date.now() - lastRecover > 60_000) { lastRecover = Date.now(); await recover(STALE_MIN); }
        const free = CONCURRENCY - running;
        if (free <= 0) return;
        const { data, error } = await supabase.rpc("claim_catalog_image_jobs", { p_limit: free });
        if (error) { console.error("[catalogImageQueue] claim:", error.message); return; }
        for (const job of data || []) {
            running += 1;
            runJob(job)
                .catch((e) => console.error("[catalogImageQueue] runJob:", e?.message || e))
                .finally(() => { running -= 1; kickCatalogImageWorker(); });
        }
    } catch (e) {
        console.error("[catalogImageQueue] tick:", e?.message || e);
    } finally {
        ticking = false;
    }
}

export function kickCatalogImageWorker() { setImmediate(tick); }

// Safe to call many times. Jobs left "running" by a previous process are put back in the queue at boot.
export function startCatalogImageWorker() {
    if (timer) return;
    timer = setInterval(tick, POLL_MS);
    timer.unref?.();
    recover(0).finally(() => { lastRecover = Date.now(); kickCatalogImageWorker(); });
}