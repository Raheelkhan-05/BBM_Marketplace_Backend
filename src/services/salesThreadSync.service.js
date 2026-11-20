// services/salesThreadSync.service.js
// After a thread changes: invalidate cached reads and ping live pages for EVERYONE on the thread.
import { supabase } from "../config/supabase.js";
import { cached, bumpVer } from "./cache.service.js";
import { ping } from "./salesThreads.service.js";

const creatorOf = (enquiryId) =>
    cached(`stcr:${enquiryId}`, 3600, async () => {
        const { data, error } = await supabase.from("rfq_enquiries").select("created_by_actor_id").eq("id", enquiryId).maybeSingle();
        if (error) throw error;
        return data?.created_by_actor_id ? String(data.created_by_actor_id) : "";
    });

export async function syncThreadViews({ enquiryId, creatorId, userIds = [] }) {
    try {
        const [creator, parts] = await Promise.all([
            creatorId ? String(creatorId) : creatorOf(enquiryId),
            supabase.from("sales_thread_participants").select("user_id").eq("enquiry_id", enquiryId),
        ]);
        const people = [...new Set(
            [creator, ...userIds, ...(parts.data || []).map((p) => p.user_id)].filter(Boolean).map(String),
        )];
        if (!people.length) return [];
        // the first call also bumps the thread's own version stamp
        await Promise.all(people.map((id, i) => bumpVer(`sa:${id}`, i === 0 ? `st:${enquiryId}` : null)));
        ping(people, { enquiryId });
        return people;
    } catch (e) {
        console.error("[sales thread sync] failed:", e?.message || e);
        return [];
    }
}