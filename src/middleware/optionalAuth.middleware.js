import { verifyAuthToken } from "./auth.middleware.js";

export function optionalAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    console.log("token", token);

    if (!token) { console.log("optionalAuth: no token"); req.user = null; return next(); }

    try {
        req.user = verifyAuthToken(token);
        console.log("optionalAuth: verified ok, user id:", req.user?.id);
    } catch (err) {
        console.log("optionalAuth: verify failed:", err.message);
        req.user = null;
    }
    next();
}