// controllers/rfqQuote.controller.js — seller quotes on buyer enquiries (RFQ)
import { supabase } from "../config/supabase.js";
import { isUuid } from "../services/rfqValidation.js";
import { isMatch } from "../services/rfqQuoteMatch.js";
import { notifyUser } from "../services/notifications.service.js";
import { emitRfqQuotesChanged } from "../services/rfqRealtime.js";
import { sameUnit, customSalePrice, quoteToDto, fetchActiveQuotes, fetchMyQuotes } from "../services/rfqQuotes.service.js";
import {
    round2, computeQuoteBreakdown, saleDivisor, moqInUnits, nearPrice, validityMeta, validUntilFor,
} from "../../shared/rfqQuoteMath.js";
import { estimateDeliveryDate, resolveSellerDispatchLocation, getAcceptanceWindow } from "./orders.controller.js";

const BASES = ["per_unit", "per_pack", "per_master_pack"];
const sellerIdOf = (req) => req.sellerId || req.user.id;

const LISTING_COLS = `
    id, product_name, brand_name, image, price, unit, pack_size, units_per_master_pack, gst_percent, moq,
    freight_included, is_active, expires_at, review_status, stock_type, production_lead_time_days,
    dispatch_time_days, lead_time, generic_product_brand_id, visibility_mode,
    hs_generic_product_brands!inner ( id, name, brand_name, image, generic_product_id, deleted_at )`;

const withBrand = ({ hs_generic_product_brands, ...rest }) => ({ ...rest, brand: hs_generic_product_brands || null });
const pos = (n) => (Number(n) > 0 ? Number(n) : 1);

function availability(s) {
    if (s.review_status === "pending_review") return "In review";
    if (s.review_status !== "approved") return "Not available";
    if (s.is_active === false) return "Paused";
    if (s.expires_at && new Date(s.expires_at).getTime() <= Date.now()) return "Expired";
    return null;
}

async function loadQuotableEnquiry(id, sellerId) {
    if (!isUuid(id)) return { status: 404, message: "Enquiry not found." };
    const { data, error } = await supabase.from("rfq_enquiries").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data || data.status !== "approved") return { status: 404, message: "This enquiry is no longer open for quotes." };
    if (data.buyer_id === sellerId) return { status: 403, message: "You can't quote on your own enquiry." };
    return { enquiry: data };
}

// Delivery estimate for the BUYER (seller dispatch location -> enquiry delivery pincode). Never sent to the seller.
async function estimateForBuyer(listing, sellerProfile, enquiry) {
    const clamp = (n) => Math.max(0, Math.min(365, Math.round(n)));
    try {
        const win = await getAcceptanceWindow(listing.id).catch(() => ({ delayDays: 0 }));
        const loc = resolveSellerDispatchLocation(sellerProfile);
        const d = await estimateDeliveryDate(
            listing, loc.pincode, loc.state, enquiry.delivery_pincode, enquiry.delivery_state, win?.delayDays || 0
        );
        const base = d.acceptanceDelayDays + d.leadDays;
        return { min: clamp(base + d.transitDaysMin), max: clamp(base + d.transitDaysMax) };
    } catch (e) {
        console.error("[rfq quote] delivery estimate failed:", e.message);
        const lead = Number(listing.stock_type === "made_to_order" ? listing.production_lead_time_days : (listing.dispatch_time_days ?? listing.lead_time)) || 0;
        return { min: clamp(lead + 2), max: clamp(lead + 5) };
    }
}

