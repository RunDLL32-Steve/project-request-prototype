import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuditEntry, diffChanges, toPublicEntry } from "../src/audit.js";

const actor = { name: "Dev User", email: "dev@example.com" };

test("buildAuditEntry stamps a unique id, a UTC ISO time and the actor", () => {
    const before = Date.now();
    const first = buildAuditEntry(actor, "request.created", { projectId: 7 });
    const second = buildAuditEntry(actor, "request.created", { projectId: 8 });
    assert.notEqual(first.id, second.id);
    assert.match(first.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(new Date(first.at).getTime() >= before);
    assert.equal(first.actorName, "Dev User");
    assert.equal(first.actorEmail, "dev@example.com");
    assert.equal(first.action, "request.created");
    assert.equal(first.projectId, 7);
    assert.equal(first.sortKey, `${first.at}#${first.id}`);
});

test("diffChanges returns only fields whose value actually changed", () => {
    const row = { projectName: "A", priority: "High", status: null };
    const diffs = diffChanges(row, {
        projectName: "A",
        priority: "Low",
        status: "New",
    });
    assert.deepEqual(diffs, [
        { field: "priority", oldValue: "High", newValue: "Low" },
        { field: "status", oldValue: null, newValue: "New" },
    ]);
});

test("diffChanges treats a missing value and null as equal", () => {
    assert.deepEqual(diffChanges({}, { legacyId: null }), []);
    assert.deepEqual(diffChanges({ legacyId: null }, { legacyId: null }), []);
});

test("diffChanges compares numbers by value and type", () => {
    assert.deepEqual(
        diffChanges({ approvedTotalBudget: 500 }, { approvedTotalBudget: 500 }),
        [],
    );
    assert.equal(
        diffChanges({ approvedTotalBudget: 500 }, { approvedTotalBudget: 600 })
            .length,
        1,
    );
});

test("toPublicEntry hides storage-only keys", () => {
    const entry = buildAuditEntry(actor, "savedFilter.saved", {
        details: { name: "x" },
    });
    const publicEntry = toPublicEntry({ ...entry, auditPartition: "AUDIT" });
    assert.equal("sortKey" in publicEntry, false);
    assert.equal("auditPartition" in publicEntry, false);
    assert.equal(publicEntry.id, entry.id);
});
