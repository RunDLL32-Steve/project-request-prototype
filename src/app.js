import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createAuth } from "./auth.js";
import { AUDIT_ACTIONS, buildAuditEntry } from "./audit.js";
import { validateSavedFilter, MAX_SAVED } from "./saved-filters.js";
import { FIELDS, FIELD_BY_KEY, SUBMITTER_KEYS, coerce } from "./schema.js";

const publicDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "public",
);

const AUDIT_DEFAULT_PAGE_SIZE = 50;
const AUDIT_MAX_PAGE_SIZE = 200;

/** The signed-in user, as recorded on audit entries. */
const actorOf = (req) => ({ name: req.user.name, email: req.user.email });

export function createApp({ config, store, mailer, log = console }) {
    const app = express();
    const auth = createAuth(config);
    app.use(express.json({ limit: "100kb" }));

    app.get("/healthz", (req, res) => res.json({ ok: true }));

    // Public bootstrap for the browser MSAL client (non-secret IDs only).
    app.get("/api/auth/config", (req, res) =>
        res.json({
            env: config.appEnv,
            devAuth: auth.devAuth,
            tenantId: config.tenantId || null,
            clientId: config.clientId || null,
            scope: config.clientId
                ? `api://${config.clientId}/access_as_user`
                : null,
        }),
    );

    app.use("/api", auth.authenticate);

    app.get("/api/me", (req, res) => res.json(req.user));
    app.get("/api/schema", (req, res) => res.json({ fields: FIELDS }));

    // Submit a new request. Sponsor name/email always come from the SSO identity, never the client.
    app.post("/api/requests", async (req, res, next) => {
        try {
            const body = req.body || {};
            const values = {};
            const errors = [];
            for (const key of SUBMITTER_KEYS) {
                const field = FIELD_BY_KEY[key];
                let raw = body[key];
                if (key === "executiveSponsor") raw = req.user.name;
                if (key === "sponsorEmail") raw = req.user.email;
                const r = coerce(field, raw, { requireIfRequired: true });
                if (r.error) errors.push(r.error);
                else values[key] = r.value;
            }
            if (errors.length)
                return res
                    .status(400)
                    .json({ error: errors.join("; "), errors });
            values.submittedAt = new Date().toISOString();

            const row = await store.create(values, actorOf(req));

            // Email is best-effort: the request is already saved, so a mail failure must not lose it.
            const onFail = (e) =>
                log.error(
                    "Notification email failed for project",
                    row.projectId,
                    e.message,
                );
            let emailStatus = "disabled";
            if (config.awaitEmail) {
                try {
                    const r = await mailer.send(row);
                    emailStatus = r.sent ? "sent" : "disabled";
                } catch (e) {
                    emailStatus = "failed";
                    onFail(e);
                }
            } else if (mailer.enabled) {
                mailer.send(row).catch(onFail); // background: do not make the user wait on the mail server
                emailStatus = "queued";
            }
            res.status(201).json({ projectId: row.projectId, emailStatus });
        } catch (e) {
            next(e);
        }
    });

    // ---- Admin ----
    app.get(
        "/api/admin/requests",
        auth.requireAdmin,
        async (req, res, next) => {
            try {
                res.json({ rows: await store.list() });
            } catch (e) {
                next(e);
            }
        },
    );

    app.patch(
        "/api/admin/requests/:id",
        auth.requireAdmin,
        async (req, res, next) => {
            try {
                const id = Number(req.params.id);
                if (!Number.isInteger(id) || id < 1)
                    return res
                        .status(400)
                        .json({ error: "Invalid Project ID" });
                const changes = {};
                for (const [key, raw] of Object.entries(req.body || {})) {
                    const field = FIELD_BY_KEY[key];
                    if (!field || field.readOnly)
                        return res
                            .status(400)
                            .json({ error: `Field not editable: ${key}` });
                    const r = coerce(field, raw, { requireIfRequired: true });
                    if (r.error)
                        return res.status(400).json({ error: r.error });
                    changes[key] = r.value;
                }
                if (changes.status === null) changes.status = "New";
                const row = await store.update(id, changes, actorOf(req));
                if (!row)
                    return res.status(404).json({ error: "Project not found" });
                res.json({ row });
            } catch (e) {
                if (e.name === "EditConflict")
                    return res.status(409).json({
                        error: "This record was changed by someone else. Reload and try again.",
                    });
                next(e);
            }
        },
    );

    // Per-admin preferences (currently: admin table column order), keyed by the signed-in user.
    app.get("/api/admin/prefs", auth.requireAdmin, async (req, res, next) => {
        try {
            const p = await store.getPrefs(req.user.id);
            res.json({
                columnOrder: p?.columnOrder || null,
                savedFilters: p?.savedFilters || [],
            });
        } catch (e) {
            next(e);
        }
    });

    app.put("/api/admin/prefs", auth.requireAdmin, async (req, res, next) => {
        try {
            const order = (req.body || {}).columnOrder;
            if (order !== null) {
                const ok =
                    Array.isArray(order) &&
                    order.length <= FIELDS.length &&
                    new Set(order).size === order.length &&
                    order.every(
                        (k) => typeof k === "string" && FIELD_BY_KEY[k],
                    );
                if (!ok)
                    return res.status(400).json({
                        error: "columnOrder must be a list of unique, valid field keys (or null to reset)",
                    });
            }
            // Merge into the existing record so saved filters survive a column-order save.
            const existingPrefs = (await store.getPrefs(req.user.id)) || {};
            await store.setPrefs(req.user.id, {
                ...existingPrefs,
                columnOrder: order,
                email: req.user.email,
            });
            res.json({ columnOrder: order });
        } catch (e) {
            next(e);
        }
    });

    // Saved filters: named filter sets per admin, for quick switching between views.
    app.post(
        "/api/admin/saved-filters",
        auth.requireAdmin,
        async (req, res, next) => {
            try {
                const validation = validateSavedFilter(req.body);
                if (validation.error)
                    return res.status(400).json({ error: validation.error });
                const existingPrefs = (await store.getPrefs(req.user.id)) || {};
                const savedFilters = [...(existingPrefs.savedFilters || [])];
                const sameNameIndex = savedFilters.findIndex(
                    (savedFilter) =>
                        savedFilter.name.toLowerCase() ===
                        validation.value.name.toLowerCase(),
                );
                if (sameNameIndex >= 0)
                    savedFilters[sameNameIndex] = {
                        ...validation.value,
                        id: savedFilters[sameNameIndex].id,
                    };
                else if (savedFilters.length >= MAX_SAVED)
                    return res.status(400).json({
                        error: `You can save at most ${MAX_SAVED} filters; delete one first`,
                    });
                else
                    savedFilters.push({
                        ...validation.value,
                        id: randomUUID(),
                    });
                const auditEntry = buildAuditEntry(
                    actorOf(req),
                    AUDIT_ACTIONS.savedFilterSaved,
                    {
                        details: {
                            name: validation.value.name,
                            replacedExisting: sameNameIndex >= 0,
                        },
                    },
                );
                await store.setPrefs(
                    req.user.id,
                    { ...existingPrefs, savedFilters, email: req.user.email },
                    [auditEntry],
                );
                res.json({ savedFilters });
            } catch (e) {
                next(e);
            }
        },
    );

    app.delete(
        "/api/admin/saved-filters/:id",
        auth.requireAdmin,
        async (req, res, next) => {
            try {
                const existingPrefs = (await store.getPrefs(req.user.id)) || {};
                const currentFilters = existingPrefs.savedFilters || [];
                const remainingFilters = currentFilters.filter(
                    (savedFilter) => savedFilter.id !== req.params.id,
                );
                if (remainingFilters.length === currentFilters.length)
                    return res
                        .status(404)
                        .json({ error: "Saved filter not found" });
                const deletedFilter = currentFilters.find(
                    (savedFilter) => savedFilter.id === req.params.id,
                );
                const auditEntry = buildAuditEntry(
                    actorOf(req),
                    AUDIT_ACTIONS.savedFilterDeleted,
                    { details: { name: deletedFilter.name } },
                );
                await store.setPrefs(
                    req.user.id,
                    {
                        ...existingPrefs,
                        savedFilters: remainingFilters,
                        email: req.user.email,
                    },
                    [auditEntry],
                );
                res.json({ savedFilters: remainingFilters });
            } catch (e) {
                next(e);
            }
        },
    );

    // Audit log: every save, edit and delete with who made it and when (UTC), newest first.
    app.get(
        "/api/admin/audit-log",
        auth.requireAdmin,
        async (req, res, next) => {
            try {
                const limit =
                    req.query.limit === undefined
                        ? AUDIT_DEFAULT_PAGE_SIZE
                        : Number(req.query.limit);
                if (
                    !Number.isInteger(limit) ||
                    limit < 1 ||
                    limit > AUDIT_MAX_PAGE_SIZE
                )
                    return res.status(400).json({
                        error: `limit must be a whole number from 1 to ${AUDIT_MAX_PAGE_SIZE}`,
                    });
                res.json(
                    await store.listAudit({
                        limit,
                        cursor: req.query.cursor ?? null,
                    }),
                );
            } catch (e) {
                if (e.name === "InvalidCursor")
                    return res.status(400).json({ error: "Invalid cursor" });
                next(e);
            }
        },
    );

    app.use(express.static(publicDir));
    app.get("/admin", (req, res) =>
        res.sendFile(path.join(publicDir, "admin.html")),
    );
    app.get("/audit-log", (req, res) =>
        res.sendFile(path.join(publicDir, "audit-log.html")),
    );

    app.use((err, req, res, next) => {
        log.error(err);
        res.status(500).json({ error: "Internal server error" });
    });
    return app;
}
