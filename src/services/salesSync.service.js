// Realtime pings + cleanup for the salesperson feature.
import { supabaseAdmin } from "../config/supabase.js";
import { emitToUser } from "./realtimeBroadcast.js";
import { getTeamContext } from "./team.service.js";

// Content-free ping: every listening screen refetches quietly.
// Goes to the company owner, every team admin, and any salesperson affected.
export async function pingCustomersChanged(companyId, extraUserIds = []) {
    try {
        const ids = new Set([String(companyId), ...extraUserIds.filter(Boolean).map(String)]);
        const ctx = await getTeamContext(companyId);
        if (ctx.teamId) {
            const { data } = await supabaseAdmin.from("team_members").select("user_id").eq("team_id", ctx.teamId).eq("role", "admin");
            (data || []).forEach((m) => ids.add(String(m.user_id)));
        }
        const at = new Date().toISOString();
        ids.forEach((id) => emitToUser(id, "sales:customers_changed", { at }));
    } catch (e) { console.error("[sales] ping failed:", e?.message || e); }
}

// When a salesperson is removed or changes role, their customers go back to "unassigned".
export async function unassignCustomersOf(userId, companyId) {
    const { error } = await supabaseAdmin.from("seller_customers")
        .update({ assigned_to: null, assigned_by: null, assigned_kind: null, assigned_at: null })
        .eq("assigned_to", userId);
    if (error) { console.error("[sales] unassign failed:", error.message); return; }
    await pingCustomersChanged(companyId, [userId]);
}