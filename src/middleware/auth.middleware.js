import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabase.js";
import { applyTeamContext } from "./teamContext.middleware.js";
import { getTeamContext } from "../services/team.service.js";

const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET;

// A salesperson may only reach these. Everything else is refused, whatever the UI does.
// const SALES_ALLOWED = [/^\/api\/auth\/me$/, /^\/api\/sales(\/|$)/];
const SALES_ALLOWED = [/^\/api\/auth\/me$/, /^\/api\/sales(\/|$)/, /^\/api\/geo(\/|$)/];
const pathOf = (req) => String(req.originalUrl || req.url || "").split("?")[0].replace(/\/+$/, "");
const salesAllowed = (req) => SALES_ALLOWED.some((re) => re.test(pathOf(req)));

async function isSalesperson(actorId) {
  const ctx = await getTeamContext(actorId); // cached (15s), already warmed by applyTeamContext
  return ctx.isMember && ctx.role === "salesperson";
}

export function verifyAuthToken(token) {
  if (!token || token === "undefined" || token === "null") throw new Error("No token provided");
  if (!AUTH_JWT_SECRET) throw new Error("AUTH_JWT_SECRET is not set");
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

  const actorId = user.id; // captured BEFORE applyTeamContext swaps req.user.id to the company id
  req.user = user;
  req.token = token;

  try {
    const [{ data: profile }] = await Promise.all([
      supabaseAdmin.from("profiles").select("id").eq("id", actorId).is("deleted_at", null).maybeSingle(),
      applyTeamContext(req, res),
    ]);
    if (!profile) return res.status(401).json({ success: false, message: "Invalid or expired session." });
    if (res.headersSent) return;

    if (!salesAllowed(req) && (await isSalesperson(actorId))) {
      return res.status(403).json({ success: false, code: "SALES_ONLY", message: "Your account can only use the sales workspace." });
    }
    return next();
  } catch (err) {
    console.error("[requireAuth] account check failed:", err?.message || err);
    return res.status(503).json({ success: false, message: "Couldn't verify your session. Please try again." });
  }
}

export async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  let actorId;
  try {
    req.user = verifyAuthToken(token);
    actorId = req.user.id;
  } catch {
    req.user = null;
    return next();
  }

  try {
    await applyTeamContext(req, res);
    // A salesperson never browses the marketplace as the company: treat them as a guest here.
    if (await isSalesperson(actorId)) { req.user = null; req.actor = undefined; }
  } catch (err) {
    console.error("[optionalAuth] team context failed:", err?.message || err);
    return res.status(503).json({ success: false, message: "Couldn't verify your session. Please try again." });
  }
  next();
}