// src/middleware/auth.middleware.js
import jwt from "jsonwebtoken";

const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET;

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: "Missing authorization token." });
  }
  if (!AUTH_JWT_SECRET) {
    console.error("[requireAuth] AUTH_JWT_SECRET is not set.");
    return res.status(500).json({ success: false, message: "Server misconfigured." });
  }

  try {
    const payload = jwt.verify(token, AUTH_JWT_SECRET);
    req.user = { id: payload.sub };
    req.token = token;
    return next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired session." });
  }
}