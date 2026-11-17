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
const silentLog = { error() {} };
const mailer = { enabled: false };
let server;
let baseUrl;

async function startServer(store) {
    const app = createApp({
        config: testConfig,
        store,
        mailer,
        log: silentLog,
    });
    await new Promise((resolve) => (server = app.listen(0, resolve)));
    baseUrl = "http://localhost:" + server.address().port;
}
before(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-api-"));
    await startServer(createFileStore(dir));
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
const auditEntries = async (query = "?limit=200") =>
    (await callApi("GET", "/api/admin/audit-log" + query)).body.entries;
const requestBody = (projectName) => ({
    requestDate: "2026-11-17",
    projectName,
    projectCategory: "Infrastructure",
    businessReason: "Reason",
    expectedBenefit: "Benefit",
    estimatedAnnualBenefit: 1000,
});

test("submitting a request is audited with the signed-in user", async () => {
    const created = await callApi(
        "POST",
        "/api/requests",
        requestBody("Zebra"),
    );
    assert.equal(created.status, 201);
    const entry = (await auditEntries())[0];
    assert.equal(entry.action, "request.created");
    assert.equal(entry.projectId, created.body.projectId);
    assert.equal(entry.actorName, "Dev User");
    assert.equal(entry.actorEmail, "dev@example.com");
    assert.match(entry.at, /Z$/, "stored in UTC");
});

test("editing a record audits one entry per changed field with old and new values", async () => {
    const { body } = await callApi(
        "POST",
        "/api/requests",
        requestBody("Edit me"),
    );
    const projectId = body.projectId;
    const patch = await callApi("PATCH", "/api/admin/requests/" + projectId, {
        priority: "High",
        projectName: "Edited",
    });
    assert.equal(patch.status, 200);
    const updates = (await auditEntries()).filter(
        (e) => e.action === "request.updated" && e.projectId === projectId,
    );
    assert.deepEqual(
        updates.map((e) => [e.field, e.oldValue, e.newValue]).sort(),
        [
            ["priority", null, "High"],
            ["projectName", "Edit me", "Edited"],
        ],
    );
});

test("saving a field with its current value writes no audit entry", async () => {
    const { body } = await callApi(
        "POST",
        "/api/requests",
        requestBody("Same"),
    );
    await callApi("PATCH", "/api/admin/requests/" + body.projectId, {
        projectName: "Same",
    });
    const updates = (await auditEntries()).filter(
        (e) => e.action === "request.updated" && e.projectId === body.projectId,
    );
    assert.equal(updates.length, 0);
});

test("saving and deleting a saved filter are audited", async () => {
    const saved = await callApi("POST", "/api/admin/saved-filters", {
        name: "Open work",
        filters: { status: { in: ["New"] } },
        search: "",
    });
    const filterId = saved.body.savedFilters[0].id;
    await callApi("POST", "/api/admin/saved-filters", {
        name: "open work",
        filters: { status: { in: ["In Work"] } },
        search: "",
    });
    await callApi("DELETE", "/api/admin/saved-filters/" + filterId);
    const filterEntries = (await auditEntries()).filter((e) =>
        e.action.startsWith("savedFilter."),
    );
    assert.deepEqual(
        filterEntries
            .map((e) => [
                e.action,
                e.details.name,
                e.details.replacedExisting ?? null,
            ])
            .reverse(),
        [
            ["savedFilter.saved", "Open work", false],
            ["savedFilter.saved", "open work", true],
            // The replace renamed the filter to "open work", so that is its name when deleted.
            ["savedFilter.deleted", "open work", null],
        ],
    );
});

test("a rejected save writes no audit entry", async () => {
    const before = (await auditEntries()).length;
    await callApi("POST", "/api/admin/saved-filters", {
        name: "",
        filters: {},
        search: "",
    });
    assert.equal((await auditEntries()).length, before);
});

test("the audit log is newest first and pages with a cursor", async () => {
    const all = await auditEntries();
    assert.ok(all.length >= 4);
    // Entries written in the same millisecond tie-break by id, so check times never increase.
    for (let n = 1; n < all.length; n++) {
        assert.ok(all[n - 1].at >= all[n].at, "newest first");
    }
    const first = await callApi("GET", "/api/admin/audit-log?limit=2");
    assert.equal(first.body.entries.length, 2);
    assert.ok(first.body.nextCursor);
    const second = await callApi(
        "GET",
        "/api/admin/audit-log?limit=2&cursor=" +
            encodeURIComponent(first.body.nextCursor),
    );
    assert.deepEqual(
        second.body.entries.map((e) => e.id),
        all.slice(2, 4).map((e) => e.id),
    );
    assert.equal("sortKey" in first.body.entries[0], false);
});

test("a malformed cursor or limit is a 400", async () => {
    assert.equal(
        (await callApi("GET", "/api/admin/audit-log?cursor=nonsense")).status,
        400,
    );
    assert.equal(
        (await callApi("GET", "/api/admin/audit-log?limit=0")).status,
        400,
    );
    assert.equal(
        (await callApi("GET", "/api/admin/audit-log?limit=abc")).status,
        400,
    );
});

test("an edit conflict is reported as 409", async () => {
    const conflictStore = {
        update: async () => {
            throw Object.assign(new Error("changed"), { name: "EditConflict" });
        },
    };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-conflict-"));
    const realStore = createFileStore(dir);
    const first = server;
    await startServer({ ...realStore, ...conflictStore });
    const result = await callApi("PATCH", "/api/admin/requests/1", {
        priority: "High",
    });
    assert.equal(result.status, 409);
    server.close();
    server = first;
});
