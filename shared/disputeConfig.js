// shared/disputeConfig.js
// Single source of truth for cancel reasons, dispute categories and limits.
// Imported by the backend (../../shared/disputeConfig.js) AND the frontend
// (from src/components/orders and src/pages/admin: ../../../shared/disputeConfig.js).

export const DISPUTE_WINDOW_LABEL = "48 hours"; // display only — the real value is dispute_window_hours() in SQL

export const SELLER_RESPONSE_WINDOW_LABEL = "24 hours"; // display only — real value is seller_response_hours() in SQL

// Buyer may cancel only before the seller confirms.
export const CANCELLABLE_STATUSES = ["awaiting_payment", "pending_confirmation"];

export const CANCEL_REASONS = [
    { code: "placed_by_mistake", label: "Placed by mistake" },
    { code: "found_lower_price", label: "Found a lower price elsewhere" },
    { code: "faster_delivery_elsewhere", label: "Can get faster delivery elsewhere" },
    { code: "changed_requirements", label: "My requirement has changed" },
    { code: "wrong_details", label: "Wrong quantity, address or transport selected" },
    { code: "payment_issue", label: "Facing a problem with the payment" },
    { code: "other", label: "Other reason" },
];

export const MAX_CANCEL_TEXT = 500;

export const DISPUTE_CATEGORIES = [
    {
        code: "wrong_product",
        label: "Wrong product delivered",
        hint: "You received a different product, brand or variant than ordered.",
        evidenceRequired: true,
        subReasons: [
            { code: "different_product", label: "Completely different product" },
            { code: "different_brand", label: "Different brand" },
            { code: "different_variant", label: "Different variant / size / specification" },
        ],
        detailFields: [
            { key: "received_item", label: "What did you receive instead?", type: "text", required: true },
        ],
    },
    {
        code: "partial_delivery",
        label: "Partial order delivered",
        hint: "Some items or part of the quantity did not arrive.",
        evidenceRequired: false,
        subReasons: [
            { code: "items_missing", label: "Some items are missing" },
            { code: "short_quantity", label: "Quantity is less than ordered" },
        ],
        detailFields: [
            {
                key: "received_range", label: "Roughly how much of the order arrived?", type: "select", required: true,
                options: [
                    { value: "lt_25", label: "Less than 25%" },
                    { value: "25_50", label: "25% – 50%" },
                    { value: "50_75", label: "50% – 75%" },
                    { value: "75_99", label: "75% – 99%" },
                ],
            },
            { key: "missing_items", label: "Which items / quantities are missing?", type: "text", required: false },
        ],
    },
    {
        code: "damaged_product",
        label: "Damaged or defective goods",
        hint: "Goods arrived damaged, leaking, broken or unusable.",
        evidenceRequired: true,
        subReasons: [
            { code: "damaged_in_transit", label: "Damaged in transit" },
            { code: "leaking_or_broken_seal", label: "Leaking / broken seal / tampered" },
            { code: "defective", label: "Defective or not working" },
        ],
        detailFields: [
            {
                key: "damage_scope", label: "How much of the goods is affected?", type: "select", required: true,
                options: [{ value: "all", label: "All of it" }, { value: "some", label: "Only some of it" }],
            },
        ],
    },
    {
        code: "not_received",
        label: "Marked delivered, but not received",
        hint: "The seller marked the order delivered but the goods never reached you.",
        evidenceRequired: false,
        subReasons: [
            { code: "never_arrived", label: "Goods never arrived" },
            { code: "received_by_someone_else", label: "Delivered to a wrong person / address" },
        ],
        detailFields: [
            {
                key: "tracking_checked", label: "Have you checked the LR / tracking with the transporter?", type: "select", required: true,
                options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
            },
        ],
    },
    {
        code: "quality_not_as_described",
        label: "Quality not as described",
        hint: "The goods don't match the listing's quality or specification.",
        evidenceRequired: true,
        subReasons: [
            { code: "quality_below_spec", label: "Quality is below the stated specification" },
            { code: "different_from_listing", label: "Looks different from the listing" },
        ],
        detailFields: [],
    },
    {
        code: "seller_issue",
        label: "Issue with the seller",
        hint: "Problem with the seller's conduct, communication or paperwork.",
        evidenceRequired: false,
        subReasons: [
            { code: "unresponsive", label: "Seller is not responding" },
            { code: "rude_behaviour", label: "Rude or unprofessional behaviour" },
            { code: "wrong_or_missing_bill", label: "Wrong or missing bill / invoice" },
            { code: "asked_off_platform_payment", label: "Asked to pay outside the platform" },
            { code: "other_conduct", label: "Other seller conduct" },
        ],
        detailFields: [],
    },
    {
        code: "other",
        label: "Something else",
        hint: "Any other problem with this order.",
        evidenceRequired: false,
        subReasons: [],
        detailFields: [],
    },
];

export const DESIRED_RESOLUTIONS = [
    { code: "full_refund", label: "Full refund" },
    { code: "partial_refund", label: "Partial refund" },
    { code: "replacement", label: "Replacement / re-delivery" },
    { code: "other", label: "Something else" },
];

export const MIN_DESCRIPTION_LENGTH = 15;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_EVIDENCE_FILES = 4;
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
export const EVIDENCE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

export const RESOLUTION_LABELS = {
    release_to_seller: "Released to seller",
    full_refund: "Full refund to buyer",
    partial_refund: "Partial refund / split",
    no_financial_action: "Decision recorded (no marketplace funds involved)",
};

export const DISPUTE_STATUS_LABELS = { open: "Open", under_review: "Under review", resolved: "Resolved" };

export function findCategory(code) {
    return DISPUTE_CATEGORIES.find((c) => c.code === code) || null;
}
export function labelFor(list, code) {
    return list.find((x) => x.code === code)?.label || code || "";
}