import { supabase } from "../config/supabase.js";

// Chain after requireAuth — assumes req.user.id is already set
export async function requireAdmin(req, res, next) {
  const { data, error } = await supabase.from("profiles").select("role").eq("id", req.user.id).maybeSingle();
  if (error || data?.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }
  next();
}