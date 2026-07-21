// src/middleware/auth.middleware.js
import { createRemoteJWKSet, jwtVerify } from "jose";
import jwt from "jsonwebtoken";

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
);

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: "Missing authorization token." });
  }

  // Try real Supabase session (ES256, verified against Supabase's JWKS)
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `${process.env.SUPABASE_URL}/auth/v1`,
      audience: "authenticated",
    });
    req.user = { id: payload.sub, phone: payload.phone || null };
    req.token = token;
    return next();
  } catch {
    // fall through to dev bypass check below
  }

  // Dev-only phone bypass token (see phoneDevAuth.controller.js)
  if (process.env.AUTH_DEV_BYPASS_OTP === "true") {
    try {
      const payload = jwt.verify(token, process.env.DEV_AUTH_JWT_SECRET);
      if (payload.auth_mode === "dev_bypass") {
        req.user = { id: payload.sub, phone: payload.phone };
        req.token = token;
        return next();
      }
    } catch {
      // not a valid dev token either
    }
  }

  return res.status(401).json({ success: false, message: "Invalid or expired session." });
}