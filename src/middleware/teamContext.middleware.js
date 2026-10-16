// src/middleware/teamContext.middleware.js
import { getTeamContext, describeRequest, logActivity, announceSellerLive, enrichActivity } from "../services/team.service.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Auth + team routes manage identity themselves, so they always see the REAL user.
const KEEP_REAL_USER = ["/api/auth", "/api/team"];

/**
 * Call right after requireAuth has set req.user.
 * - A team member's req.user.id becomes the COMPANY id, so every existing controller works
 *   as the company with no changes. The real person stays in req.actor.
 * - Every successful write by a team member is recorded in the activity log.
 */
export async function applyTeamContext(req, res) {
    if (!req.user?.id || req.actor) return;
    req.actor = { ...req.user };

    const base = req.baseUrl || req.originalUrl || "";
    if (KEEP_REAL_USER.some((p) => base.startsWith(p))) return;

    const ctx = await getTeamContext(req.actor.id);
    req.team = ctx;
    if (ctx.companyId !== req.actor.id) req.user = { ...req.user, id: ctx.companyId };

    if (ctx.teamId && MUTATING.has(req.method) && res) {
        res.once("finish", async () => {
            if (res.statusCode >= 400) return;
            try {
                let d = describeRequest(req);
                if (!d) return;
                d = await enrichActivity(d, req, ctx);
                await logActivity({
                    teamId: ctx.teamId, actorId: ctx.actorId, actorRole: ctx.role,
                    category: d.category, action: d.action, label: d.label,
                    entityType: d.entityType, entityId: d.entityId, meta: d.meta, collapseMs: d.collapseMs,
                    ip: (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim() || null,
                });
            } catch (e) {
                console.error("[team-activity] finish handler failed:", e?.message || e);
            }
        });
    }
}

export const teamContext = (req, res, next) =>
    applyTeamContext(req, res).then(() => next()).catch((e) => {
        console.error("[team-context] failed:", e?.message || e);
        res.status(503).json({ success: false, message: "Couldn't verify your team access. Please try again." });
    });

// Only the team admin (company owner) may pass. Solo users are their own admin.
export async function requireTeamAdmin(req, res, next) {
    try {
        const ctx = req.team || await getTeamContext(req.actor?.id || req.user.id);
        if (ctx.isMember && !ctx.isAdmin) {
            return res.status(403).json({
                success: false, code: "TEAM_ADMIN_ONLY",
                message: "Only your team admin can do this.",
            });
        }
        next();
    } catch (e) {
        console.error("[requireTeamAdmin] failed:", e?.message || e);
        res.status(503).json({ success: false, message: "Couldn't verify your team access. Please try again." });
    }
}

// After a successful go-live, tell the team's members once. The admin sees nothing extra.
export function announceOnSellerLive(req, res, next) {
    const original = res.json.bind(res);
    res.json = (body) => {
        if (body?.success && !body.staged && body.seller?.status === "approved") {
            getTeamContext(req.actor?.id || req.user.id)
                .then((ctx) => announceSellerLive(ctx))
                .catch((e) => console.error("[team] seller announce failed:", e?.message || e));
        }
        return original(body);
    };
    next();
}