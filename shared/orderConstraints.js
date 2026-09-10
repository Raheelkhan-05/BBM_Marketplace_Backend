// shared/orderConstraints.js
//
// checkOrderWindow no longer represents a hard "can this be placed" gate —
// it now tells you (a) whether the seller is accepting RIGHT NOW, and
// (b) if not, how many whole days that pushes acceptance out by. Callers
// use `delayDays` to push the estimated delivery date forward — they must
// NEVER use this to block order placement anymore (this is an online
// marketplace; a closed shop just means "we'll get to it a bit later").
//
// checkLocationServiceable is UNCHANGED and still a hard block — a seller
// who doesn't ship to a state/city genuinely cannot fulfill that order,
// which is a different kind of problem than "not open right now".

const IST_OFFSET_MINUTES = 5 * 60 + 30;
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function getISTParts(date = new Date()) {
    const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * 60000);
    return {
        dayOfWeek: ist.getUTCDay(),
        hours: ist.getUTCHours(),
        minutes: ist.getUTCMinutes(),
        isoDate: ist.toISOString().slice(0, 10),
    };
}

function normalizeDayToken(token) {
    return String(token ?? "").trim().toLowerCase();
}

function workingDaysToIndexSet(workingDays) {
    if (!Array.isArray(workingDays) || workingDays.length === 0) return null;
    const set = new Set();
    for (const d of workingDays) {
        if (typeof d === "number" && d >= 0 && d <= 6) { set.add(d); continue; }
        const token = normalizeDayToken(d);
        const byName = DAY_NAMES.indexOf(token);
        if (byName !== -1) { set.add(byName); continue; }
        const byAbbr = DAY_ABBR.indexOf(token.slice(0, 3));
        if (byAbbr !== -1) set.add(byAbbr);
    }
    return set.size ? set : null;
}

function parseTimeToMinutes(t) {
    if (!t) return null;
    const [h, m] = String(t).split(":").map(Number);
    if (Number.isNaN(h)) return null;
    return h * 60 + (Number.isNaN(m) ? 0 : m);
}

