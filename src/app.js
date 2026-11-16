import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuth } from "./auth.js";
import { FIELDS, FIELD_BY_KEY, SUBMITTER_KEYS, coerce } from "./schema.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

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
      scope: config.clientId ? `api://${config.clientId}/access_as_user` : null,
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
      if (errors.length) return res.status(400).json({ error: errors.join("; "), errors });
      values.submittedAt = new Date().toISOString();

      const row = await store.create(values);

      // Email is best-effort: the request is already saved, so a mail failure must not lose it.
      const onFail = (e) => log.error("Notification email failed for project", row.projectId, e.message);
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
  app.get("/api/admin/requests", auth.requireAdmin, async (req, res, next) => {
    try {
      res.json({ rows: await store.list() });
    } catch (e) {
      next(e);
    }
  });

  app.patch("/api/admin/requests/:id", auth.requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid Project ID" });
      const changes = {};
      for (const [key, raw] of Object.entries(req.body || {})) {
        const field = FIELD_BY_KEY[key];
        if (!field || field.readOnly) return res.status(400).json({ error: `Field not editable: ${key}` });
        const r = coerce(field, raw, { requireIfRequired: true });
        if (r.error) return res.status(400).json({ error: r.error });
        changes[key] = r.value;
      }
      if (changes.status === null) changes.status = "New";
      const row = await store.update(id, changes);
      if (!row) return res.status(404).json({ error: "Project not found" });
      res.json({ row });
    } catch (e) {
      next(e);
    }
  });

  // Per-admin preferences (currently: admin table column order), keyed by the signed-in user.
  app.get("/api/admin/prefs", auth.requireAdmin, async (req, res, next) => {
    try {
      const p = await store.getPrefs(req.user.id);
      res.json({ columnOrder: p?.columnOrder || null });
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
          order.every((k) => typeof k === "string" && FIELD_BY_KEY[k]);
        if (!ok) return res.status(400).json({ error: "columnOrder must be a list of unique, valid field keys (or null to reset)" });
      }
      await store.setPrefs(req.user.id, { columnOrder: order, email: req.user.email });
      res.json({ columnOrder: order });
    } catch (e) {
      next(e);
    }
  });

  app.use(express.static(publicDir));
  app.get("/admin", (req, res) => res.sendFile(path.join(publicDir, "admin.html")));

  app.use((err, req, res, next) => {
    log.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}
