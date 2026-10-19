import { supabase } from "../config/supabase.js";
import { getTeamContext } from "../services/team.service.js";

// Use AFTER requireAuth. req.user.id is the company id; req.actor.id is the real person.
export async function requireSalesperson(req, res, next) {
    try {
        const actorId = req.actor?.id;
        if (!actorId) return res.status(403).json({ success: false, code: "SALES_ONLY", message: "Sales access only." });
        const ctx = await getTeamContext(actorId);
        if (!ctx.isMember || ctx.role !== "salesperson") {
            return res.status(403).json({ success: false, code: "SALES_ONLY", message: "Sales access only." });
        }
        const { data: seller, error } = await supabase.from("seller_profiles")
            .select("id, status").eq("user_id", ctx.companyId).maybeSingle();
        if (error) throw error;
        req.sales = {
            actorId, companyId: ctx.companyId, teamId: ctx.teamId,
            sellerId: seller?.status === "approved" ? seller.id : null,
        };
        next();
    } catch (e) {
        console.error("[requireSalesperson]", e?.message || e);
        res.status(500).json({ success: false, message: "Couldn't verify your access." });
    }
}