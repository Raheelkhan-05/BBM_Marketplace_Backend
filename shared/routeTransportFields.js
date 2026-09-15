// shared/routeTransportFields.js
//
// Field schemas for the Transport Library — used when a buyer PROPOSES or
// a seller ADDS a route-level transport option (e.g. "this seller ships
// via Shree Roadways on the Ahmedabad -> Mumbai route"). These are
// COMPANY-level fields, collected once per route/company.
//
// This is deliberately separate from shared/transportOptions.js, whose
// `fields` are SHIPMENT-level (LR number, vehicle number, tracking
// number...) and get collected once per ORDER at ship time — see
// controllers/sellerOrders.controller.js shipOrder().
//
// Imported from both sides, same pattern as shared/transportOptions.js:
//   backend:  import { ... } from "../../shared/routeTransportFields.js"
//   frontend: import { ... } from "../../shared/routeTransportFields.js"

export const ROUTE_TRANSPORT_GROUPS = [
    { group: "Self-arranged", modes: ["self_pickup", "rapido"] },
    { group: "Roadways", modes: ["roadway_transport"] },
    { group: "Railways", modes: ["train_service"] },
    { group: "Parcel & Courier", modes: ["parcel_service", "courier_service"] },
    { group: "Air", modes: ["flight_service"] },
];

export const ROUTE_TRANSPORT_MODE_LABELS = {
    self_pickup: "Self Pickup",
    rapido: "Rapido",
    roadway_transport: "Roadway Transport",
    train_service: "Train Service",
    parcel_service: "Parcel Service",
    courier_service: "Courier Service",
    flight_service: "Flight Service",
};

// The field that identifies a distinct "company" for dedup purposes —
// mirrors the partial unique index in the migration.
export const ROUTE_TRANSPORT_IDENTITY_FIELD = {
    roadway_transport: "transport_company",
    parcel_service: "transport_company",
    courier_service: "transport_company",
    flight_service: "airline_name",
    train_service: "train_number",
    rapido: null,
    self_pickup: null,
};

// Company-level fields collected when proposing/adding a route option.
// No LR/tracking numbers here — those are shipment-specific and belong to
// shared/transportOptions.js instead.
export const ROUTE_TRANSPORT_FIELDS = {
    self_pickup: [
        { key: "pickup_address", label: "Pickup address / instructions", type: "textarea", required: false },
        { key: "contact_number", label: "Pickup contact number", type: "text", required: false },
    ],
    rapido: [
        { key: "contact_number", label: "Contact number (optional)", type: "text", required: false },
    ],
    roadway_transport: [
        { key: "transport_company", label: "Transport company name", type: "text", required: true },
        { key: "branch_name", label: "Branch name (if any)", type: "text", required: false },
        { key: "contact_number", label: "Contact number (if any)", type: "text", required: false },
    ],
    parcel_service: [
        { key: "transport_company", label: "Parcel company name", type: "text", required: true },
        { key: "branch_name", label: "Branch name (if any)", type: "text", required: false },
        { key: "contact_number", label: "Contact number (if any)", type: "text", required: false },
    ],
    courier_service: [
        { key: "transport_company", label: "Courier company name", type: "text", required: true },
        { key: "branch_name", label: "Branch name (if any)", type: "text", required: false },
        { key: "contact_number", label: "Contact number (if any)", type: "text", required: false },
    ],
    train_service: [
        { key: "train_number", label: "Train number", type: "text", required: true },
        { key: "train_name", label: "Train name (if any)", type: "text", required: false },
        { key: "contact_number", label: "Contact number (if any)", type: "text", required: false },
    ],
    flight_service: [
        { key: "airline_name", label: "Airline / cargo company", type: "text", required: true },
        { key: "contact_number", label: "Contact number (if any)", type: "text", required: false },
    ],
};

export function getRouteTransportFields(mode) {
    return ROUTE_TRANSPORT_FIELDS[mode] || [];
}

export function routeTransportModeLabel(mode) {
    return ROUTE_TRANSPORT_MODE_LABELS[mode] || mode || "Not specified";
}

export function routeOptionIdentity(mode, fields = {}) {
    const key = ROUTE_TRANSPORT_IDENTITY_FIELD[mode];
    return key ? (fields?.[key] || "") : "";
}

// Short human summary used in list rows across the app, e.g.
// "Shree Roadways · Andheri Branch" or "12345 — Gujarat Mail".
export function routeOptionSummary(mode, fields = {}) {
    switch (mode) {
        case "roadway_transport":
        case "parcel_service":
        case "courier_service":
            return [fields?.transport_company, fields?.branch_name].filter(Boolean).join(" · ") || routeTransportModeLabel(mode);
        case "train_service":
            return [fields?.train_number, fields?.train_name].filter(Boolean).join(" — ") || routeTransportModeLabel(mode);
        case "flight_service":
            return fields?.airline_name || routeTransportModeLabel(mode);
        case "self_pickup":
            return "Self Pickup";
        case "rapido":
            return "Rapido";
        default:
            return routeTransportModeLabel(mode);
    }
}