// GET /api/rfq/:id/quote-options
export async function getQuoteOptions(req, res) {
    try {
        const sellerId = sellerIdOf(req);
        const out = await loadQuotableEnquiry(req.params.id, sellerId);
        if (out.message) return res.status(out.status).json({ success: false, message: out.message });
        const { enquiry } = out;
        const acceptEquivalent = !!enquiry.accept_equivalent;

        const { data: subs, error } = await supabase
            .from("seller_product_submissions")
            .select(LISTING_COLS)
            .eq("seller_id", sellerId)
            .neq("review_status", "rejected")
            .is("hs_generic_product_brands.deleted_at", null);
        if (error) throw error;
        const listings = (subs || []).map(withBrand);
        const subIds = listings.map((s) => s.id);

        const [cpRes, myQuotes] = await Promise.all([
            subIds.length
                ? supabase.from("buyer_seller_custom_prices")
                    .select("submission_id, override_type, fixed_price, discount_percent")
                    .eq("seller_id", sellerId).eq("buyer_id", enquiry.buyer_id).in("submission_id", subIds)
                : Promise.resolve({ data: [] }),
            fetchMyQuotes([enquiry.id], sellerId),
        ]);
        if (cpRes.error) throw cpRes.error;
        const cpBySub = new Map((cpRes.data || []).map((c) => [c.submission_id, c]));
        const my = myQuotes.get(enquiry.id) || null;

        const items = listings.map((s) => {
            const reason = availability(s);
            const matches = isMatch(enquiry, s);
            const unitOk = sameUnit(s.unit, enquiry.unit);
            const pack = pos(s.pack_size), master = pos(s.units_per_master_pack);
            const hasMaster = master > 1;
            const cpSale = customSalePrice(s.price, cpBySub.get(s.id) || null);
            return {
                submissionId: s.id,
                productName: s.brand?.name || s.product_name,
                brandName: s.brand?.brand_name || s.brand_name || "",
                image: s.image || s.brand?.image || null,
                unit: s.unit,
                packSize: pack,
                masterPackSize: master,
                hasMaster,
                saleBasis: hasMaster ? "per_master_pack" : pack > 1 ? "per_pack" : "per_unit",
                gstPercent: Number(s.gst_percent) || 0,
                moq: s.moq != null ? Number(s.moq) : null,
                moqUnits: moqInUnits(s.moq, pack, master),
                freightIncluded: !!s.freight_included,
                matches,
                available: !reason,
                reason,
                selectable: !reason && (matches || acceptEquivalent),
                unitMatches: unitOk,
                listPrice: unitOk ? round2(s.price) : null,
                customPrice: unitOk && cpSale != null ? round2(cpSale) : null,
                quoted: !!my && my.submission_id === s.id,
            };
        }).sort((a, b) => Number(b.matches) - Number(a.matches) || String(a.productName).localeCompare(String(b.productName)));

        // ---- Catalogue items for THIS enquiry's product ("Sell this item") ----
        const BRAND_COLS = "id, name, brand_name, image, unit, pack_size, generic_product_id";
        let brands = [];
        let brandsAll = null;
        let lookup = "none";

        if (enquiry.generic_product_id) {
            lookup = "generic_product";
            const { data, error: bErr } = await supabase
                .from("hs_generic_product_brands").select(BRAND_COLS)
                .eq("generic_product_id", enquiry.generic_product_id)
                .eq("review_status", "approved").is("deleted_at", null).limit(60);
            if (bErr) throw bErr;
            brands = data || [];
            const { count } = await supabase.from("hs_generic_product_brands")
                .select("id", { count: "exact", head: true }).eq("generic_product_id", enquiry.generic_product_id);
            brandsAll = count;
        }

        // Not linked by an admin, or nothing found under the link: look the product up by name.
        if (!brands.length) {
            const word = String(enquiry.product_name || "").toLowerCase().split(/[^a-z0-9]+/)
                .filter((t) => t.length >= 3).sort((a, b) => b.length - a.length)[0];
            if (word) {
                lookup = enquiry.generic_product_id ? "generic_product+name" : "name";
                const { data, error: bErr } = await supabase
                    .from("hs_generic_product_brands").select(BRAND_COLS)
                    .ilike("name", `%${word}%`)
                    .eq("review_status", "approved").is("deleted_at", null).limit(60);
                if (bErr) throw bErr;
                brands = data || [];
            }
        }

        const owned = new Set(listings.map((s) => s.generic_product_brand_id));
        const sellable = brands.slice(0, 30).map((b) => ({
            brandId: b.id, productName: b.name, brandName: b.brand_name || "", image: b.image || null,
            unit: b.unit || null, packSize: b.pack_size != null ? Number(b.pack_size) : null,
            unitMatches: !b.unit || sameUnit(b.unit, enquiry.unit),
            owned: owned.has(b.id),
        }));

        res.json({
            success: true,
            enquiry: {
                id: enquiry.id, productName: enquiry.product_name, unit: enquiry.unit,
                quantity: Number(enquiry.quantity), packSize: Number(enquiry.pack_size),
                totalUnits: Number(enquiry.quantity) * Number(enquiry.pack_size), acceptEquivalent,
            },
            listings: items,
            sellable,
            canAddNew: acceptEquivalent,
            myQuote: my ? quoteToDto(my, enquiry) : null,
            debug: {
                mapped: !!enquiry.generic_product_id, lookup,
                brandsFound: brandsAll ?? brands.length, brandsApproved: brands.length,
                owned: owned.size, offered: sellable.length,
            },
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// POST /api/rfq/:id/quotes   { submissionId, price, priceBasis, gstInclusive, validity, saveCustomPrice? }
export async function submitQuote(req, res) {
    try {
        const sellerId = sellerIdOf(req);
        const b = req.body || {};
        const out = await loadQuotableEnquiry(req.params.id, sellerId);
        if (out.message) return res.status(out.status).json({ success: false, message: out.message });
        const { enquiry } = out;

        const price = Number(b.price);
        const bad = (message) => res.status(400).json({ success: false, message });
        if (!isUuid(b.submissionId)) return bad("Choose a product to quote with.");
        if (!(price > 0) || price > 1e7) return bad("Enter a valid price.");
        if (!BASES.includes(b.priceBasis)) return bad("Choose whether the price is per unit, pack or master pack.");
        if (typeof b.gstInclusive !== "boolean") return bad("Tell us whether your price includes GST.");
        if (!validityMeta(b.validity)) return bad("Choose how long the quote is valid.");

        const { data: raw, error: lErr } = await supabase
            .from("seller_product_submissions").select(LISTING_COLS)
            .eq("id", b.submissionId).eq("seller_id", sellerId).is("hs_generic_product_brands.deleted_at", null).maybeSingle();
        if (lErr) throw lErr;
        if (!raw) return res.status(404).json({ success: false, message: "That product is not in your catalog." });
        const listing = withBrand(raw);
        const reason = availability(listing);
        if (reason) return res.status(409).json({ success: false, message: `This product can't be quoted right now (${reason.toLowerCase()}).` });
        if (!enquiry.accept_equivalent && !isMatch(enquiry, listing)) {
            return res.status(403).json({ success: false, message: "This buyer needs the exact product. Choose a matching product." });
        }

        const unitOk = sameUnit(listing.unit, enquiry.unit);
        if (!unitOk) return bad(`This product is sold in ${listing.unit}, but the buyer asked in ${enquiry.unit}, so it can't be quoted.`);
        const pack = pos(listing.pack_size), master = pos(listing.units_per_master_pack);
        if (b.priceBasis === "per_master_pack" && master <= 1) return bad("This product has no master pack.");

        const gstPercent = Number(listing.gst_percent) || 0;
        const totalUnits = Number(enquiry.quantity) * Number(enquiry.pack_size);
        const bd = computeQuoteBreakdown({
            price, basis: b.priceBasis, gstInclusive: b.gstInclusive, gstPercent,
            packSize: pack, masterPackSize: master, totalUnits,
        });
        if (!bd || !(bd.unitIncl > 0)) return bad("Enter a valid price.");

        // Price source: decided here from the listing, never trusted from the client.
        const saleIncl = round2(bd.unitIncl * saleDivisor(pack, master));
        let source = "manual";
        if (unitOk) {
            const { data: cp } = await supabase.from("buyer_seller_custom_prices")
                .select("override_type, fixed_price, discount_percent")
                .eq("seller_id", sellerId).eq("buyer_id", enquiry.buyer_id).eq("submission_id", listing.id).maybeSingle();
            const cpSale = customSalePrice(listing.price, cp);
            if (cpSale != null && nearPrice(saleIncl, cpSale)) source = "custom";
            else if (nearPrice(saleIncl, Number(listing.price))) source = "default";
        }

        // Optional: give this buyer the quoted price at checkout (their custom price on the listing).
        let customSaved = false;
        if (b.saveCustomPrice === true && unitOk && source === "manual") {
            try {
                const base = Number(listing.price);
                const pct = Math.round(((base - saleIncl) / base) * 1e8) / 1e6;
                const asPercent = pct > 0 && pct < 99;
                const { error: cErr } = await supabase.from("buyer_seller_custom_prices").upsert({
                    seller_id: sellerId, submission_id: listing.id, buyer_id: enquiry.buyer_id,
                    override_type: asPercent ? "percent" : "fixed",
                    discount_percent: asPercent ? pct : null,
                    fixed_price: asPercent ? null : saleIncl,
                    base_price_at_set: base,
                    updated_at: new Date().toISOString(),
                }, { onConflict: "seller_id,buyer_id,submission_id" });
                if (cErr) console.error("[rfq quote] custom price save failed:", cErr.message); else customSaved = true;
            } catch (e) { console.error("[rfq quote] custom price save failed:", e.message); }
        }
        // A restricted listing must be visible to this buyer, or they can't open /p/<id> to buy.
        if (listing.visibility_mode === "restricted") {
            try {
                await supabase.from("seller_listing_visibility").upsert(
                    { submission_id: listing.id, seller_id: sellerId, buyer_id: enquiry.buyer_id },
                    { onConflict: "submission_id,buyer_id", ignoreDuplicates: true }
                );
            } catch (e) { console.error("[rfq quote] visibility grant failed:", e.message); }
        }

        const { data: sp } = await supabase.from("seller_profiles")
            .select("display_name, pincode, state, dispatch_pincode, dispatch_state, dispatch_same_as_registered")
            .eq("id", sellerId).maybeSingle();
        const eta = await estimateForBuyer(listing, sp, enquiry);

        const row = {
            submission_id: listing.id,
            price_per_unit: bd.unitIncl,
            price_source: source,
            price_basis: b.priceBasis,
            gst_inclusive_input: b.gstInclusive,
            entered_price: price,
            gst_percent: gstPercent,
            delivery_days_min: eta.min,
            delivery_days: eta.max,
            validity_option: b.validity,
            valid_until: validUntilFor(b.validity),
            status: "active",
            product_name: listing.brand?.name || listing.product_name,
            brand_name: listing.brand?.brand_name || listing.brand_name || null,
            image: listing.image || listing.brand?.image || null,
            moq: listing.moq,
            freight_included: !!listing.freight_included,
            listing_unit: listing.unit,
            listing_pack_size: pack,
            listing_master_pack_size: master,
            checkout_matches: source !== "manual" || customSaved,
            updated_at: new Date().toISOString(),
        };

        const { data: existing, error: eErr } = await supabase
            .from("rfq_quotes").select("id, status").eq("enquiry_id", enquiry.id).eq("seller_id", sellerId).maybeSingle();
        if (eErr) throw eErr;

        const wr = existing
            ? await supabase.from("rfq_quotes").update(row).eq("id", existing.id).select("*").single()
            : await supabase.from("rfq_quotes").insert({ ...row, enquiry_id: enquiry.id, seller_id: sellerId }).select("*").single();
        if (wr.error) {
            if (wr.error.code === "23505") return res.status(409).json({ success: false, message: "Your quote was just saved. Please refresh." });
            throw wr.error;
        }

        const isUpdate = !!existing && existing.status === "active";
        if (!isUpdate) {
            try {
                await notifyUser(enquiry.buyer_id, {
                    type: "rfq_quote",
                    title: "New quote on your price list",
                    body: `${sp?.display_name || "A supplier"} sent a quote for ${enquiry.product_name}.`,
                    link: "/save/rfq",
                });
            } catch { /* best effort */ }
        }
        emitRfqQuotesChanged([enquiry.buyer_id, sellerId, req.user.id], { enquiryId: enquiry.id });

        res.json({
            success: true,
            quote: quoteToDto(wr.data, enquiry),   // seller view: no delivery estimate
            customSaved,
            updated: isUpdate,
            message: isUpdate ? "Quote updated." : "Quote sent to the buyer.",
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// POST /api/rfq/:id/quotes/withdraw
export async function withdrawQuote(req, res) {
    try {
        const sellerId = sellerIdOf(req);
        const { id } = req.params;
        if (!isUuid(id)) return res.status(404).json({ success: false, message: "Enquiry not found." });
        const { data, error } = await supabase
            .from("rfq_quotes").update({ status: "withdrawn", updated_at: new Date().toISOString() })
            .eq("enquiry_id", id).eq("seller_id", sellerId).eq("status", "active").select("id, enquiry_id").maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "No active quote to withdraw." });
        const { data: enq } = await supabase.from("rfq_enquiries").select("buyer_id").eq("id", id).maybeSingle();
        emitRfqQuotesChanged([enq?.buyer_id, sellerId, req.user.id], { enquiryId: id });
        res.json({ success: true, message: "Quote withdrawn." });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// GET /api/rfq/:id/quotes — the buyer sees every live quote, a seller sees only their own
export async function listEnquiryQuotes(req, res) {
    try {
        const { id } = req.params;
        if (!isUuid(id)) return res.status(404).json({ success: false, message: "Enquiry not found." });
        const { data: enquiry, error } = await supabase.from("rfq_enquiries").select("*").eq("id", id).maybeSingle();
        if (error) throw error;
        if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });
        if (enquiry.buyer_id === req.user.id) {
            const rows = (await fetchActiveQuotes([id])).get(id) || [];
            return res.json({ success: true, quotes: rows.map((q) => quoteToDto(q, enquiry, { forBuyer: true })) });
        }
        if (enquiry.status !== "approved") return res.status(404).json({ success: false, message: "Enquiry not found." });
        const mine = (await fetchMyQuotes([id], [req.user.id, req.sellerId])).get(id);
        res.json({ success: true, quotes: mine ? [quoteToDto(mine, enquiry)] : [] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}