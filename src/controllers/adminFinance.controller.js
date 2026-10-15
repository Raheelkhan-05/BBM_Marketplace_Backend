// controllers/adminFinance.controller.js
// Admin-only (mount behind requireAuth + requireAdmin). Read-only: nothing here changes money state.
// Heavy aggregation lives in SQL (sql/2026_10_admin_finance.sql); this file validates input,
// converts units and shapes responses. All dates are Asia/Kolkata calendar days.
import { supabase } from "../config/supabase.js";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKETS = ["day", "week", "month"];
const KINDS = ["payment_in", "wallet_topup", "wallet_manual", "refund_out", "seller_payout", "ledger_refund"];
const MAX_RANGE_DAYS = 366;
const EXPORT_PAGE = 1000;
const EXPORT_MAX = 20000;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const validDay = (s) => typeof s === "string" && ISO_DAY.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function parseRange(query) {
    const to = validDay(query.to) ? query.to : todayIST();
    const from = validDay(query.from) ? query.from : addDays(to, -29);
    if (from > to) return { error: "The start date must be on or before the end date." };
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    if (span > MAX_RANGE_DAYS) return { error: `Pick a range of at most ${MAX_RANGE_DAYS} days.` };
    return { from, to, fromTs: `${from}T00:00:00+05:30`, toTs: `${addDays(to, 1)}T00:00:00+05:30` };
}

const fail = (res, e, label) => {
    console.error(`[adminFinance] ${label}:`, e?.message || e);
    return res.status(500).json({ success: false, message: "Couldn't load finance data. Please try again." });
};

const mapTxn = (r) => ({
    kind: r.o_kind, id: r.o_id, at: r.o_at, amount: round2(r.o_amount), status: r.o_status, reference: r.o_reference,
    orderId: r.o_order_id, orderNumber: r.o_order_number, party: r.o_party, counterparty: r.o_counterparty,
    purpose: r.o_purpose, note: r.o_note,
});

function txnArgs(query, range) {
    const kind = KINDS.includes(query.kind) ? query.kind : null;
    const status = typeof query.status === "string" && /^[a-z_]{2,30}$/.test(query.status) ? query.status : null;
    const q = String(query.q || "").replace(/[%,()\\*]/g, " ").trim().slice(0, 60) || null;
    return { p_from: range.fromTs, p_to: range.toTs, p_kind: kind, p_status: status, p_q: q };
}

// GET /api/admin/finance/overview?from=&to=&bucket=day|week|month
export async function getFinanceOverview(req, res) {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ success: false, message: range.error });
    const bucket = BUCKETS.includes(req.query.bucket) ? req.query.bucket : "day";

    try {
        const [ts, pend] = await Promise.all([
            supabase.rpc("admin_finance_timeseries", { p_from: range.fromTs, p_to: range.toTs, p_bucket: bucket }),
            supabase.rpc("admin_finance_pending_by_seller"),
        ]);
        if (ts.error) throw ts.error;
        if (pend.error) throw pend.error;

        const series = (ts.data || []).map((r) => ({
            bucket: r.o_bucket,
            received: Number(r.o_received_paise) / 100, receivedCount: Number(r.o_received_count),
            topups: Number(r.o_topup_paise) / 100, topupsCount: Number(r.o_topup_count),
            refunds: Number(r.o_refunds_paise) / 100, refundsCount: Number(r.o_refunds_count),
            payouts: Number(r.o_payouts_amount), payoutsCount: Number(r.o_payouts_count),
        }));
        const sum = (k) => round2(series.reduce((a, r) => a + r[k], 0));
        const cnt = (k) => series.reduce((a, r) => a + r[k], 0);
        const totals = {
            received: sum("received"), receivedCount: cnt("receivedCount"),
            topups: sum("topups"), topupsCount: cnt("topupsCount"),
            refunds: sum("refunds"), refundsCount: cnt("refundsCount"),
            payouts: sum("payouts"), payoutsCount: cnt("payoutsCount"),
        };
        totals.net = round2(totals.received - totals.refunds - totals.payouts);

        const rows = pend.data || [];
        const psum = (k) => round2(rows.reduce((a, r) => a + Number(r[k] || 0), 0));
        const pcnt = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
        const pending = {
            held: psum("o_held_amount"), heldCount: pcnt("o_held_count"),
            disputed: psum("o_disputed_amount"), disputedCount: pcnt("o_disputed_count"),
            overdueCount: pcnt("o_overdue_count"), sellers: rows.length,
        };
        pending.total = round2(pending.held + pending.disputed);

        res.json({ success: true, range: { from: range.from, to: range.to }, bucket, series, totals, pending, generatedAt: new Date().toISOString() });
    } catch (e) { return fail(res, e, "overview"); }
}

