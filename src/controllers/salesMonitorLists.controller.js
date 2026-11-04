
// controllers/salesMonitorLists.controller.js
//
// Admin-only full-page Sales monitor lists.
//
// GET /api/sales-monitor/enquiries
// GET /api/sales-monitor/orders
//
// Date filtering:
//  - Matches records created during the selected date range.
//  - Matches records whose latest activity date is within the range.
//  - Also matches records with ANY historical activity during the range.
//
// Enquiry activity: sales_thread_entries
// Order activity: order_book_events
//
// Mount under /api/sales-monitor AFTER requireAuth.
// Apply requireSalesMonitorAdmin to both routes.

import { supabase } from "../config/supabase.js";
import { supabaseAdmin } from "../config/supabase.js";
import { getTeamContext } from "../services/team.service.js";
import { isUuid } from "../services/rfqValidation.js";
import { STATUSES as ORDER_STATUSES } from "../services/orderBook.service.js";

const fail = (res, status, message) =>
    res.status(status).json({
        success: false,
        message,
    });

const ENQUIRY_STATUSES = [
    "open",
    "won",
    "lost",
    "reminder",
    "cold",
];

const MAX_LIMIT = 100;
const ACTIVITY_PAGE_SIZE = 1000;

function safeSearch(raw) {
    return String(raw || "")
        .replace(/[%_,()\\*]/g, " ")
        .trim()
        .slice(0, 80);
}

function pageOf(query) {
    const limitRaw = Number.parseInt(query.limit, 10);
    const offsetRaw = Number.parseInt(query.offset, 10);

    return {
        limit: Math.min(
            Math.max(
                Number.isFinite(limitRaw) ? limitRaw : 15,
                1
            ),
            MAX_LIMIT
        ),

        offset: Math.max(
            Number.isFinite(offsetRaw) ? offsetRaw : 0,
            0
        ),
    };
}

function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const [y, m, d] = value.split("-").map(Number);

    const check = new Date(
        Date.UTC(y, m - 1, d)
    );

    return (
        check.getUTCFullYear() === y &&
        check.getUTCMonth() === m - 1 &&
        check.getUTCDate() === d
    );
}

// from/to are inclusive calendar dates in India time.
//
// Example:
// from=2026-11-01
// to=2026-11-04
//
// Includes the complete November 1 through November 4
// IST calendar days.

function dateRange(query) {
    const from = query.from == null
        ? ""
        : String(query.from);

    const to = query.to == null
        ? ""
        : String(query.to);

    if (
        (from && !validDate(from)) ||
        (to && !validDate(to))
    ) {
        return {
            error: "Use valid from/to dates in YYYY-MM-DD format.",
        };
    }

    if (from && to && from > to) {
        return {
            error: "The from date must not be after the to date.",
        };
    }

    const start = from
        ? new Date(
            `${from}T00:00:00+05:30`
        ).toISOString()
        : null;

    const endExclusive = to
        ? new Date(
            Date.parse(`${to}T00:00:00+05:30`) +
            24 * 60 * 60 * 1000
        ).toISOString()
        : null;

    return {
        start,
        endExclusive,
    };
}

// -----------------------------------------------------------------------------
// ADMIN ACCESS
// -----------------------------------------------------------------------------

function monitorScope(req, res) {
    // Set by requireSalesMonitorAdmin.
    const scope = req.salesMonitor;

    if (!scope?.companyId || !scope?.actorId) {
        fail(
            res,
            403,
            "Only company admins can access the Sales monitor."
        );

        return null;
    }

    return scope;
}

// Company owner and team admin only.
// Regular members and salespeople cannot access company-wide lists.

export async function requireSalesMonitorAdmin(
    req,
    res,
    next
) {
    try {
        if (!req.user?.id) {
            return fail(
                res,
                401,
                "Please sign in again."
            );
        }

        const actorId = req.actor?.id || req.user.id;

        const ctx = await getTeamContext(actorId);

        const role = String(
            ctx?.role || ""
        ).toLowerCase();

        const owner =
            ctx?.isMember === false &&
            actorId === req.user.id;

        const adminMember =
            !!ctx?.isMember &&
            ["admin", "owner", "administrator"].includes(role);

        if (!owner && !adminMember) {
            return fail(
                res,
                403,
                "Only company admins can access the Sales monitor."
            );
        }

        req.salesMonitor = {
            companyId: req.user.id,
            actorId,
        };

        return next();

    } catch (e) {
        console.error(
            "[sales monitor lists] access check failed:",
            e?.message || e
        );

        return fail(
            res,
            500,
            "Couldn't verify Sales monitor access."
        );
    }
}

