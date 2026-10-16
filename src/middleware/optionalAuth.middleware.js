import { verifyAuthToken } from "./auth.middleware.js";
import { applyTeamContext } from "./teamContext.middleware.js";

// Guest-friendly auth. A signed-in team member browses as the COMPANY
// (req.user.id = company id, req.actor = the real person).
export async function optionalAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    try {
        req.user = verifyAuthToken(token);
    } catch {
        req.user = null;
        return next();
    }

    try {
        await applyTeamContext(req, res);
    } catch (err) {
        console.error("[optionalAuth] team context failed:", err?.message || err);
        return res.status(503).json({ success: false, message: "Couldn't verify your session. Please try again." });
    }
    next();
}

export default optionalAuth;