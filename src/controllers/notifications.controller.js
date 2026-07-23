import { supabase } from "../config/supabase.js";

export async function listNotifications(req, res) {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, notifications: data, unreadCount: data.filter((n) => !n.read).length });
}

export async function markNotificationRead(req, res) {
  const { error } = await supabase.from("notifications").update({ read: true }).eq("id", req.params.id).eq("user_id", req.user.id);
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true });
}

export async function markAllRead(req, res) {
  const { error } = await supabase.from("notifications").update({ read: true }).eq("user_id", req.user.id).eq("read", false);
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true });
}