// -----------------------------------------------------------------------------
// ACTIVITY DATE FILTERING
// -----------------------------------------------------------------------------

// Get all distinct record IDs which have an activity entry
// between the selected dates.
//
// Enquiries:
// sales_thread_entries.enquiry_id
//
// Orders:
// order_book_events.order_id
//
// Pagination is important because Supabase normally limits
// the number of returned rows.
//
// The actual records are still restricted by company_id / buyer_id
// in the final list queries.

async function getActivityRecordIds(
    table,
    foreignKey,
    dates
) {
    if (!dates.start && !dates.endExclusive) {
        return [];
    }

    const ids = new Set();

    let offset = 0;

    while (true) {
        let query = supabase
            .from(table)
            .select(`${foreignKey}, id, created_at`)
            .not(foreignKey, "is", null);

        if (dates.start) {
            query = query.gte(
                "created_at",
                dates.start
            );
        }

        if (dates.endExclusive) {
            query = query.lt(
                "created_at",
                dates.endExclusive
            );
        }

        const {
            data,
            error,
        } = await query
            .order("created_at", {
                ascending: true,
            })
            .order("id", {
                ascending: true,
            })
            .range(
                offset,
                offset + ACTIVITY_PAGE_SIZE - 1
            );

        if (error) throw error;

        const rows = data || [];

        for (const row of rows) {
            const recordId = row[foreignKey];

            if (recordId && isUuid(recordId)) {
                ids.add(recordId);
            }
        }

        if (rows.length < ACTIVITY_PAGE_SIZE) {
            break;
        }

        offset += ACTIVITY_PAGE_SIZE;
    }

    return [...ids];
}

// Build an individual date condition for a timestamp column.
//
// This matches either one date boundary or both inclusive
// date boundaries (using an exclusive ending instant).

function timestampRangeCondition(
    column,
    dates
) {
    const parts = [];

    if (dates.start) {
        parts.push(
            `${column}.gte.${dates.start}`
        );
    }

    if (dates.endExclusive) {
        parts.push(
            `${column}.lt.${dates.endExclusive}`
        );
    }

    if (!parts.length) {
        return null;
    }

    return parts.length === 1
        ? parts[0]
        : `and(${parts.join(",")})`;
}

// A record matches the date filter when:
//
// 1. It was created inside the selected date range.
// OR
// 2. Its latest activity timestamp is inside the range.
// OR
// 3. It has any historical activity entry inside the range.
//
// This is what allows an older enquiry/order to appear when
// someone updates it during the selected dates.

function dateActivityCondition(
    dates,
    activityIds,
    activityColumn = "last_activity_at"
) {
    if (!dates.start && !dates.endExclusive) {
        return null;
    }

    const createdCondition =
        timestampRangeCondition(
            "created_at",
            dates
        );

    const updatedCondition =
        timestampRangeCondition(
            activityColumn,
            dates
        );

    const alternatives = [
        createdCondition,
        updatedCondition,
    ].filter(Boolean);

    if (activityIds?.length) {
        alternatives.push(
            `id.in.(${activityIds.join(",")})`
        );
    }

    if (alternatives.length === 1) {
        return alternatives[0];
    }

    return `or(${alternatives.join(",")})`;
}

// Combine actor, search and date filters into ONE logical expression.
//
// Base conditions such as buyer_id/company_id remain separate .eq() filters.
//
// Nested OR conditions are kept together so actor/search/date conditions
// do not accidentally replace one another.

function applyMonitorConditions(
    query,
    conditions
) {
    const valid = conditions.filter(Boolean);

    if (!valid.length) {
        return query;
    }

    const expression = valid.length === 1
        ? valid[0]
        : `and(${valid.join(",")})`;

    return query.or(expression);
}

