import jwt from "jsonwebtoken";

export function optionalAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) { req.user = null; return next(); }
    try {
        const payload = jwt.verify(token, process.env.AUTH_JWT_SECRET);
        req.user = { id: payload.sub };
    } catch {
        req.user = null;
    }
    next();
}