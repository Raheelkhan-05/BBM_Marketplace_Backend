// shared/orderConstraints.js
//
// Two independent gates on placing an order with a seller:
//  1. checkOrderWindow  — is it within the seller's working days + hours (IST)?
//  2. checkLocationServiceable — does the seller deliver to the buyer's state/city?
//
// Both fail OPEN when data is missing/unconfigured — same posture as
// assertSellerAcceptingOrders() in orders.controller.js. A missing config
// should never silently block every seller who hasn't filled the field in.

const IST_OFFSET_MINUTES = 5 * 60 + 30;
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Converts any Date (an absolute instant — Date.getTime() is already UTC,
// regardless of the host machine's own timezone) into its IST wall-clock
// parts, by shifting the instant forward by +5:30 and reading it back with
// the UTC getters. Do NOT add date.getTimezoneOffset() here — that's only
// needed when building a Date from local wall-clock components, not when
// you already have a real instant; adding it on top of the IST shift
// silently cancels the shift out on any machine whose own timezone happens
// to be IST, which makes the check compute UTC time and label it IST —
// i.e. every check ends up off by exactly 5 hours 30 minutes.
export function getISTParts(date = new Date()) {
    const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * 60000);
    return {
        dayOfWeek: ist.getUTCDay(), // 0=Sunday ... 6=Saturday (IST)
        hours: ist.getUTCHours(),
        minutes: ist.getUTCMinutes(),
        isoDate: ist.toISOString().slice(0, 10), // YYYY-MM-DD in IST
    };
}

function normalizeDayToken(token) {
    return String(token ?? "").trim().toLowerCase();
}

// Accepts weekday names ("Monday"/"Mon") or 0-6 indices. Returns null
// (= no restriction) when working_days is empty/unset, matching the
// column's '[]' default.
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

// sellerProfile: { workingDays, orderAcceptanceStart, orderAcceptanceEnd, holidays }
// `now`: pass the caller's own Date — client Date() for instant UI feedback,
// server `new Date()` for the authoritative re-check on submit.
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatIsoDateLabel(isoDate) {
    const [, m, d] = isoDate.split("-").map(Number);
    return `${d} ${MONTH_SHORT[m - 1]}`;
}

// Scans forward day-by-day (IST calendar days) starting from `fromDate`
// itself (offset 0) looking for the next day that's both a working day
// and not a holiday. This is what lets the message correctly skip past
// non-working days AND holidays together — a seller open Mon/Wed/Fri who
// also happens to have Wednesday marked as a holiday will correctly be
// told Friday, not Wednesday.
function findNextOpenDay(workingDaysSet, holidays, fromDate, maxDaysAhead = 21) {
    for (let offset = 0; offset <= maxDaysAhead; offset++) {
        const ist = getISTParts(new Date(fromDate.getTime() + offset * 86400000));
        if (workingDaysSet && !workingDaysSet.has(ist.dayOfWeek)) continue;
        if (holidays.includes(ist.isoDate)) continue;
        return { ...ist, daysAhead: offset };
    }
    return null;
}

// sellerProfile: { workingDays, orderAcceptanceStart, orderAcceptanceEnd, holidays }
// `now`: pass the caller's own Date — client Date() for instant UI feedback,
// server `new Date()` for the authoritative re-check on submit.
export function checkOrderWindow(sellerProfile, now = new Date()) {
    if (!sellerProfile) return { open: true };

    const { workingDays, orderAcceptanceStart, orderAcceptanceEnd, holidays } = sellerProfile;
    const holidayList = Array.isArray(holidays) ? holidays : [];
    const dayIndexSet = workingDaysToIndexSet(workingDays); // null = no restriction, every day is a working day
    const ist = getISTParts(now);

    const startMin = parseTimeToMinutes(orderAcceptanceStart);
    const endMin = parseTimeToMinutes(orderAcceptanceEnd);
    const hasTimeWindow = startMin != null && endMin != null;
    const nowMin = ist.hours * 60 + ist.minutes;

    const isHolidayToday = holidayList.includes(ist.isoDate);
    const isWorkingDayToday = !dayIndexSet || dayIndexSet.has(ist.dayOfWeek);
    const withinTimeWindow = !hasTimeWindow || (startMin <= endMin
        ? (nowMin >= startMin && nowMin <= endMin)
        : (nowMin >= startMin || nowMin <= endMin)); // overnight window e.g. 22:00–06:00

    if (isWorkingDayToday && !isHolidayToday && withinTimeWindow) {
        return { open: true };
    }

    const windowLabel = hasTimeWindow ? `${formatTimeLabel(orderAcceptanceStart)}–${formatTimeLabel(orderAcceptanceEnd)} IST` : null;

    // Still today, a real working day, just before the window opens —
    // the one case where "today" is actually the right answer.
    if (isWorkingDayToday && !isHolidayToday && hasTimeWindow && nowMin < startMin) {
        return {
            open: false, reason: "OUTSIDE_ORDER_HOURS",
            message: `This seller opens today at ${formatTimeLabel(orderAcceptanceStart)} IST.`,
        };
    }

    // Every other closed case (non-working day, holiday, or today's window
    // already passed) needs to say WHEN they're actually next open, not
    // just repeat today's hours — that's what was misleading before.
    const closedTodayPrefix = isHolidayToday
        ? "This seller is on holiday today."
        : !isWorkingDayToday
            ? "This seller isn't accepting orders today."
            : "This seller's order window for today has closed.";

    const next = findNextOpenDay(dayIndexSet, holidayList, new Date(now.getTime() + 86400000));
    if (!next) {
        // No working day found in the lookahead window — extremely unlikely
        // (would mean 3+ weeks with no open day), but don't leave the UI
        // hanging on a bad message if it somehow happens.
        return { open: false, reason: "SELLER_CLOSED", message: `${closedTodayPrefix} Please check back later.` };
    }

    const dayLabel = next.daysAhead === 0
        ? "tomorrow"
        : next.daysAhead <= 6
            ? DAY_LABELS[next.dayOfWeek]
            : `${DAY_LABELS[next.dayOfWeek]}, ${formatIsoDateLabel(next.isoDate)}`;

    return {
        open: false,
        reason: isHolidayToday ? "SELLER_ON_HOLIDAY" : (!isWorkingDayToday ? "NON_WORKING_DAY" : "OUTSIDE_ORDER_HOURS"),
        message: `${closedTodayPrefix} They're next open ${dayLabel}${windowLabel ? `, ${windowLabel}.` : "."}`,
    };
}

function norm(s) { return String(s ?? "").trim().toLowerCase(); }

// dispatchingLocations: the jsonb array from seller_product_submissions,
// e.g. [{type:"country",...,includeOnly:true}, {type:"state",name:"Gujarat",includedCities:["JAMNAGAR","AHMADABAD"]}]
// - No entries at all -> unconfigured, serviceable everywhere (fail open).
// - No "state" entries -> only a country scope was set, no state narrowing.
// - A "state" entry with includedCities -> only those cities in that state.
// - A "state" entry with no includedCities -> the whole state.
export function checkLocationServiceable(dispatchingLocations, address) {
    if (!Array.isArray(dispatchingLocations) || dispatchingLocations.length === 0) {
        return { serviceable: true };
    }
    if (!address || (!address.state && !address.city)) {
        return { serviceable: true }; // nothing picked yet — don't block before there's an address to check
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