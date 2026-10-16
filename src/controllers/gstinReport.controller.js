import { supabaseAdmin } from "../config/supabase.js";
import { getIO } from "../socket/io.js";
import { validateGSTIN } from "../services/gst.service.js";
import { maskContact } from "../services/team.service.js";
import { sendGstinReportUpdateEmail } from "../services/mail.service.js";
import { sendOrderUpdateWhatsApp } from "../services/whatsapp.service.js";

// Which contacts of this profile are verified (the only ones we may message).
function verifiedContacts(p) {
    const out = [];
    if (p?.email && p.email_verified) out.push({ channel: "email", value: p.email });
    if (p?.phone && p.phone_verified) out.push({ channel: "phone", value: p.phone });
    return out;
}

/* ---------------- user: POST /api/auth/gstin-report { gstin, note? } ---------------- */
export async function reportGstinConflict(req, res) {
    try {
        const check = validateGSTIN(req.body?.gstin);
        if (!check.valid) return res.status(400).json({ success: false, message: check.reason });
        const note = String(req.body?.note || "").trim().slice(0, 500);

        // Only accept a report when the conflict is real.
        const { data: owner } = await supabaseAdmin.from("business_profiles")
            .select("user_id, profiles!inner(deleted_at)").eq("gstin", check.gstin)
            .is("profiles.deleted_at", null).maybeSingle();
        if (!owner || owner.user_id === req.user.id) {
            return res.status(400).json({ success: false, message: "This GSTIN isn't registered to another account." });
        }

        const { data: me } = await supabaseAdmin.from("profiles")
            .select("name, phone, phone_verified, email, email_verified").eq("id", req.user.id).maybeSingle();
        const contacts = verifiedContacts(me);
        const reachedAt = contacts.map((c) => maskContact(c.channel, c.value));

        const { data: row, error } = await supabaseAdmin.from("gstin_reports")
            .insert({ user_id: req.user.id, gstin: check.gstin, existing_user_id: owner.user_id, note: note || null })
            .select("id, created_at").single();
        if (error) {
            if (error.code === "23505") return res.json({ success: true, alreadyReported: true, reachedAt });
            throw error;
        }

        try {
            getIO().to("admins").emit("gstin_report:new", { id: row.id, userId: req.user.id, gstin: check.gstin, createdAt: row.created_at });
        } catch { /* admin page also loads on open */ }

        res.json({ success: true, reachedAt });
    } catch (e) {
        console.error("[gstin-report] create failed:", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't send your report. Please try again." });
    }
}

/* ---------------- admin: GET /api/admin/gstin-reports?status=pending ---------------- */
export async function adminListGstinReports(req, res) {
    const status = req.query.status === "resolved" ? "resolved" : "pending";
    const { data, error } = await supabaseAdmin.from("gstin_reports").select("*")
        .eq("status", status).order("created_at", { ascending: status !== "resolved" }).limit(200);
    if (error) return res.status(500).json({ success: false, message: "Couldn't load reports." });

    const ids = [...new Set((data || []).flatMap((r) => [r.user_id, r.existing_user_id]).filter(Boolean))];
    const [{ data: profs }, { data: biz }] = ids.length ? await Promise.all([
        supabaseAdmin.from("profiles").select("id, name, phone, phone_verified, email, email_verified").in("id", ids),
        supabaseAdmin.from("business_profiles").select("user_id, display_name, trade_name, legal_name").in("user_id", ids),
    ]) : [{ data: [] }, { data: [] }];
    const pBy = new Map((profs || []).map((p) => [p.id, p]));
    const bBy = new Map((biz || []).map((b) => [b.user_id, b.display_name || b.trade_name || b.legal_name || null]));

    const shape = (id) => id ? { ...(pBy.get(id) || { id }), company: bBy.get(id) || null } : null;
    res.json({
        success: true,
        reports: (data || []).map((r) => ({ ...r, reporter: shape(r.user_id), existing: shape(r.existing_user_id) })),
    });
}

/* ------- admin: POST /api/admin/gstin-reports/:id/resolve { message } ------- */
export async function adminResolveGstinReport(req, res) {
    const message = String(req.body?.message || "").trim().slice(0, 1000);
    if (message.length < 3) return res.status(400).json({ success: false, message: "Write the message the user will receive." });

    const { data: r, error } = await supabaseAdmin.from("gstin_reports")
        .update({ status: "resolved", resolution_notes: message, resolved_by: req.user.id, resolved_at: new Date().toISOString() })
        .eq("id", req.params.id).eq("status", "pending").select("id, user_id, gstin").maybeSingle();
    if (error) return res.status(500).json({ success: false, message: "Couldn't resolve this report." });
    if (!r) return res.status(409).json({ success: false, message: "This report was already resolved." });

    // Tell the user on every verified contact. A failure on one doesn't block the other.
    const { data: p } = await supabaseAdmin.from("profiles")
        .select("name, phone, phone_verified, email, email_verified").eq("id", r.user_id).maybeSingle();
    const sent = [];
    for (const c of verifiedContacts(p)) {
        try {
            if (c.channel === "email") {
                await sendGstinReportUpdateEmail({ to: c.value, name: p?.name, gstin: r.gstin, message });
            } else {
                await sendOrderUpdateWhatsApp({
                    to: c.value, name: p?.name || "there",
                    headline: `Update on your GSTIN report (${r.gstin})`,
                    detail: message,
                    footer: "You're receiving this because you reported a GSTIN issue on BBM.",
                });
            }
            sent.push(c.channel);
        } catch (e) { console.error("[gstin-report] notify failed:", c.channel, e?.message || e); }
    }
    if (sent.length) await supabaseAdmin.from("gstin_reports").update({ notified_via: sent }).eq("id", r.id);

    res.json({ success: true, notifiedVia: sent });
}