import { normalizeServiceKeys, buildServicePlan, sumServicePercent } from "../../shared/marketingServices.js";

// Server is the only place the percent is computed. Client-sent percents are ignored.
export function resolveMarketingFields(keys) {
    const marketing_services = normalizeServiceKeys(keys);
    return {
        marketing_services,
        marketing_plan: buildServicePlan(marketing_services),
        marketing_commission_percent: sumServicePercent(marketing_services),
        marketing_legacy_percent: null, // any save through the new plan ends legacy
    };
}