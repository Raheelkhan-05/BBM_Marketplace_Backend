// src/middleware/auth.middleware.js
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabase.js";

const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET;

export function verifyAuthToken(token) {
  if (!token || token === "undefined" || token === "null") {
    throw new Error("No token provided");
  }
  if (!AUTH_JWT_SECRET) {
    throw new Error("AUTH_JWT_SECRET is not set");
  }
  const payload = jwt.verify(token, AUTH_JWT_SECRET);
  return { id: payload.sub };
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  try {
    const user = verifyAuthToken(token);

    // JWT signature/expiry alone doesn't reflect account status — a
    // soft-deleted profile's token stays valid until it expires. This
    // check ensures a deleted account is locked out of every protected
    // route immediately, not just /auth/me.
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (!profile) {
      return res.status(401).json({ success: false, message: "Invalid or expired session." });
    }

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

// middleware/auth.middleware.js — add alongside requireAuth
export function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  try {
    req.user = verifyAuthToken(token); // reuses your existing verifyAuthToken
  } catch {
    req.user = null; // invalid/missing token — just proceed as a guest, don't 401
  }
  next();
}