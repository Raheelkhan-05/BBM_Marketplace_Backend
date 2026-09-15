// controllers/transportLibrary.controller.js
//
// The Transport Library: route-level transport options a buyer can pick
// pre-purchase (no seller approval needed once approved), or propose new
// ones for (which DO need seller approval, and are deduped against what
// that seller — or in the suggestions endpoint, ANY seller — already has
// on that exact route).
import { supabase } from "../config/supabase.js";
import { notifyUser } from "../services/realtimeBroadcast.js";
import { ROUTE_TRANSPORT_FIELDS, routeOptionSummary } from "../../shared/routeTransportFields.js";

function normalizeLoc(s) {
    return (s || "").trim();
}

// Collapses internal whitespace runs down to a single space, trims edges,
// and lowercases. Used ONLY for comparison keys — never for what gets
// stored — so "Patel transport", "Patel transport ", and "Patel  Transport"
// are all recognised as the same company when matching against a removed
// row, instead of silently missing and inserting a duplicate.
function normForCompare(s) {
    return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function identityValue(mode, fields) {
    return fields?.transport_company || fields?.train_number || fields?.airline_name || "";
}

// Same as identityValue, but normalized for equality checks.
function identityKey(mode, fields) {
    return normForCompare(identityValue(mode, fields));
}

// Trims every string field value before it's persisted, so whatever gets
// written to the DB is already clean — this keeps future comparisons
// (and what buyers/sellers see rendered) free of stray whitespace, rather
// than relying on every reader to normalize on the way out.
function normalizeFieldValues(fields) {
    if (!fields || typeof fields !== "object") return fields || {};
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
        out[k] = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : v;
    }
    return out;
}

function validateFields(mode, fields) {
    const schema = ROUTE_TRANSPORT_FIELDS[mode];
    if (!schema) return "Unrecognised transport mode.";
    for (const f of schema) {
        if (f.required && !String(fields?.[f.key] || "").trim()) {
            return `Please fill in: ${f.label}.`;
        }
    }
    return null;
}

// GET /api/transport-library/route-options
// ?sellerId=&originState=&originCity=&destState=&destCity=
// Approved-only — what a buyer picks from without needing seller approval.
export async function getRouteOptionsForSeller(req, res) {
    const { sellerId, originState, originCity, destState, destCity } = req.query;
    if (!sellerId || !originState || !originCity || !destState || !destCity) {
        return res.status(400).json({ success: false, message: "Missing route parameters." });
    }
    const { data, error } = await supabase
        .from("transport_route_options")
        .select("*")
        .eq("seller_id", sellerId)
        .eq("status", "approved")
        .ilike("origin_state", normalizeLoc(originState))
        .ilike("origin_city", normalizeLoc(originCity))
        .ilike("dest_state", normalizeLoc(destState))
        .ilike("dest_city", normalizeLoc(destCity));
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, options: data || [] });
}

