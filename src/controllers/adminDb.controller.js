// controllers/adminDb.controller.js
//
// Generic, schema-driven admin database controller. It does NOT hardcode
// table names or columns — everything comes from the live Postgres schema
// via the SQL functions in sql/001_admin_panel_core.sql. This means every
// table in the database is browsable/editable through one code path, and
// new tables you add later work automatically with zero backend changes.
//
// Uses the same `supabase` service-role client every other admin controller
// in this codebase already uses, so it bypasses RLS exactly like the rest
// of the admin API does — access control lives entirely in requireAdmin.

import { supabase } from "../config/supabase.js";

// Never exposed through the generic panel, regardless of admin role —
// holds a decrypted secret at rest (see vault.decrypted_secrets usage).
const PROTECTED_TABLES = new Set(["v_secret"]);

// These are managed by the DB itself (defaults / triggers) — stripped from
// any incoming update/create payload rather than trusted from the client.
const READONLY_ON_UPDATE = new Set(["id", "created_at"]);

function assertTableAllowed(table) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table || "")) {
        throw Object.assign(new Error("Invalid table name."), { status: 400 });
    }
    if (PROTECTED_TABLES.has(table)) {
        throw Object.assign(new Error("This table isn't editable from the admin panel."), { status: 403 });
    }
}

function handleGuard(res, e) {
    res.status(e.status || 500).json({ success: false, message: e.message });
}

export async function listTables(req, res) {
    const { data, error } = await supabase.rpc("admin_list_tables");
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({
        success: true,
        tables: (data || []).filter((t) => !PROTECTED_TABLES.has(t.table_name)),
    });
}

export async function getTableSchema(req, res) {
    const { table } = req.params;
    try { assertTableAllowed(table); } catch (e) { return handleGuard(res, e); }

    const [{ data: columns, error: colErr }, { data: incomingFks, error: fkErr }] = await Promise.all([
        supabase.rpc("admin_table_columns", { p_table: table }),
        supabase.rpc("admin_incoming_fks", { p_table: table }),
    ]);
    if (colErr) return res.status(500).json({ success: false, message: colErr.message });
    if (fkErr) return res.status(500).json({ success: false, message: fkErr.message });

    res.json({ success: true, columns: columns || [], incomingFks: incomingFks || [] });
}

export async function listRows(req, res) {
    const { table } = req.params;
    try { assertTableAllowed(table); } catch (e) { return handleGuard(res, e); }

    const { page = "0", pageSize = "50", sortBy, sortDir = "asc" } = req.query;
    const from = Math.max(0, Number(page)) * Number(pageSize);
    const to = from + Number(pageSize) - 1;

    let query = supabase.from(table).select("*", { count: "exact" }).range(from, to);
    if (sortBy) query = query.order(sortBy, { ascending: sortDir !== "desc" });

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, rows: data, total: count });
}

export async function getRow(req, res) {
    const { table, id } = req.params;
    try { assertTableAllowed(table); } catch (e) { return handleGuard(res, e); }
    const { pk = "id" } = req.query;

    const { data, error } = await supabase.from(table).select("*").eq(pk, id).maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Row not found." });

    const { data: dependents } = await supabase.rpc("admin_row_dependents", { p_table: table, p_pk_value: String(id) });
    res.json({ success: true, row: data, dependents: dependents || [] });
}

export async function createRow(req, res) {
    const { table } = req.params;
    try { assertTableAllowed(table); } catch (e) { return handleGuard(res, e); }

    const body = { ...(req.body || {}) };
    for (const col of READONLY_ON_UPDATE) delete body[col];

    const { data, error } = await supabase.from(table).insert(body).select().maybeSingle();
    if (error) return res.status(400).json({ success: false, message: error.message });
    res.status(201).json({ success: true, row: data });
}

export async function updateRow(req, res) {
    const { table, id } = req.params;
    try { assertTableAllowed(table); } catch (e) { return handleGuard(res, e); }
    const { pk = "id" } = req.query;

    const body = { ...(req.body || {}) };
    for (const col of READONLY_ON_UPDATE) delete body[col];
    if (!Object.keys(body).length) return res.status(400).json({ success: false, message: "No fields to update." });

    const { data, error } = await supabase.from(table).update(body).eq(pk, id).select().maybeSingle();
    if (error) return res.status(400).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: "Row not found." });
    res.json({ success: true, row: data });
}

export async function deleteRow(req, res) {
    const { table, id } = req.params;
    try { assertTableAllowed(table); } catch (e) { return handleGuard(res, e); }
    const { pk = "id", cascade } = req.query;

    if (cascade === "true") {
        const { data, error } = await supabase.rpc("admin_cascade_delete", {
            p_table: table, p_pk_column: pk, p_pk_value: String(id),
        });
        if (error) return res.status(500).json({ success: false, message: error.message });
        return res.json({ success: true, result: data });
    }

    const { error } = await supabase.from(table).delete().eq(pk, id);
    if (error) {
        // Postgres FK-violation code — this row is still referenced somewhere
        // with a NO ACTION/RESTRICT rule. Hand the frontend the dependents list
        // so it can offer a "force cascade delete" instead of a raw DB error.
        if (error.code === "23503") {
            const { data: dependents } = await supabase.rpc("admin_row_dependents", { p_table: table, p_pk_value: String(id) });
            return res.status(409).json({
                success: false,
                message: "This record is referenced by other records and can't be deleted on its own.",
                dependents: dependents || [],
                requiresCascade: true,
            });
        }
        return res.status(500).json({ success: false, message: error.message });
    }
    res.json({ success: true });
}

export async function getDependentsPreview(req, res) {
    const { table, id } = req.params;
    try { assertTableAllowed(table); } catch (e) { return handleGuard(res, e); }

    const { data, error } = await supabase.rpc("admin_row_dependents", { p_table: table, p_pk_value: String(id) });
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, dependents: data || [] });
}