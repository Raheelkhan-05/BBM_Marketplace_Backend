// controllers/aiBanners.controller.js
import { supabaseAdmin } from "../config/supabase.js";
import { aiConfigured, aiModelName, loadPending, enqueueJobs } from "../services/aiBanners.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = ["group", "category", "subcategory"];
const MAX_PER_REQUEST = 300;

// GET /api/admin/ai-banners
export async function aiOverview(req, res) {
    try {
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const [pending, jobs, recent] = await Promise.all([
            loadPending(),
            supabaseAdmin.from("ai_banner_jobs").select("status").gte("created_at", since).limit(5000),
            supabaseAdmin.from("ai_banner_jobs").select("id, entity_type, entity_id, entity_name, status, error, note, publish, force, created_at, finished_at")
                .order("created_at", { ascending: false }).limit(60),
        ]);
        if (jobs.error || recent.error) throw new Error((jobs.error || recent.error).message);

        const stats = { queued: 0, running: 0, done: 0, failed: 0 };
        for (const j of jobs.data || []) if (j.status in stats) stats[j.status]++;

        const rows = recent.data || [];
        const gIds = rows.filter((j) => j.entity_type === "group" && j.status === "done").map((j) => j.entity_id);
        const eIds = rows.filter((j) => j.entity_type !== "group" && j.status === "done").map((j) => j.entity_id);
        const [g, e] = await Promise.all([
            gIds.length ? supabaseAdmin.from("group_banners").select("group_id, image_url, ai_generated, is_active").in("group_id", gIds) : { data: [] },
            eIds.length ? supabaseAdmin.from("catalog_entity_banners").select("entity_id, shape, image_url, ai_generated, is_active").in("entity_id", eIds) : { data: [] },
        ]);
        const gMap = new Map((g.data || []).map((r) => [r.group_id, r]));
        const eMap = new Map();
        for (const r of e.data || []) if (!eMap.has(r.entity_id) || r.shape === "wide") eMap.set(r.entity_id, r);

        const recentOut = rows.map((j) => {
            const hit = j.entity_type === "group" ? gMap.get(j.entity_id) : eMap.get(j.entity_id);
            return { ...j, preview: hit?.image_url || null, ai_generated: hit?.ai_generated ?? null, is_active: hit?.is_active ?? null };
        });
        return res.json({ success: true, configured: aiConfigured(), model: aiModelName(), pending, stats, recent: recentOut });
    } catch (err) {
        console.error("[ai-banners] overview failed:", err?.message);
        return res.status(500).json({ success: false, message: "Couldn't load the AI banner studio." });
    }
}

// POST /api/admin/ai-banners/jobs   body: { scope: "group"|"category"|"subcategory"|"all" }  or  { items: [{type,id,name?,force?}] },  publish?
export async function aiEnqueue(req, res) {
    if (!aiConfigured()) return res.status(400).json({ success: false, message: "OPENAI_API_KEY is not set on the server." });
    try {
        const publish = req.body?.publish === true;
        let items = [];
        if (Array.isArray(req.body?.items)) {
            items = req.body.items
                .filter((i) => TYPES.includes(i?.type) && UUID_RE.test(String(i?.id)))
                .map((i) => ({ type: i.type, id: i.id, name: String(i.name || "").slice(0, 200), force: i.force === true }));
        } else {
            const scope = req.body?.scope;
            if (![...TYPES, "all"].includes(scope)) return res.status(400).json({ success: false, message: "Invalid scope." });
            const pending = await loadPending();
            for (const t of TYPES) {
                if (scope !== "all" && scope !== t) continue;
                items.push(...pending[t].filter((p) => !p.state).map((p) => ({ type: t, id: p.id, name: p.name, force: false })));
            }
        }
        items = items.slice(0, MAX_PER_REQUEST);
        if (!items.length) return res.json({ success: true, queued: 0 });
        const out = await enqueueJobs(items, { publish, userId: req.user?.id });
        return res.json({ success: true, ...out });
    } catch (err) {
        console.error("[ai-banners] enqueue failed:", err?.message);
        return res.status(500).json({ success: false, message: "Couldn't start the generation." });
    }
}

// POST /api/admin/ai-banners/cancel   (stops everything still waiting; a job already running finishes)
export async function aiCancel(req, res) {
    const { data, error } = await supabaseAdmin.from("ai_banner_jobs")
        .update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("status", "queued").select("id");
    if (error) return res.status(500).json({ success: false, message: "Couldn't cancel." });
    return res.json({ success: true, cancelled: data?.length || 0 });
}