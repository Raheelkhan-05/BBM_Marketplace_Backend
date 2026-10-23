// services/adminSellerKeys.js
// A live seller can be identified by the login user id OR by the seller_profiles id (they are not always the same
// value). Listings are stored against one of them, so ownership checks must accept both.
import { supabase } from "../config/supabase.js";

export async function sellerOwnerIds(resolved) {
    const ids = new Set();
    if (resolved?.userId) ids.add(String(resolved.userId));
    if (resolved?.seller?.id) ids.add(String(resolved.seller.id));
    if (resolved?.userId) {
        const { data } = await supabase.from("seller_profiles").select("id").eq("user_id", resolved.userId);
        (data || []).forEach((x) => ids.add(String(x.id)));
    }
    return [...ids];
}