// -----------------------------------------------------------------------------
// ENQUIRY FILTERS
// -----------------------------------------------------------------------------

function applyEnquiryCommon(
    query,
    {
        companyId,
        actorId,
        search,
        dates,
        activityIds = [],
    }
) {
    query = query
        .eq("buyer_id", companyId)
        .eq("source", "sales");

    const conditions = [];

    if (actorId) {
        conditions.push(
            `or(created_by_actor_id.eq.${actorId},last_updated_by_actor_id.eq.${actorId})`
        );
    }

    if (search) {
        conditions.push(
            `or(product_name.ilike.%${search}%,customer_name.ilike.%${search}%,customer_gstin.ilike.%${search}%)`
        );
    }

    const dateCondition = dateActivityCondition(
        dates,
        activityIds,
        "last_activity_at"
    );

    if (dateCondition) {
        conditions.push(dateCondition);
    }

    return applyMonitorConditions(
        query,
        conditions
    );
}

function applyEnquiryStatus(query, status) {
    if (status === "open") {
        return query.neq("status", "closed");
    }

    if (status === "won") {
        return query
            .eq("status", "closed")
            .eq("sales_outcome", "won");
    }

    if (status === "lost") {
        return query
            .eq("status", "closed")
            .eq("sales_outcome", "lost");
    }

    if (status === "reminder") {
        return query
            .neq("status", "closed")
            .not("reminder_at", "is", null);
    }

    if (status === "cold") {
        return query.eq(
            "sales_kind",
            "cold_call"
        );
    }

    return query;
}

// -----------------------------------------------------------------------------
// PROFILE NAMES
// -----------------------------------------------------------------------------

const GENERIC_NAMES = new Set([
    "salesperson", "sales person", "sales", "sales executive", "team member", "teammember",
    "teammate", "member", "staff", "employee", "user", "unnamed", "unknown",
]);
const realName = (v) => {
    const s = String(v || "").trim();
    return s && !GENERIC_NAMES.has(s.toLowerCase().replace(/[\s_-]+/g, " ")) ? s : "";
};
// first real name wins: live profile first, then whatever was saved on the row
const pickName = (...candidates) => {
    for (const c of candidates) { const n = realName(c); if (n) return n; }
    return "";
};
// "Salesperson: hello" -> "Raheelkhan: hello"
const fixPreview = (preview, name) => {
    const text = String(preview || "");
    const m = /^([^:]{1,40}):\s/.exec(text);
    return m && name && !realName(m[1]) ? `${name}: ${text.slice(m[0].length)}` : text;
};

async function profileNames(ids) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    if (!unique.length) return new Map();

    const { data, error } = await supabaseAdmin
        .from("profiles")
        .select("id, name, email, phone")
        .in("id", unique);

    if (error) {
        console.error("[sales monitor lists] profile names lookup failed:", error.message);
        return new Map();
    }
    return new Map((data || []).map((p) => [p.id, realName(p.name) || p.email || p.phone || ""]));
}

async function countOrThrow(query) {
    const result = await query;

    if (result.error) {
        throw result.error;
    }

    return result.count || 0;
}

// -----------------------------------------------------------------------------
// GET /api/sales-monitor/enquiries
//
// ?actorId=
// &q=
// &status=open|won|lost|reminder|cold
// &from=YYYY-MM-DD
// &to=YYYY-MM-DD
// &limit=
// &offset=
// -----------------------------------------------------------------------------