// GET /api/transport-library/route-suggestions
// ?originState=&originCity=&destState=&destCity=
// Cross-seller: "companies already used by OTHER sellers on this exact
// route" — shown while proposing, so people reuse a known company instead
// of typing a near-duplicate. Deduped by mode + company identity.
export async function getRouteSuggestions(req, res) {
    const { originState, originCity, destState, destCity } = req.query;
    if (!originState || !originCity || !destState || !destCity) {
        return res.status(400).json({ success: false, message: "Missing route parameters." });
    }
    const { data, error } = await supabase
        .from("transport_route_options")
        .select("mode, fields")
        .eq("status", "approved")
        .ilike("origin_state", normalizeLoc(originState))
        .ilike("origin_city", normalizeLoc(originCity))
        .ilike("dest_state", normalizeLoc(destState))
        .ilike("dest_city", normalizeLoc(destCity));
    if (error) return res.status(500).json({ success: false, message: error.message });

    const seen = new Set();
    const suggestions = [];
    for (const row of data || []) {
        const key = `${row.mode}::${identityKey(row.mode, row.fields)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push({ mode: row.mode, fields: row.fields });
    }
    res.json({ success: true, suggestions });
}

// POST /api/transport-library/propose
// Buyer proposes a new route option to a seller. Reuses an existing
// active (proposed/approved) row for the same seller+route+mode+company
// instead of creating a duplicate.
export async function proposeRouteOption(req, res) {
    const buyerId = req.user.id;
    const { sellerId, originState, originCity, destState, destCity, mode, fields, note } = req.body || {};

    if (!sellerId || !originState || !originCity || !destState || !destCity || !mode) {
        return res.status(400).json({ success: false, message: "Missing required fields." });
    }
    const cleanFields = normalizeFieldValues(fields || {});
    const fieldError = validateFields(mode, cleanFields);
    if (fieldError) return res.status(400).json({ success: false, message: fieldError });

    const identity = identityKey(mode, cleanFields);

    const { data: existing } = await supabase
        .from("transport_route_options")
        .select("*")
        .eq("seller_id", sellerId)
        .eq("mode", mode)
        .ilike("origin_state", normalizeLoc(originState))
        .ilike("origin_city", normalizeLoc(originCity))
        .ilike("dest_state", normalizeLoc(destState))
        .ilike("dest_city", normalizeLoc(destCity))
        .in("status", ["proposed", "approved"])
        .maybeSingle();

    if (existing && identityKey(existing.mode, existing.fields) === identity) {
        return res.json({ success: true, reused: true, option: existing });
    }

    // If this exact seller+route+mode+company was previously removed by
    // the seller, a fresh INSERT would collide with that row under the
    // unique constraint. Reactivate that same row instead — but back to
    // "proposed", not "approved", since a buyer re-requesting it still
    // needs the seller to sign off again, same as any new proposal.
    //
    // Matched on trimmed/whitespace-collapsed/case-insensitive identity
    // (identityKey) rather than a raw string compare — a stray trailing
    // space or different casing in how the company name was typed this
    // time around must not stop this from finding the old row, or a
    // duplicate silently gets created instead of a reactivation.
    const { data: removedCandidates } = await supabase
        .from("transport_route_options")
        .select("*")
        .eq("seller_id", sellerId)
        .eq("mode", mode)
        .eq("status", "removed")
        .ilike("origin_state", normalizeLoc(originState))
        .ilike("origin_city", normalizeLoc(originCity))
        .ilike("dest_state", normalizeLoc(destState))
        .ilike("dest_city", normalizeLoc(destCity));

    const removedMatch = (removedCandidates || []).find(
        (row) => identityKey(row.mode, row.fields) === identity
    );

    if (removedMatch) {
        const { data: reactivated, error: reactivateError } = await supabase
            .from("transport_route_options")
            .update({
                status: "proposed",
                fields: cleanFields,
                removed_at: null,
                approved_at: null,
                proposed_by_buyer_id: buyerId,
                proposal_note: note?.trim() || null,
            })
            .eq("id", removedMatch.id)
            .select()
            .single();
        if (reactivateError) return res.status(500).json({ success: false, message: reactivateError.message });

        const { data: sellerProfileForReactivate } = await supabase.from("seller_profiles").select("user_id").eq("id", sellerId).maybeSingle();
        if (sellerProfileForReactivate?.user_id) {
            await notifyUser(sellerProfileForReactivate.user_id, {
                type: "transport_proposal_received",
                title: "New transport route proposed",
                body: `A buyer proposed a new ${mode.replace(/_/g, " ")} option for ${originCity} → ${destCity}.`,
                link: `/transport-library?tab=manage`,
            });
        }

        return res.json({ success: true, reused: false, option: reactivated });
    }

    const { data: created, error } = await supabase
        .from("transport_route_options")
        .insert({
            seller_id: sellerId,
            origin_state: normalizeLoc(originState), origin_city: normalizeLoc(originCity),
            dest_state: normalizeLoc(destState), dest_city: normalizeLoc(destCity),
            mode, fields: cleanFields, status: "proposed",
            proposed_by_buyer_id: buyerId, proposal_note: note?.trim() || null,
        })
        .select()
        .single();

    if (error) {
        if (error.code === "23505") {
            const { data: retry } = await supabase
                .from("transport_route_options")
                .select("*")
                .eq("seller_id", sellerId).eq("mode", mode)
                .ilike("origin_state", normalizeLoc(originState)).ilike("origin_city", normalizeLoc(originCity))
                .ilike("dest_state", normalizeLoc(destState)).ilike("dest_city", normalizeLoc(destCity))
                .in("status", ["proposed", "approved"]).maybeSingle();
            if (retry) return res.json({ success: true, reused: true, option: retry });
        }
        return res.status(500).json({ success: false, message: error.message });
    }

    const { data: sellerProfile } = await supabase.from("seller_profiles").select("user_id").eq("id", sellerId).maybeSingle();
    if (sellerProfile?.user_id) {
        await notifyUser(sellerProfile.user_id, {
            type: "transport_proposal_received",
            title: "New transport route proposed",
            body: `A buyer proposed a new ${mode.replace(/_/g, " ")} option for ${originCity} → ${destCity}.`,
            link: `/transport-library?tab=manage`,
        });
    }

    res.json({ success: true, reused: false, option: created });
}

// POST /api/transport-library/proposals/:id/approve  (seller only)
export async function approveProposal(req, res) {
    const { data: row } = await supabase.from("transport_route_options").select("*").eq("id", req.params.id).maybeSingle();
    if (!row) return res.status(404).json({ success: false, message: "Proposal not found." });
    if (row.seller_id !== req.sellerId) return res.status(403).json({ success: false, message: "Not your listing." });
    if (row.status !== "proposed") return res.status(400).json({ success: false, message: "This proposal was already resolved." });

    const { error } = await supabase
        .from("transport_route_options")
        .update({ status: "approved", approved_at: new Date().toISOString() })
        .eq("id", req.params.id);
    if (error) return res.status(500).json({ success: false, message: error.message });

    // The buyer may have chosen "continue to order" while this was still
    // pending, which explicitly saved a "no preference for now" decision
    // (mode: null) to buyer_seller_transport_preferences. Now that the
    // seller has approved exactly what the buyer proposed, update that
    // saved decision to point at the newly-approved option — otherwise
    // the buyer's Buy Now form keeps reading the stale "no preference"
    // row forever and never learns the approval happened.
    if (row.proposed_by_buyer_id) {
        await supabase
            .from("buyer_seller_transport_preferences")
            .upsert({
                buyer_id: row.proposed_by_buyer_id,
                seller_id: row.seller_id,
                dest_state: row.dest_state,
                dest_city: row.dest_city,
                route_option_id: row.id,
                mode: row.mode,
                fields: row.fields,
                updated_at: new Date().toISOString(),
            }, { onConflict: "buyer_id,seller_id,dest_state,dest_city" });
    }

    if (row.proposed_by_buyer_id) {
        await notifyUser(row.proposed_by_buyer_id, {
            type: "transport_proposal_approved",
            title: "Transport option approved",
            body: `The seller approved your proposed transport option for ${row.origin_city} → ${row.dest_city}. You can now select it when ordering.`,
            link: `/orders`,
        });
    }
    res.json({ success: true });
}

// POST /api/transport-library/proposals/:id/reject  (seller only)
export async function rejectProposal(req, res) {
    const { reason } = req.body || {};
    const { data: row } = await supabase.from("transport_route_options").select("*").eq("id", req.params.id).maybeSingle();
    if (!row) return res.status(404).json({ success: false, message: "Proposal not found." });
    if (row.seller_id !== req.sellerId) return res.status(403).json({ success: false, message: "Not your listing." });
    if (row.status !== "proposed") return res.status(400).json({ success: false, message: "This proposal was already resolved." });

    const { error } = await supabase
        .from("transport_route_options")
        .update({ status: "rejected", rejection_reason: reason?.trim() || null })
        .eq("id", req.params.id);
    if (error) return res.status(500).json({ success: false, message: error.message });

    // Mark this rejection as unacknowledged on the buyer's saved
    // preference row. Unlike approval, there's no option to point at
    // here — so this is the only way the buyer's Buy Now form (possibly
    // in a fresh session later) can learn "your proposal was declined"
    // instead of silently landing on a bare "no preference" state.
    // Cleared only when the buyer acknowledges via Skip or picks a new
    // preference — see setBuyerSellerTransportPreference below.
    if (row.proposed_by_buyer_id) {
        await supabase
            .from("buyer_seller_transport_preferences")
            .upsert({
                buyer_id: row.proposed_by_buyer_id,
                seller_id: row.seller_id,
                dest_state: row.dest_state,
                dest_city: row.dest_city,
                rejected_route_option_id: row.id,
                rejected_mode: row.mode,
                rejected_fields: row.fields,
                updated_at: new Date().toISOString(),
            }, { onConflict: "buyer_id,seller_id,dest_state,dest_city" });
    }

    if (row.proposed_by_buyer_id) {
        await notifyUser(row.proposed_by_buyer_id, {
            type: "transport_proposal_rejected",
            title: "Transport option declined",
            body: reason?.trim() || `The seller couldn't accept the proposed transport option for ${row.origin_city} → ${row.dest_city}.`,
            link: `/orders`,
        });
    }
    res.json({ success: true });
}