function formatTimeLabel(t) {
    const [h, m] = String(t).split(":").map(Number);
    const period = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m || 0).padStart(2, "0")} ${period}`;
}

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatIsoDateLabel(isoDate) {
    const [, m, d] = isoDate.split("-").map(Number);
    return `${d} ${MONTH_SHORT[m - 1]}`;
}

function findNextOpenDay(workingDaysSet, holidays, fromDate, maxDaysAhead = 21) {
    for (let offset = 0; offset <= maxDaysAhead; offset++) {
        const ist = getISTParts(new Date(fromDate.getTime() + offset * 86400000));
        if (workingDaysSet && !workingDaysSet.has(ist.dayOfWeek)) continue;
        if (holidays.includes(ist.isoDate)) continue;
        return { ...ist, daysAhead: offset };
    }
    return null;
}

/**
 * sellerProfile: { workingDays, orderAcceptanceStart, orderAcceptanceEnd, holidays }
 * `now`: client Date() for instant UI feedback, server `new Date()` for the
 * authoritative computation used to build the final delivery estimate.
 *
 * Returns:
 *   {
 *     open: boolean,          // accepting orders RIGHT NOW
 *     delayDays: number,      // whole days this pushes acceptance out by (0 if open)
 *     reason?: string,
 *     message?: string,       // buyer-facing "accepted then" copy — informational, non-blocking
 *     windowLabel?: string,   // "9:00 AM–6:00 PM IST"
 *   }
 *
 * NEVER use `open === false` to block placement — only to decide whether
 * to show the informational notice and to compute delayDays.
 */
export function checkOrderWindow(sellerProfile, now = new Date()) {
    if (!sellerProfile) return { open: true, delayDays: 0 };

    const { workingDays, orderAcceptanceStart, orderAcceptanceEnd, holidays } = sellerProfile;
    const holidayList = Array.isArray(holidays) ? holidays : [];
    const dayIndexSet = workingDaysToIndexSet(workingDays);
    const ist = getISTParts(now);

    const startMin = parseTimeToMinutes(orderAcceptanceStart);
    const endMin = parseTimeToMinutes(orderAcceptanceEnd);
    const hasTimeWindow = startMin != null && endMin != null;
    const nowMin = ist.hours * 60 + ist.minutes;

    const isHolidayToday = holidayList.includes(ist.isoDate);
    const isWorkingDayToday = !dayIndexSet || dayIndexSet.has(ist.dayOfWeek);
    const withinTimeWindow = !hasTimeWindow || (startMin <= endMin
        ? (nowMin >= startMin && nowMin <= endMin)
        : (nowMin >= startMin || nowMin <= endMin));

    if (isWorkingDayToday && !isHolidayToday && withinTimeWindow) {
        return { open: true, delayDays: 0 };
    }

    const windowLabel = hasTimeWindow ? `${formatTimeLabel(orderAcceptanceStart)}–${formatTimeLabel(orderAcceptanceEnd)} IST` : null;

    // Still today, a working day, just before the window opens — order
    // will be accepted later TODAY, so it doesn't push the date forward.
    if (isWorkingDayToday && !isHolidayToday && hasTimeWindow && nowMin < startMin) {
        return {
            open: false,
            delayDays: 0,
            reason: "OUTSIDE_ORDER_HOURS",
            message: `This seller is currently closed and opens today at ${formatTimeLabel(orderAcceptanceStart)} IST — your order will be placed now and accepted once they're open.`,
            windowLabel,
        };
    }

    const closedTodayPrefix = isHolidayToday
        ? "This seller is on holiday today."
        : !isWorkingDayToday
            ? "This seller isn't accepting orders today."
            : "This seller's order window for today has closed.";

    const next = findNextOpenDay(dayIndexSet, holidayList, new Date(now.getTime() + 86400000));
    if (!next) {
        return {
            open: false,
            delayDays: 3, // conservative fallback — should basically never hit this path
            reason: "SELLER_CLOSED",
            message: `${closedTodayPrefix} Your order will still be placed, but acceptance may take a little longer than usual.`,
            windowLabel,
        };
    }

    const dayLabel = next.daysAhead === 0
        ? "tomorrow"
        : next.daysAhead <= 6
            ? DAY_LABELS[next.dayOfWeek]
            : `${DAY_LABELS[next.dayOfWeek]}, ${formatIsoDateLabel(next.isoDate)}`;

    return {
        open: false,
        // next.daysAhead is relative to "now + 1 day" (that's the scan's
        // start), so the actual day-count from *now* is daysAhead + 1.
        delayDays: next.daysAhead + 1,
        reason: isHolidayToday ? "SELLER_ON_HOLIDAY" : (!isWorkingDayToday ? "NON_WORKING_DAY" : "OUTSIDE_ORDER_HOURS"),
        message: `${closedTodayPrefix} Your order will be placed now and accepted ${dayLabel}${windowLabel ? `, ${windowLabel}.` : "."}`,
        windowLabel,
    };
}

function norm(s) { return String(s ?? "").trim().toLowerCase(); }

// UNCHANGED — location serviceability is still a hard block.
export function checkLocationServiceable(dispatchingLocations, address) {
    if (!Array.isArray(dispatchingLocations) || dispatchingLocations.length === 0) {
        return { serviceable: true };
    }
    if (!address || (!address.state && !address.city)) {
        return { serviceable: true };
    }

    const stateEntries = dispatchingLocations.filter((l) => norm(l.type) === "state");
    if (!stateEntries.length) return { serviceable: true };

    const match = stateEntries.find((l) => norm(l.name) === norm(address.state));
    if (!match) {
        return { serviceable: false, reason: "STATE_NOT_SERVICEABLE", message: "This seller doesn't currently deliver to your selected state." };
    }

    const cities = Array.isArray(match.includedCities) ? match.includedCities.map(norm) : [];
    if (cities.length && !cities.includes(norm(address.city))) {
        return { serviceable: false, reason: "CITY_NOT_SERVICEABLE", message: "This seller doesn't currently deliver to your selected city." };
    }

    return { serviceable: true };
}