export async function listMonitorEnquiries(req, res) {
    try {
        res.set("Cache-Control", "no-store");

        const scope = monitorScope(req, res);

        if (!scope) return;

        const actorFilter = req.query.actorId
            ? String(req.query.actorId)
            : "";

        if (
            actorFilter &&
            !isUuid(actorFilter)
        ) {
            return fail(
                res,
                400,
                "Invalid salesperson filter."
            );
        }

        const {
            start,
            endExclusive,
            error: dateError,
        } = dateRange(req.query);

        if (dateError) {
            return fail(res, 400, dateError);
        }

        const dates = {
            start,
            endExclusive,
        };

        const {
            limit,
            offset,
        } = pageOf(req.query);

        const search = safeSearch(req.query.q);

        const status = ENQUIRY_STATUSES.includes(
            req.query.status
        )
            ? req.query.status
            : "";

        // Fetch activity IDs only when a date filter is supplied.
        const activityIds =
            dates.start || dates.endExclusive
                ? await getActivityRecordIds(
                    "sales_thread_entries",
                    "enquiry_id",
                    dates
                )
                : [];

        const filters = {
            companyId: scope.companyId,
            actorId: actorFilter,
            search,
            dates,
            activityIds,
        };

        let listQuery = supabase
            .from("rfq_enquiries")
            .select("*", {
                count: "exact",
            });

        listQuery = applyEnquiryCommon(
            listQuery,
            filters
        );

        listQuery = applyEnquiryStatus(
            listQuery,
            status
        )
            .order("last_activity_at", {
                ascending: false,
            })
            .order("id", {
                ascending: true,
            })
            .range(
                offset,
                offset + limit - 1
            );

        // Counts follow exactly the same filters, including activity dates
        // and actor search. Only the selected status is excluded.

        const countsQuery = (nextStatus = "") => {
            let q = supabase
                .from("rfq_enquiries")
                .select("id", {
                    count: "exact",
                    head: true,
                });

            q = applyEnquiryCommon(
                q,
                filters
            );

            return applyEnquiryStatus(
                q,
                nextStatus
            );
        };

        const [
            list,
            all,
            open,
            reminder,
            cold,
            won,
            lost,
        ] = await Promise.all([
            listQuery,

            countOrThrow(
                countsQuery()
            ),

            countOrThrow(
                countsQuery("open")
            ),

            countOrThrow(
                countsQuery("reminder")
            ),

            countOrThrow(
                countsQuery("cold")
            ),

            countOrThrow(
                countsQuery("won")
            ),

            countOrThrow(
                countsQuery("lost")
            ),
        ]);

        if (list.error) {
            throw list.error;
        }

        const rows = list.data || [];

        const ids = rows.map((r) => r.id);

        // Quotes and latest thread entries for the current page only.

        const [
            quoteRows,
            latestEntries,
        ] = ids.length
                ? await Promise.all([
                    supabase
                        .from("sales_quotes")
                        .select("enquiry_id")
                        .in("enquiry_id", ids),

                    supabase
                        .from("sales_thread_entries")
                        .select(
                            "enquiry_id, author_id, author_name, created_at, id"
                        )
                        .in("enquiry_id", ids)
                        .order("created_at", {
                            ascending: false,
                        })
                        .order("id", {
                            ascending: false,
                        })
                        .limit(1000),
                ])
                : [
                    {
                        data: [],
                        error: null,
                    },
                    {
                        data: [],
                        error: null,
                    },
                ];

        if (quoteRows.error) {
            throw quoteRows.error;
        }

        if (latestEntries.error) {
            throw latestEntries.error;
        }

        const quoteCounts = new Map();

        for (const q of quoteRows.data || []) {
            quoteCounts.set(
                q.enquiry_id,
                (quoteCounts.get(q.enquiry_id) || 0) + 1
            );
        }

        // Latest thread entry per enquiry.
        // Used as fallback for older records that may not have
        // updater fields populated yet.

        const latestByEnquiry = new Map();

        for (const entry of latestEntries.data || []) {
            if (!latestByEnquiry.has(entry.enquiry_id)) {
                latestByEnquiry.set(
                    entry.enquiry_id,
                    entry
                );
            }
        }

        const actorIds = [];

        for (const r of rows) {
            const latest = latestByEnquiry.get(r.id);

            actorIds.push(
                r.created_by_actor_id,
                r.last_updated_by_actor_id || latest?.author_id
            );
        }

        const names = await profileNames(actorIds);

        const items = rows.map((r) => {
            const latest = latestByEnquiry.get(r.id);

            const createdId =
                r.created_by_actor_id || null;

            const lastId =
                r.last_updated_by_actor_id ||
                latest?.author_id ||
                createdId;

            return {
                id: r.id,

                displayName:
                    r.customer_name ||
                    r.customer_gstin ||
                    "",

                productName:
                    r.product_name || "",

                quantity:
                    r.quantity ?? null,

                unit:
                    r.unit || "",

                hasProduct:
                    !!r.product_name,

                kind:
                    r.sales_kind || "enquiry",

                status:
                    r.status === "closed"
                        ? (r.sales_outcome || "closed")
                        : "open",

                outcome:
                    r.sales_outcome || null,

                reminderAt:
                    r.reminder_at || null,

                quotesCount:
                    quoteCounts.get(r.id) || 0,

                lastPreview:
                    fixPreview(
                        r.last_entry_preview,
                        pickName(names.get(lastId), r.last_updated_by_actor_name, latest?.author_name)
                    ),

                lastActivityAt:
                    r.last_activity_at || r.created_at,

                createdAt:
                    r.created_at,

                createdById:
                    createdId,

                createdByName:
                    pickName(names.get(createdId), r.created_by_actor_name),


                lastUpdatedById:
                    lastId || null,

                lastUpdatedByName:
                    pickName(names.get(lastId), r.last_updated_by_actor_name, latest?.author_name),
            };
        });

        return res.json({
            success: true,

            items,

            total:
                list.count ?? items.length,

            hasMore:
                offset + items.length <
                (list.count ?? 0),

            counts: {
                all,
                open,
                reminder,
                cold,
                won,
                lost,
            },
        });

    } catch (e) {
        console.error(
            "[sales monitor lists] enquiries failed:",
            e?.message || e
        );

        return fail(
            res,
            500,
            "Couldn't load Sales monitor enquiries."
        );
    }
}

