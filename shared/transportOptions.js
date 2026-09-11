// shared/transportOptions.js
//
// Single source of truth for seller-serviceable transport channels and the
// per-channel fields a seller must/can fill in when confirming an order.
// Imported from BOTH sides (same pattern as shared/packUnits.js and
// shared/orderConstraints.js already in this repo):
//   backend:  import { TRANSPORT_OPTIONS } from "../../shared/transportOptions.js"
//   frontend: import { TRANSPORT_OPTIONS } from "../../shared/transportOptions.js"
//
// Used by:
//   1. Seller onboarding — the "which channels do you service?" picker.
//   2. BuyNowModal — the buyer's optional "preferred transport method"
//      picker (only ever shows the channels THIS seller services).
//   3. ConfirmOrderModal — the dynamic form the seller fills in when
//      confirming an order (fields differ per channel).
//   4. TransportInfoCard — renders whatever was submitted, on both the
//      buyer's and seller's order detail pages.

export const TRANSPORT_OPTIONS = [
    {
        key: "self_pickup",
        label: "Self Pickup",
        fields: [
            { key: "contact_name", label: "Pickup contact name", type: "text", required: true },
            { key: "contact_phone", label: "Pickup contact number", type: "text", required: true },
            { key: "pickup_address", label: "Pickup address / instructions", type: "textarea", required: false },
        ],
    },
    {
        key: "rapido",
        label: "Rapido",
        fields: [
            { key: "contact_name", label: "Rider / contact name", type: "text", required: false },
            { key: "contact_phone", label: "Contact number", type: "text", required: true },
            { key: "tracking_number", label: "Tracking / booking ID", type: "text", required: false },
        ],
    },
    {
        key: "roadway_transport",
        label: "Roadway Transport",
        fields: [
            { key: "transport_company", label: "Transport company", type: "text", required: true },
            { key: "lr_number", label: "LR number", type: "text", required: true },
            { key: "vehicle_number", label: "Vehicle number", type: "text", required: false },
            { key: "contact_phone", label: "Driver / transport contact number", type: "text", required: false },
        ],
    },
    {
        key: "parcel_service",
        label: "Parcel Service",
        fields: [
            { key: "transport_company", label: "Parcel company", type: "text", required: true },
            { key: "lr_number", label: "LR / booking number", type: "text", required: true },
            { key: "contact_phone", label: "Contact number", type: "text", required: false },
        ],
    },
    {
        key: "train_service",
        label: "Train Service",
        fields: [
            { key: "transport_company", label: "Railway parcel office", type: "text", required: false },
            { key: "lr_number", label: "RR / parcel receipt number", type: "text", required: true },
            { key: "contact_phone", label: "Contact number", type: "text", required: false },
        ],
    },
    {
        key: "flight_service",
        label: "Flight Service",
        fields: [
            { key: "transport_company", label: "Airline / cargo company", type: "text", required: true },
            { key: "tracking_number", label: "AWB / tracking number", type: "text", required: true },
            { key: "contact_phone", label: "Contact number", type: "text", required: false },
        ],
    },
    {
        key: "courier_service",
        label: "Courier Service",
        fields: [
            { key: "transport_company", label: "Courier company", type: "text", required: true },
            { key: "tracking_number", label: "Tracking number", type: "text", required: true },
            { key: "contact_phone", label: "Contact number", type: "text", required: false },
        ],
    },
];

export function getTransportOption(key) {
    return TRANSPORT_OPTIONS.find((t) => t.key === key) || null;
}

export function transportLabel(key) {
    return getTransportOption(key)?.label || key || "Not specified";
}