// GET /api/admin/finance/pending-payouts
export async function getPendingPayouts(req, res) {
    const { data, error } = await supabase.rpc("admin_finance_pending_by_seller");
    if (error) return fail(res, error, "pending payouts");
    res.json({
        success: true,
        sellers: (data || []).map((r) => ({
            sellerId: r.o_seller_id, sellerName: r.o_seller_name || "Unknown seller",
            held: round2(r.o_held_amount), heldCount: Number(r.o_held_count),
            disputed: round2(r.o_disputed_amount), disputedCount: Number(r.o_disputed_count),
            nextRelease: r.o_next_release, overdueCount: Number(r.o_overdue_count),
        })),
    });
}

// GET /api/admin/finance/transactions?from=&to=&kind=&status=&q=&page=&pageSize=
export async function listFinanceTransactions(req, res) {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ success: false, message: range.error });
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 100);

    const { data, error } = await supabase.rpc("admin_finance_transactions", {
        ...txnArgs(req.query, range), p_limit: pageSize, p_offset: (page - 1) * pageSize,
    });
    if (error) return fail(res, error, "transactions");
    const rows = data || [];
    res.json({ success: true, page, pageSize, total: rows.length ? Number(rows[0].o_total) : 0, transactions: rows.map(mapTxn) });
}

