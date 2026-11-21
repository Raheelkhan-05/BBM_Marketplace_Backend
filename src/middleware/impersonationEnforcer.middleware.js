// src/middleware/impersonationEnforcer.middleware.js
// Mount right after impersonationGuard, before every /api router.
// Normal tokens (and the older act-as-seller tokens) pass straight through with no extra work.
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabase.js";
import { isUuid } from "../services/rfqValidation.js";
import { loadActiveSession, blockedReason, isNoop } from "../services/impersonation.service.js";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

// Cheap pre-check on the UNVERIFIED payload, only to decide whether to do the real work.
function claimsSession(token) {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    try { return typeof JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.ims === "string"; } catch { return false; }
}

const ended = (res) =>
    res.status(401).json({ success: false, code: "IMPERSONATION_ENDED", message: "This admin session has ended." });

export async function impersonationEnforcer(req, res, next) {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return next();
    const token = h.slice(7);
    if (!claimsSession(token)) return next();

    let p;
    try { p = jwt.verify(token, process.env.AUTH_JWT_SECRET); } catch { return ended(res); }
    if (!isUuid(p?.ims) || !isUuid(p?.sub) || !isUuid(p?.act)) return ended(res);

    let session;
    try { session = await loadActiveSession(p.ims); }
    catch (e) {
        console.error("[impersonation] session check failed:", e?.message || e);
        return res.status(503).json({ success: false, message: "Couldn't verify the admin session. Please try again." });
    }
    if (!session || session.target_user_id !== p.sub || session.admin_id !== p.act || new Date(session.expires_at).getTime() <= Date.now()) {
        return ended(res);
    }

    req.impersonation = {
        sessionId: session.id, adminId: session.admin_id, targetId: session.target_user_id,
        reason: session.reason, expiresAt: session.expires_at,
    };

    if (SAFE.has(req.method)) return next();

    const path = String(req.originalUrl || req.url || "").split("?")[0].replace(/\/+$/, "");
    if (isNoop(path)) return res.json({ success: true, skipped: true, impersonation: true });

    // Every write (including blocked attempts) is recorded. Bodies are never stored.
    res.once("finish", () => {
        const rp = req.route?.path;
        const pattern = `${req.baseUrl || ""}${!rp || rp === "/" ? "" : rp}` || path;
        const prm = req.params || {};
        const entity = prm.id || prm.submissionId || prm.buyerId || prm.conversationId || null;
        supabaseAdmin.from("admin_impersonation_log").insert({
            session_id: session.id, method: req.method, route: pattern.slice(0, 200), status: res.statusCode,
            entity_id: entity ? String(entity).slice(0, 80) : null, ip: req.ip || null,
        }).then(({ error }) => { if (error) console.error("[impersonation] log failed:", error.message); },
            (e) => console.error("[impersonation] log failed:", e?.message || e));
    });

    const why = blockedReason(path);
    if (why) return res.status(403).json({ success: false, code: "IMPERSONATION_BLOCKED", message: why });

    next();
}