// -----------------------------------------------------------------------------
// ORDER FILTERS
// -----------------------------------------------------------------------------

function applyOrderCommon(
    query,
    {
        companyId,
        actorId,
        search,
        dates,
        activityIds = [],
    }
) {
    query = query.eq(
        "company_id",
        companyId
    );

    const conditions = [];

    if (actorId) {
        conditions.push(
            `or(salesperson_id.eq.${actorId},last_updated_by_actor_id.eq.${actorId})`
        );
    }

    if (search) {
        conditions.push(
            `or(customer_name.ilike.%${search}%,order_no.ilike.%${search}%,customer_gstin.ilike.%${search}%,po_number.ilike.%${search}%)`
        );
    }

    const dateCondition = dateActivityCondition(
        dates,
        activityIds,
        "last_activity_at"
    );

    if (dateCondition) {
        conditions.push(dateCondition);
    }

    return applyMonitorConditions(
        query,
        conditions
    );
}

// -----------------------------------------------------------------------------
// GET /api/sales-monitor/orders
//
// ?actorId=
// &q=
// &status=placed|processed|shipped|completed|cancelled
// &from=YYYY-MM-DD
// &to=YYYY-MM-DD
// &limit=
// &offset=
// -----------------------------------------------------------------------------

export async function listMonitorOrders(req, res) {
    try {
        res.set("Cache-Control", "no-store");

        const scope = monitorScope(req, res);

        if (!scope) return;

        const actorFilter = req.query.actorId
            ? String(req.query.actorId)
            : "";

        if (
            actorFilter &&
            !isUuid(actorFilter)
        ) {
            return fail(
                res,
                400,
                "Invalid salesperson filter."
            );
        }

        const {
            start,
            endExclusive,
            error: dateError,
        } = dateRange(req.query);

        if (dateError) {
            return fail(res, 400, dateError);
        }

        const dates = {
            start,
            endExclusive,
        };

        const {
            limit,
            offset,
        } = pageOf(req.query);

        const search = safeSearch(req.query.q);

        const status = ORDER_STATUSES.includes(
            req.query.status
        )
            ? req.query.status
            : "";

        // Activity date filtering includes every order event,
        // not just the most recent status change.

        const activityIds =
            dates.start || dates.endExclusive
                ? await getActivityRecordIds(
                    "order_book_events",
                    "order_id",
                    dates
                )
                : [];

        const filters = {
            companyId: scope.companyId,
            actorId: actorFilter,
            search,
            dates,
            activityIds,
        };

        let listQuery = supabase
            .from("order_book_orders")
            .select(
                [
                    "id",
                    "order_no",
                    "po_number",
                    "customer_name",
                    "customer_gstin",
                    "status",
                    "items",
                    "total_amount",
                    "created_at",
                    "updated_at",
                    "last_activity_at",
                    "salesperson_id",
                    "salesperson_name",
                    "last_updated_by_actor_id",
                    "last_updated_by_actor_name",
                ].join(","),
                {
                    count: "exact",
                }
            );

        listQuery = applyOrderCommon(
            listQuery,
            filters
        );

        if (status) {
            listQuery = listQuery.eq(
                "status",
                status
            );
        }

        listQuery = listQuery
            .order("last_activity_at", {
                ascending: false,
            })
            .order("id", {
                ascending: true,
            })
            .range(
                offset,
                offset + limit - 1
            );

        // Counts use the same company, salesperson, search and activity-date
        // filters as the list. They only differ by status.

        const countQuery = (nextStatus = "") => {
            let q = supabase
                .from("order_book_orders")
                .select("id", {
                    count: "exact",
                    head: true,
                });

            q = applyOrderCommon(
                q,
                filters
            );

            return nextStatus
                ? q.eq("status", nextStatus)
                : q;
        };

        const [
            list,
            all,
            placed,
            processed,
            shipped,
            completed,
            cancelled,
        ] = await Promise.all([
            listQuery,

            countOrThrow(
                countQuery()
            ),

            countOrThrow(
                countQuery("placed")
            ),

            countOrThrow(
                countQuery("processed")
            ),

            countOrThrow(
                countQuery("shipped")
            ),

            countOrThrow(
                countQuery("completed")
            ),

            countOrThrow(
                countQuery("cancelled")
            ),
        ]);

        if (list.error) {
            throw list.error;
        }

        const rows = list.data || [];

        const ids = rows.map((r) => r.id);

        // Read latest order events as a fallback for historical rows
        // that do not have updater fields populated.

        const latestEvents = ids.length
            ? await supabase
                .from("order_book_events")
                .select(
                    "order_id, actor_id, actor_name, created_at, id"
                )
                .in("order_id", ids)
                .order("created_at", {
                    ascending: false,
                })
                .order("id", {
                    ascending: false,
                })
                .limit(1000)
            : {
                data: [],
                error: null,
            };

        if (latestEvents.error) {
            throw latestEvents.error;
        }

        const latestByOrder = new Map();

        for (const event of latestEvents.data || []) {
            if (!latestByOrder.has(event.order_id)) {
                latestByOrder.set(
                    event.order_id,
                    event
                );
            }
        }

        const actorIds = [];

        for (const r of rows) {
            const latest = latestByOrder.get(r.id);

            actorIds.push(
                r.salesperson_id,
                r.last_updated_by_actor_id || latest?.actor_id
            );
        }

        const names = await profileNames(actorIds);

        const items = rows.map((r) => {
            const latest = latestByOrder.get(r.id);

            const createdId =
                r.salesperson_id || null;

            const lastId =
                r.last_updated_by_actor_id ||
                latest?.actor_id ||
                createdId;

            const createdName = pickName(names.get(createdId), r.salesperson_name);

            return {
                id: r.id,

                orderNo:
                    r.order_no || "",

                poNumber:
                    r.po_number || "",

                customerName:
                    r.customer_name || "",

                status:
                    r.status,

                itemsCount:
                    Array.isArray(r.items)
                        ? r.items.length
                        : 0,

                total:
                    Number(r.total_amount) || 0,

                createdAt:
                    r.created_at,

                updatedAt:
                    r.updated_at ||
                    r.last_activity_at ||
                    r.created_at,

                createdById:
                    createdId,

                createdByName:
                    createdName,

                lastUpdatedById:
                    lastId || null,

                lastUpdatedByName:
                    pickName(
                        names.get(lastId),
                        r.last_updated_by_actor_name,
                        latest?.actor_name,
                        createdName
                    ),
            };
        });

        return res.json({
            success: true,

            items,

            total:
                list.count ?? items.length,

            hasMore:
                offset + items.length <
                (list.count ?? 0),

            counts: {
                all,
                placed,
                processed,
                shipped,
                completed,
                cancelled,
            },
        });

    } catch (e) {
        console.error(
            "[sales monitor lists] orders failed:",
            e?.message || e
        );

        return fail(
            res,
            500,
            "Couldn't load Sales monitor orders."
        );
    }
}
