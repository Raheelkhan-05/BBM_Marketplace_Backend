// src/middleware/auth.middleware.js
import jwt from "jsonwebtoken";

const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET;

// Single source of truth for turning a raw token string into a user
// object. Both requireAuth (HTTP) and the Socket.IO handshake call this
// — one secret, one payload shape, defined once.
export function verifyAuthToken(token) {
  if (!token || token === "undefined" || token === "null") {
    throw new Error("No token provided");
  }
  if (!AUTH_JWT_SECRET) {
    // fail loud at startup-adjacent time rather than quietly minting
    // sessions nobody can verify
    throw new Error("AUTH_JWT_SECRET is not set");
  }
  const payload = jwt.verify(token, AUTH_JWT_SECRET); // throws if invalid/expired
  return { id: payload.sub }; // normalize once, here — everything downstream just reads .id
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  try {
    const user = verifyAuthToken(token);
    req.user = user;
    req.token = token;
    return next();
  } catch (err) {
    if (err.message === "AUTH_JWT_SECRET is not set") {
      console.error("[requireAuth]", err.message);
      return res.status(500).json({ success: false, message: "Server misconfigured." });
    }
    return res.status(401).json({ success: false, message: "Invalid or expired session." });
  }
}