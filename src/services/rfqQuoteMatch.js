// services/rfqQuoteMatch.js
// THE ONE PLACE that decides "does this catalog listing match this enquiry?".
// Plug & play for testing: change RFQ_MATCH_STRATEGY in .env (no code change), or edit isMatch().
//
//   generic_product (default) : listing's catalog item has the SAME generic product the admin mapped on the enquiry.
//                               If the enquiry is not mapped yet, falls back to "name".
//   name                      : loose product-name match (every word of the enquiry appears in the listing name/brand).
//   all                       : every listing matches (quickest way to test the rest of the flow).

export const MATCH_STRATEGY = (process.env.RFQ_MATCH_STRATEGY || "generic_product").toLowerCase();

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (s) => norm(s).split(" ").filter((t) => t.length >= 2);

function nameMatch(enquiryName, listingText) {
    const need = tokens(enquiryName);
    const hay = ` ${norm(listingText)} `;
    if (!need.length || !hay.trim()) return false;
    return need.every((t) => hay.includes(t));
}

/**
 * @param enquiry { product_name, generic_product_id }  (rfq_enquiries row)
 * @param listing { product_name, brand_name, brand: { name, brand_name, generic_product_id } }
 */
export function isMatch(enquiry, listing) {
    if (MATCH_STRATEGY === "all") return true;
    const byName = () =>
        nameMatch(enquiry.product_name, `${listing.brand?.name || listing.product_name || ""} ${listing.brand?.brand_name || listing.brand_name || ""}`);
    if (MATCH_STRATEGY === "name") return byName();
    // generic_product
    if (enquiry.generic_product_id) return !!listing.brand?.generic_product_id && listing.brand.generic_product_id === enquiry.generic_product_id;
    return byName();
}