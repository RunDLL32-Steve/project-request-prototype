import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { createFileStore } from "../src/store.js";

const testConfig = {
    devAuth: true,
    isProduction: false,
    devUserName: "Dev User",
    devUserEmail: "dev@example.com",
    adminRole: "Admin",
    appEnv: "test",
};
let server;
let baseUrl;
before(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "del-api-"));
    const app = createApp({
        config: testConfig,
        store: createFileStore(dir),
        mailer: { enabled: false },
        log: { error() {} },
    });
    await new Promise((resolve) => (server = app.listen(0, resolve)));
    baseUrl = "http://localhost:" + server.address().port;
});
after(() => server.close());

const callApi = (method, apiPath, body) =>
    fetch(baseUrl + apiPath, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    }).then(async (response) => ({
        status: response.status,
        body: await response.json(),
    }));
const submit = (projectName) =>
    callApi("POST", "/api/requests", {
        requestDate: "2026-11-17",
        projectName,
        projectCategory: "Infrastructure",
        businessReason: "Reason",
        expectedBenefit: "Benefit",
        estimatedAnnualBenefit: 1000,
    });
const patch = (projectId, changes) =>
    callApi("PATCH", "/api/admin/requests/" + projectId, changes);

test("a new request starts not deleted", async () => {
    const { body } = await submit("Fresh");
    const { body: list } = await callApi("GET", "/api/admin/requests");
    const row = list.rows.find((r) => r.projectId === body.projectId);
    assert.equal(row.isDeleted, "No");
});

test("delete, then edits are refused with 409, then restore re-enables editing", async () => {
    const { body } = await submit("Soft");
    const id = body.projectId;
    assert.equal((await patch(id, { isDeleted: "Yes" })).status, 200);

    const blocked = await patch(id, { priority: "High" });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /deleted/i);
    assert.equal(
        (await patch(id, { isDeleted: "No", priority: "High" })).status,
        409,
    );

    const restored = await patch(id, { isDeleted: "No" });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.row.isDeleted, "No");
    assert.equal((await patch(id, { priority: "High" })).status, 200);
});

test("deleting and restoring appear in the audit log with their own actions", async () => {
    const { body } = await submit("Audited");
    await patch(body.projectId, { isDeleted: "Yes" });
    await patch(body.projectId, { isDeleted: "No" });
    const { body: log } = await callApi("GET", "/api/admin/audit-log?limit=50");
    const actions = log.entries
        .filter((e) => e.projectId === body.projectId)
        .map((e) => e.action);
    assert.ok(actions.includes("request.deleted"));
    assert.ok(actions.includes("request.restored"));
});

test("Is Deleted? only accepts No or Yes", async () => {
    const { body } = await submit("Strict");
    assert.equal(
        (await patch(body.projectId, { isDeleted: "Maybe" })).status,
        400,
    );
});
