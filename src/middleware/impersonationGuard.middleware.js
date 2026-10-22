// Restricts admin "act as seller" tokens and marks their requests as admin-approved.
// Normal user/admin tokens are never touched: they pass straight through.
// Mount once, after express.json(), before the /api routers:  app.use("/api", impersonationGuard);
import jwt from "jsonwebtoken";

// Reads allowed for an impersonated session (everything under /api/seller EXCEPT the blocked list below).
const READ_OK = [
    /^\/api\/seller(\/|$)/, /^\/api\/geo(\/|$)/, /^\/api\/listing-policy-options(\/|$)/, /^\/api\/auth\/me$/,
];
const READ_BLOCKED = [/^\/api\/seller\/(orders|wallet|customers|bank-details)(\/|$)/];

// Writes allowed: listing management, custom pricing and file upload only.
const WRITE_OK = [
    /^\/api\/seller\/catalog(\/|$)/, /^\/api\/seller\/custom-pricing(\/|$)/, /^\/api\/seller\/upload$/,
];

// Cheap pre-check: reads the (unverified) payload only to decide whether the expensive signature
// check is needed at all. The claim is never trusted until jwt.verify succeeds below.
function claimsImpersonation(token) {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    try { return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.imp === true; } catch { return false; }
}

export function impersonationGuard(req, res, next) {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return next();
    const token = h.slice(7);
    if (!claimsImpersonation(token)) return next(); // normal token: zero extra work

    let p;
    try { p = jwt.verify(token, process.env.AUTH_JWT_SECRET); }
    catch { return res.status(401).json({ success: false, message: "Session expired. Please load the seller again." }); }
    if (p?.imp !== true) return next();

    const path = req.originalUrl.split("?")[0];
    const read = ["GET", "HEAD", "OPTIONS"].includes(req.method);
    const ok = read
        ? READ_OK.some((r) => r.test(path)) && !READ_BLOCKED.some((r) => r.test(path))
        : WRITE_OK.some((r) => r.test(path));
    if (!ok) {
        return res.status(403).json({ success: false, code: "IMPERSONATION_RESTRICTED", message: "This admin session can only manage product listings." });
    }

    req.adminForceApprove = true;   // set server-side only, never from the client body
    req.impersonatedBy = p.act;
    if (!read) console.info(`[admin-as-seller] admin=${p.act} seller=${p.sub} ${req.method} ${path}`);
    next();
}