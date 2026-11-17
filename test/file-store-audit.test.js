import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFileStore } from "../src/store.js";
import { buildAuditEntry } from "../src/audit.js";

const actor = { name: "Dev User", email: "dev@example.com" };
let store;

beforeEach(async () => {
    store = createFileStore(await fs.mkdtemp(path.join(os.tmpdir(), "audit-")));
});

const allEntries = async () => (await store.listAudit({ limit: 200 })).entries;

test("create writes a request.created entry with the new Project ID", async () => {
    const row = await store.create({ projectName: "Zebra" }, actor);
    const [entry] = await allEntries();
    assert.equal(entry.action, "request.created");
    assert.equal(entry.projectId, row.projectId);
    assert.equal(entry.actorEmail, "dev@example.com");
});

test("update writes one entry per changed field with old and new values", async () => {
    const row = await store.create({ projectName: "Zebra" }, actor);
    await store.update(
        row.projectId,
        { projectName: "Giraffe", priority: "High" },
        actor,
    );
    const updates = (await allEntries()).filter(
        (e) => e.action === "request.updated",
    );
    assert.equal(updates.length, 2);
    const nameEntry = updates.find((e) => e.field === "projectName");
    assert.equal(nameEntry.oldValue, "Zebra");
    assert.equal(nameEntry.newValue, "Giraffe");
    assert.equal(nameEntry.projectId, row.projectId);
});

test("update with unchanged values writes no entry", async () => {
    const row = await store.create({ projectName: "Zebra" }, actor);
    const before = (await allEntries()).length;
    const result = await store.update(
        row.projectId,
        { projectName: "Zebra" },
        actor,
    );
    assert.equal(result.projectName, "Zebra");
    assert.equal((await allEntries()).length, before);
});

test("update of an unknown project returns null and writes nothing", async () => {
    assert.equal(await store.update(99, { priority: "High" }, actor), null);
    assert.equal((await allEntries()).length, 0);
});

test("setPrefs writes the given audit entries with the prefs", async () => {
    const entry = buildAuditEntry(actor, "savedFilter.saved", {
        details: { name: "Mine" },
    });
    await store.setPrefs("dev@example.com", { savedFilters: [] }, [entry]);
    assert.equal(
        (await store.getPrefs("dev@example.com")).userId,
        "dev@example.com",
    );
    assert.equal((await allEntries())[0].details.name, "Mine");
});

test("listAudit is newest first and pages with a cursor", async () => {
    for (let n = 1; n <= 5; n++) {
        await store.create({ projectName: "P" + n }, actor);
        await new Promise((resolve) => setTimeout(resolve, 3));
    }
    const first = await store.listAudit({ limit: 2 });
    assert.deepEqual(
        first.entries.map((e) => e.projectId),
        [5, 4],
    );
    assert.ok(first.nextCursor);
    const second = await store.listAudit({
        limit: 2,
        cursor: first.nextCursor,
    });
    assert.deepEqual(
        second.entries.map((e) => e.projectId),
        [3, 2],
    );
    const last = await store.listAudit({ limit: 2, cursor: second.nextCursor });
    assert.deepEqual(
        last.entries.map((e) => e.projectId),
        [1],
    );
    assert.equal(last.nextCursor, null);
});