// GET /api/transport-library/mine  (seller manage page)
export async function listMyRouteOptions(req, res) {
    const { data, error } = await supabase
        .from("transport_route_options")
        .select("*")
        .eq("seller_id", req.sellerId)
        .neq("status", "removed")
        .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, options: data || [] });
}

// POST /api/transport-library/options  (seller adds their own — no approval step)
export async function createOwnRouteOption(req, res) {
    const { originState, originCity, destState, destCity, mode, fields } = req.body || {};
    if (!originState || !originCity || !destState || !destCity || !mode) {
        return res.status(400).json({ success: false, message: "Missing required fields." });
    }
    const cleanFields = normalizeFieldValues(fields || {});
    const fieldError = validateFields(mode, cleanFields);
    if (fieldError) return res.status(400).json({ success: false, message: fieldError });

    const identity = identityKey(mode, cleanFields);

    // If this seller previously removed this exact route+mode+company,
    // reactivate that same row instead of inserting a new one — keeps
    // one historical record instead of forking into two, and sidesteps
    // the active-rows unique constraint entirely.
    //
    // Matched on identityKey (trimmed/whitespace-collapsed/lowercased)
    // rather than a raw equality check — this is what was silently
    // failing before: a re-typed company name that differed only by a
    // stray space or letter casing from the original never matched the
    // removed row, so a duplicate got inserted instead of the old one
    // being brought back.
    const { data: removedCandidates } = await supabase
        .from("transport_route_options")
        .select("*")
        .eq("seller_id", req.sellerId)
        .eq("mode", mode)
        .eq("status", "removed")
        .ilike("origin_state", normalizeLoc(originState))
        .ilike("origin_city", normalizeLoc(originCity))
        .ilike("dest_state", normalizeLoc(destState))
        .ilike("dest_city", normalizeLoc(destCity));

    const removedMatch = (removedCandidates || []).find(
        (row) => identityKey(row.mode, row.fields) === identity
    );

    if (removedMatch) {
        const { data: reactivated, error: reactivateError } = await supabase
            .from("transport_route_options")
            .update({ status: "approved", fields: cleanFields, removed_at: null, approved_at: new Date().toISOString() })
            .eq("id", removedMatch.id)
            .select().single();
        if (reactivateError) return res.status(500).json({ success: false, message: reactivateError.message });
        return res.json({ success: true, option: reactivated });
    }

    const { data, error } = await supabase
        .from("transport_route_options")
        .insert({
            seller_id: req.sellerId,
            origin_state: normalizeLoc(originState), origin_city: normalizeLoc(originCity),
            dest_state: normalizeLoc(destState), dest_city: normalizeLoc(destCity),
            mode, fields: cleanFields, status: "approved", approved_at: new Date().toISOString(),
        })
        .select().single();

    if (error) {
        if (error.code === "23505") return res.status(400).json({ success: false, message: "You already have this transport option on this route." });
        return res.status(500).json({ success: false, message: error.message });
    }
    res.json({ success: true, option: data });
}

