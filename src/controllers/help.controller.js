import { supabaseAdmin } from "../config/supabase.js";
import { getIO } from "../socket/io.js";

const COOLDOWN_MS = 2 * 60 * 1000;

export async function getMyHelpStatus(req, res) {
    const { data, error } = await supabaseAdmin
        .from("help_requests")
        .select("id, status, triggered_at, acknowledged_at, resolved_at, resolution_notes, user_notified_at")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false })
        .limit(1).maybeSingle();

    if (error) return res.status(500).json({ success: false, message: "Couldn't load status." });

    // A resolved request the user hasn't been shown yet (e.g. resolved while
    // they were offline and the socket push was missed) is still surfaced
    // here exactly once — the client marks it seen via /seen below.
    const pendingNotification = data?.status === "resolved" && !data.user_notified_at
        ? { id: data.id, resolvedAt: data.resolved_at, notes: data.resolution_notes }
        : null;

    return res.json({
        success: true,
        active: !!data && data.status !== "resolved",
        stage: data?.status !== "resolved" ? (data?.status || null) : null,
        pendingNotification,
    });
}

export async function markResolutionSeen(req, res) {
    await supabaseAdmin.from("help_requests")
        .update({ user_notified_at: new Date().toISOString() })
        .eq("id", req.params.id).eq("user_id", req.user.id);
    return res.json({ success: true });
}

export async function createHelpRequest(req, res) {
    const userId = req.user.id;

    const { data: existingActive } = await supabaseAdmin
        .from("help_requests").select("id, status, triggered_at")
        .eq("user_id", userId).in("status", ["pending", "open"]).maybeSingle();

    if (existingActive) {
        return res.status(409).json({
            success: false, code: "ALREADY_ACTIVE", stage: existingActive.status,
            message: "You already have an active request — our team has been notified.",
        });
    }

    const { data: lastResolved } = await supabaseAdmin
        .from("help_requests").select("resolved_at")
        .eq("user_id", userId).eq("status", "resolved")
        .order("resolved_at", { ascending: false }).limit(1).maybeSingle();

    if (lastResolved?.resolved_at) {
        const since = Date.now() - new Date(lastResolved.resolved_at).getTime();
        if (since < COOLDOWN_MS) {
            return res.status(429).json({
                success: false, code: "COOLDOWN",
                message: `Please wait ${Math.ceil((COOLDOWN_MS - since) / 1000)}s before raising another request.`,
            });
        }
    }

    const { data: inserted, error } = await supabaseAdmin
        .from("help_requests").insert({ user_id: userId, status: "pending" })
        .select("id, status, triggered_at").single();

    if (error) {
        if (error.code === "23505") {
            return res.status(409).json({ success: false, code: "ALREADY_ACTIVE", message: "You already have an active request." });
        }
        console.error("[help] createHelpRequest failed:", error.message);
        return res.status(500).json({ success: false, message: "Couldn't submit your request. Try again." });
    }

    const { data: profile } = await supabaseAdmin
        .from("profiles").select("name, phone, email").eq("id", userId).single();
    const { data: biz } = await supabaseAdmin
        .from("business_profiles").select("display_name, trade_name").eq("user_id", userId).maybeSingle();

    getIO()?.to("admins").emit("help_request:new", {
        id: inserted.id, userId,
        name: profile?.name || null, phone: profile?.phone || null, email: profile?.email || null,
        companyName: biz?.display_name || biz?.trade_name || null,
        triggeredAt: inserted.triggered_at,
    });

    return res.json({ success: true, request: inserted });
}

// Pending -> Open. Now requires a note on what was discussed, same
// validation bar as resolve — an acknowledgment with no context is just
// as useless later as a resolution with no context.
export async function adminAcknowledgeHelpRequest(req, res) {
    const { notes } = req.body || {};
    if (!notes || notes.trim().length < 3) {
        return res.status(400).json({ success: false, message: "Add a short note on what was discussed before acknowledging." });
    }

    const { data: updated, error } = await supabaseAdmin
        .from("help_requests")
        .update({
            status: "open",
            acknowledged_at: new Date().toISOString(),
            acknowledged_by: req.user.id,
            acknowledgment_notes: notes.trim(),
        })
        .eq("id", req.params.id).eq("status", "pending")
        .select("id, user_id, status").maybeSingle();

    if (error) return res.status(500).json({ success: false, message: "Couldn't acknowledge." });
    if (!updated) return res.status(409).json({ success: false, message: "Already acknowledged or resolved." });

    getIO()?.to(`user:${updated.user_id}`).emit("help_request:acknowledged", { id: updated.id });
    return res.json({ success: true, request: updated });
}

// Pending OR Open -> Resolved. Works directly from "pending" too — this is
// the one-click path for "user raised it by mistake", no forced detour
// through Open first.
export async function adminResolveHelpRequest(req, res) {
    const { notes } = req.body || {};
    if (!notes || notes.trim().length < 3) {
        return res.status(400).json({ success: false, message: "Add a short note on what was discussed/resolved." });
    }

    const { data: updated, error } = await supabaseAdmin
        .from("help_requests")
        .update({ status: "resolved", resolved_at: new Date().toISOString(), resolved_by: req.user.id, resolution_notes: notes.trim() })
        .eq("id", req.params.id).in("status", ["pending", "open"])
        .select("id, user_id, status, resolved_at, resolution_notes").maybeSingle();

    if (error) return res.status(500).json({ success: false, message: "Couldn't resolve this request." });
    if (!updated) return res.status(409).json({ success: false, message: "This request was already resolved." });

    getIO()?.to(`user:${updated.user_id}`).emit("help_request:resolved", {
        id: updated.id, resolvedAt: updated.resolved_at, notes: updated.resolution_notes,
    });
    return res.json({ success: true, request: updated });
}

export async function adminListHelpRequests(req, res) {
    const status = ["pending", "open", "resolved"].includes(req.query.status) ? req.query.status : "pending";
    const { data, error } = await supabaseAdmin
        .from("help_requests")
        .select("id, user_id, status, triggered_at, acknowledged_at, acknowledgment_notes, resolved_at, resolution_notes, profiles!help_requests_user_id_fkey(name, phone, email)")
        .eq("status", status)
        .order(status === "resolved" ? "resolved_at" : "triggered_at", { ascending: status !== "resolved" })
        .limit(200);

    if (error) return res.status(500).json({ success: false, message: "Couldn't load requests." });

    // business_profiles has no FK to help_requests, so it's a separate
    // batched lookup rather than a single embedded select.
    const userIds = [...new Set((data || []).map((r) => r.user_id))];
    let companyByUser = {};
    if (userIds.length) {
        const { data: bizRows } = await supabaseAdmin
            .from("business_profiles").select("user_id, display_name, trade_name").in("user_id", userIds);
        companyByUser = Object.fromEntries((bizRows || []).map((b) => [b.user_id, b.display_name || b.trade_name || null]));
    }

    const requests = (data || []).map((r) => ({ ...r, company_name: companyByUser[r.user_id] || null }));
    return res.json({ success: true, requests });
}