// GET /api/admin/finance/export.csv?from=&to=&kind=&status=&q=
const csvCell = (v) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula-injection guard
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export async function exportFinanceCsv(req, res) {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ success: false, message: range.error });
    const args = txnArgs(req.query, range);

    try {
        const rows = [];
        for (let offset = 0; offset < EXPORT_MAX; offset += EXPORT_PAGE) {
            const { data, error } = await supabase.rpc("admin_finance_transactions", { ...args, p_limit: EXPORT_PAGE, p_offset: offset });
            if (error) throw error;
            rows.push(...(data || []).map(mapTxn));
            if (!data || data.length < EXPORT_PAGE) break;
        }
        const ist = (iso) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
        const head = ["Time (IST)", "Time (UTC)", "Type", "Reference", "Order / cart", "Party", "Counterparty", "Amount (INR)", "Status", "Purpose / source", "Note", "Record id"];
        const lines = [head.join(",")].concat(rows.map((t) => [
            ist(t.at), new Date(t.at).toISOString(), t.kind, t.reference, t.orderNumber, t.party, t.counterparty, t.amount.toFixed(2), t.status, t.purpose, t.note, t.id,
        ].map(csvCell).join(",")));

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="transactions_${range.from}_to_${range.to}.csv"`);
        res.send("\uFEFF" + lines.join("\r\n"));
    } catch (e) { return fail(res, e, "export"); }
}

// GET /api/admin/finance/transactions/:kind/:id — full audit trail for one record
export async function getFinanceTransactionDetail(req, res) {
    const { kind, id } = req.params;
    if (!KINDS.includes(kind) || !UUID_RE.test(id)) return res.status(400).json({ success: false, message: "Invalid record." });

    const orderCols = "id, order_number, status, payment_status, payment_method, total_amount, settlement_status, settlement_seller_amount, delivered_at, dispute_window_ends_at, created_at";
    const eventCols = "id, source, hash_valid, response_code, payload, created_at";
    const SENSITIVE = ["tran_ctx", "redirect_uri"]; // gateway session data: never sent to the browser
    const strip = (row) => { if (row) SENSITIVE.forEach((k) => delete row[k]); return row; };

    try {
        let record = null, events = [], orders = [], related = [];

        if (kind === "payment_in" || kind === "wallet_topup") {
            const { data: a, error } = await supabase.from("payment_attempts").select("*").eq("id", id).maybeSingle();
            if (error) throw error;
            record = strip(a);
            if (a) {
                const [ev, rf, ord] = await Promise.all([
                    supabase.from("payment_events").select(eventCols).eq("attempt_id", id).order("created_at"),
                    supabase.from("payment_refunds").select("id, merchant_txn_no, amount_paise, status, attempts, created_at").eq("attempt_id", id),
                    a.order_id ? supabase.from("orders").select(orderCols).eq("id", a.order_id)
                        : a.order_group_id ? supabase.from("orders").select(orderCols).eq("order_group_id", a.order_group_id)
                            : Promise.resolve({ data: [] }),
                ]);
                events = ev.data || []; orders = ord.data || [];
                related = (rf.data || []).map((r) => ({ type: "Refund", reference: r.merchant_txn_no, amount: r.amount_paise / 100, status: r.status, at: r.created_at }));
            }
        } else if (kind === "refund_out") {
            const { data: r, error } = await supabase.from("payment_refunds").select("*").eq("id", id).maybeSingle();
            if (error) throw error;
            record = strip(r);
            if (r) {
                const [ev, ord, att] = await Promise.all([
                    supabase.from("payment_events").select(eventCols).eq("refund_id", id).order("created_at"),
                    r.order_id ? supabase.from("orders").select(orderCols).eq("id", r.order_id) : Promise.resolve({ data: [] }),
                    r.attempt_id ? supabase.from("payment_attempts").select("id, merchant_txn_no, amount_paise, status, completed_at").eq("id", r.attempt_id).maybeSingle() : Promise.resolve({ data: null }),
                ]);
                events = ev.data || []; orders = ord.data || [];
                if (att.data) related = [{ type: "Original payment", reference: att.data.merchant_txn_no, amount: att.data.amount_paise / 100, status: att.data.status, at: att.data.completed_at }];
            }
        } else if (kind === "seller_payout" || kind === "ledger_refund") {
            const { data: e, error } = await supabase.from("order_settlement_entries").select("*").eq("id", id).maybeSingle();
            if (error) throw error;
            record = e;
            if (e) {
                const [ord, oev] = await Promise.all([
                    supabase.from("orders").select(orderCols).eq("id", e.order_id),
                    supabase.from("order_events").select("*").eq("order_id", e.order_id).order("created_at").limit(100),
                ]);
                orders = ord.data || [];
                events = (oev.data || []).map((x) => ({ id: x.id, source: "order_event", response_code: x.event_type || x.status || null, created_at: x.created_at, payload: x }));
            }
        } else {
            const { data: w, error } = await supabase.from("wallet_payments").select("id, seller_id, amount, billing_period, utr, status, rejection_reason, created_at, verified_at").eq("id", id).maybeSingle();
            if (error) throw error;
            record = w;
        }

        if (!record) return res.status(404).json({ success: false, message: "Record not found." });
        res.json({ success: true, kind, record, events, orders, related });
    } catch (e) { return fail(res, e, "detail"); }
}

// GET /api/admin/finance/health — reconciliation checks. Every check should be 0 on a healthy system.
export async function getFinanceHealth(req, res) {
    const nowMs = Date.now();
    const ago = (min) => new Date(nowMs - min * 60000).toISOString();
    const LIMIT = 20;
    const attemptRow = (r) => ({ id: r.id, kind: "payment_in", reference: r.merchant_txn_no, amount: r.amount_paise / 100, at: r.completed_at || r.created_at, note: [r.status, r.apply_outcome, r.gateway_message].filter(Boolean).join(" | ") });

    const checks = [
        {
            key: "unapplied_payments", severity: "high", title: "Paid but not applied to an order",
            help: "The gateway confirmed the money but the order wasn't credited (amount mismatch or late payment). Money is held and needs review or refund.",
            run: () => supabase.from("payment_attempts").select("id, merchant_txn_no, amount_paise, status, apply_outcome, gateway_message, created_at, completed_at", { count: "exact" })
                .eq("status", "success").or("apply_outcome.is.null,apply_outcome.neq.applied").order("created_at", { ascending: false }).limit(LIMIT),
            map: attemptRow, amountOf: null,
        },
        {
            key: "needs_review", severity: "high", title: "Payments flagged for manual review",
            help: "The gateway answer could not be trusted or verified automatically.",
            run: () => supabase.from("payment_attempts").select("id, merchant_txn_no, amount_paise, status, apply_outcome, gateway_message, created_at, completed_at", { count: "exact" })
                .eq("status", "needs_review").order("created_at", { ascending: false }).limit(LIMIT),
            map: attemptRow,
        },
        {
            key: "stuck_attempts", severity: "medium", title: "Payments stuck past expiry",
            help: "Still waiting for a result more than 15 minutes after the session expired. The reconciler should have closed these.",
            run: () => supabase.from("payment_attempts").select("id, merchant_txn_no, amount_paise, status, apply_outcome, gateway_message, created_at, completed_at", { count: "exact" })
                .in("status", ["created", "initiated", "pending"]).lt("expires_at", ago(15)).order("created_at", { ascending: false }).limit(LIMIT),
            map: attemptRow,
        },
        {
            key: "open_refunds", severity: "medium", title: "Refunds not completed",
            help: "Queued, retrying or failed refunds older than 30 minutes. The buyer is still waiting for money.",
            run: () => supabase.from("payment_refunds").select("id, merchant_txn_no, amount_paise, status, attempts, created_at", { count: "exact" })
                .neq("status", "success").lt("created_at", ago(30)).order("created_at", { ascending: true }).limit(LIMIT),
            map: (r) => ({ id: r.id, kind: "refund_out", reference: r.merchant_txn_no, amount: r.amount_paise / 100, at: r.created_at, note: `${r.status} | attempts: ${r.attempts}` }),
        },
        {
            key: "overdue_payouts", severity: "medium", title: "Seller payouts overdue",
            help: "The dispute window ended more than 10 minutes ago but the payout is still held. The payout sweep runs every minute.",
            run: () => supabase.from("orders").select("id, order_number, settlement_seller_amount, dispute_window_ends_at", { count: "exact" })
                .eq("settlement_status", "held").lt("dispute_window_ends_at", ago(10)).order("dispute_window_ends_at", { ascending: true }).limit(LIMIT),
            map: (r) => ({ id: r.id, kind: null, reference: r.order_number, amount: Number(r.settlement_seller_amount) || 0, at: r.dispute_window_ends_at, note: "window ended, payout still held" }),
        },
    ];

    try {
        const results = await Promise.all(checks.map((c) => c.run()));
        const out = checks.map((c, i) => {
            if (results[i].error) throw results[i].error;
            return { key: c.key, severity: c.severity, title: c.title, help: c.help, count: results[i].count ?? (results[i].data || []).length, rows: (results[i].data || []).map(c.map) };
        });
        res.json({ success: true, checks: out, healthy: out.every((c) => c.count === 0), generatedAt: new Date().toISOString() });
    } catch (e) { return fail(res, e, "health"); }
}