// PATCH /api/transport-library/options/:id  (seller only)
export async function updateOwnRouteOption(req, res) {
    const { fields } = req.body || {};
    const { data: row } = await supabase.from("transport_route_options").select("seller_id, mode").eq("id", req.params.id).maybeSingle();
    if (!row) return res.status(404).json({ success: false, message: "Not found." });
    if (row.seller_id !== req.sellerId) return res.status(403).json({ success: false, message: "Not your listing." });

    const cleanFields = normalizeFieldValues(fields || {});
    const fieldError = validateFields(row.mode, cleanFields);
    if (fieldError) return res.status(400).json({ success: false, message: fieldError });

    const { error } = await supabase.from("transport_route_options").update({ fields: cleanFields }).eq("id", req.params.id);
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true });
}

// DELETE /api/transport-library/options/:id  (seller only)
// Soft-delete: this row may be referenced by past orders
// (orders.transport_route_option_id) and is meant to be retained history
// once entered, not erased. Flip status to "removed" instead of deleting
// the row — it disappears from every list (route-options, browse,
// suggestions, and this seller's own Active Routes — all of which filter
// on status = 'approved'), so no NEW order can select it, while the row
// itself — and anything already pointing at it — stays intact.
export async function deleteOwnRouteOption(req, res) {
    const { data: row } = await supabase.from("transport_route_options").select("seller_id, status").eq("id", req.params.id).maybeSingle();
    if (!row) return res.status(404).json({ success: false, message: "Not found." });
    if (row.seller_id !== req.sellerId) return res.status(403).json({ success: false, message: "Not your listing." });
    if (row.status === "removed") return res.json({ success: true }); // already removed — idempotent

    const { error } = await supabase
        .from("transport_route_options")
        .update({ status: "removed", removed_at: new Date().toISOString() })
        .eq("id", req.params.id);
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true });
}

