// src/middleware/auth.middleware.js
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabase.js";
import { applyTeamContext } from "./teamContext.middleware.js";

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

  let user;
  try {
    user = verifyAuthToken(token);
  } catch (err) {
    if (err.message === "AUTH_JWT_SECRET is not set") {
      console.error("[requireAuth]", err.message);
      return res.status(500).json({ success: false, message: "Server misconfigured." });
    }
    return res.status(401).json({ success: false, message: "Invalid or expired session." });
  }

  req.user = user;
  req.token = token;

  try {
    // JWT signature/expiry alone doesn't reflect account status — a
    // soft-deleted profile's token stays valid until it expires. This
    // check ensures a deleted account (including a team member who was
    // removed) is locked out of every protected route immediately.
    //
    // TEAM MODE: the team context is resolved in parallel with that check.
    // For a team member it swaps req.user.id to the COMPANY id (the real
    // person stays in req.actor), so every controller below works as the
    // company unchanged.
    const [{ data: profile }] = await Promise.all([
      supabaseAdmin.from("profiles").select("id").eq("id", user.id).is("deleted_at", null).maybeSingle(),
      applyTeamContext(req, res),
    ]);

    if (!profile) {
      return res.status(401).json({ success: false, message: "Invalid or expired session." });
    }
    return next();
  } catch (err) {
    // A database hiccup must NOT sign the user out (the client clears the session on 401).
    console.error("[requireAuth] account check failed:", err?.message || err);
    return res.status(503).json({ success: false, message: "Couldn't verify your session. Please try again." });
  }
}

// middleware/auth.middleware.js — add alongside requireAuth
export async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  try {
    req.user = verifyAuthToken(token); // reuses your existing verifyAuthToken
  } catch {
    req.user = null; // invalid/missing token — just proceed as a guest, don't 401
    return next();
  }

  // A signed-in team member browsing as the company (prices, checkout status, quotes).
  try {
    await applyTeamContext(req, res);
  } catch (err) {
    console.error("[optionalAuth] team context failed:", err?.message || err);
    return res.status(503).json({ success: false, message: "Couldn't verify your session. Please try again." });
  }
  next();
}