// GET /api/transport-library/browse?originCity=&destCity=&q=
// Public library page: browse all sellers/companies servicing a route.
export async function browseLibrary(req, res) {
    const { originCity, destCity, q } = req.query;
    let query = supabase
        .from("transport_route_options")
        .select("id, origin_state, origin_city, dest_state, dest_city, mode, fields, created_at, seller:seller_profiles(id, display_name, shop_slug, city, state)")
        .eq("status", "approved")
        .order("created_at", { ascending: false })
        .limit(200);

    if (originCity) query = query.ilike("origin_city", `%${originCity}%`);
    if (destCity) query = query.ilike("dest_city", `%${destCity}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });

    let rows = data || [];
    if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter((r) =>
            identityValue(r.mode, r.fields).toLowerCase().includes(needle) ||
            (r.seller?.display_name || "").toLowerCase().includes(needle)
        );
    }
    res.json({ success: true, options: rows });
}

// GET /api/transport-library/proposals  (seller manage page — pending only)
export async function listPendingProposals(req, res) {
    const { data, error } = await supabase
        .from("transport_route_options")
        .select("*")
        .eq("seller_id", req.sellerId)
        .eq("status", "proposed")
        .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, proposals: data || [] });
}

// GET /api/transport-library/buyer-preference?sellerId=&destState=&destCity=&checkProposalId=
// Whether THIS buyer has already decided a transport preference for THIS
// seller ON THIS ROUTE (their selected address's city/state) — not just
// "this seller in general". A buyer with two addresses in different
// cities can have two different decisions for the same seller.
export async function getBuyerSellerTransportPreference(req, res) {
    const buyerId = req.user.id;
    const { sellerId, destState, destCity, checkProposalId } = req.query;
    if (!sellerId) return res.status(400).json({ success: false, message: "sellerId is required." });
    if (!destState || !destCity) return res.status(400).json({ success: false, message: "destState and destCity are required." });

    const { data: pendingRow } = await supabase
        .from("transport_route_options")
        .select("id, mode, fields")
        .eq("seller_id", sellerId)
        .eq("status", "proposed")
        .eq("proposed_by_buyer_id", buyerId)
        .ilike("dest_state", destState.trim())
        .ilike("dest_city", destCity.trim())
        .maybeSingle();

    const pendingProposal = pendingRow
        ? { routeOptionId: pendingRow.id, mode: pendingRow.mode, fields: pendingRow.fields, summary: routeOptionSummary(pendingRow.mode, pendingRow.fields) }
        : null;

    let checkedProposalStatus = null;
    if (checkProposalId) {
        const { data: checkedRow } = await supabase
            .from("transport_route_options")
            .select("status")
            .eq("id", checkProposalId)
            .maybeSingle();
        checkedProposalStatus = checkedRow?.status || "not_found";
    }

    const { data, error } = await supabase
        .from("buyer_seller_transport_preferences")
        .select("route_option_id, mode, fields, rejected_route_option_id, rejected_mode, rejected_fields")
        .eq("buyer_id", buyerId)
        .eq("seller_id", sellerId)
        .ilike("dest_state", destState.trim())
        .ilike("dest_city", destCity.trim())
        .maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });

    // An unacknowledged rejection takes priority in the response
    // regardless of what else is (or isn't) saved — it's independent of
    // whether a decision/pending proposal exists, since rejection wipes
    // out the thing the buyer would otherwise be shown.
    const rejectedNotice = data?.rejected_route_option_id
        ? { mode: data.rejected_mode, fields: data.rejected_fields || {}, summary: routeOptionSummary(data.rejected_mode, data.rejected_fields || {}) }
        : null;

    if (!data) return res.json({ success: true, decided: false, preference: null, pendingProposal, checkedProposalStatus, rejectedNotice });

    if (!data.mode) {
        return res.json({ success: true, decided: true, preference: null, pendingProposal, checkedProposalStatus, rejectedNotice });
    }

    let stillActive = true;
    if (data.route_option_id) {
        const { data: routeRow } = await supabase
            .from("transport_route_options")
            .select("status")
            .eq("id", data.route_option_id)
            .maybeSingle();
        stillActive = routeRow?.status === "approved";
    }

    if (!stillActive) {
        return res.json({ success: true, decided: false, preference: null, invalidated: true, pendingProposal, checkedProposalStatus, rejectedNotice });
    }

    const preference = {
        routeOptionId: data.route_option_id,
        mode: data.mode,
        fields: data.fields || {},
        summary: routeOptionSummary(data.mode, data.fields || {}),
    };

    res.json({ success: true, decided: true, preference, pendingProposal, checkedProposalStatus, rejectedNotice });
}

// POST /api/transport-library/buyer-preference
// body: { sellerId, destState, destCity, preference: { routeOptionId, mode, fields } | null }
export async function setBuyerSellerTransportPreference(req, res) {
    const buyerId = req.user.id;
    const { sellerId, destState, destCity, preference } = req.body || {};
    if (!sellerId) return res.status(400).json({ success: false, message: "sellerId is required." });
    if (!destState || !destCity) return res.status(400).json({ success: false, message: "destState and destCity are required." });

    const row = {
        buyer_id: buyerId,
        seller_id: sellerId,
        dest_state: destState.trim(),
        dest_city: destCity.trim(),
        route_option_id: preference?.routeOptionId || null,
        mode: preference?.mode || null,
        fields: preference?.fields || null,
        // Any explicit save — including Skip — acknowledges and clears a
        // pending rejection notice.
        rejected_route_option_id: null,
        rejected_mode: null,
        rejected_fields: null,
        updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
        .from("buyer_seller_transport_preferences")
        .upsert(row, { onConflict: "buyer_id,seller_id,dest_state,dest_city" });
    if (error) return res.status(500).json({ success: false, message: error.message });

    res.json({ success: true });
}