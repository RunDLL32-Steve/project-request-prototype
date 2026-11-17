import { test } from "node:test";
import assert from "node:assert/strict";
import { createDdbStore } from "../src/store.js";
import { buildAuditEntry, encodeCursor } from "../src/audit.js";

const actor = { name: "Dev User", email: "dev@example.com" };
const TABLES = { table: "Requests", prefsTable: "Prefs", auditTable: "Audit" };

/** A fake DynamoDB document client: records commands, answers from `respond(commandName, input)`. */
function fakeDoc(respond) {
    const sent = [];
    return {
        sent,
        send: async (command) => {
            const name = command.constructor.name;
            sent.push({ name, input: command.input });
            return respond(name, command.input, sent);
        },
    };
}

const cancelled = (code) =>
    Object.assign(new Error("cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: code }, { Code: "None" }],
    });

const existingRow = {
    projectId: 5,
    projectName: "Zebra",
    priority: "High",
    legacyId: null,
};

test("update sends ONE transaction: conditional row update plus an audit put per changed field", async () => {
    const doc = fakeDoc((name) =>
        name === "GetCommand" ? { Item: existingRow } : {},
    );
    const store = createDdbStore({ ...TABLES, doc });
    const row = await store.update(
        5,
        { projectName: "Giraffe", priority: "High" },
        actor,
    );
    assert.equal(row.projectName, "Giraffe");
    const transactions = doc.sent.filter(
        (c) => c.name === "TransactWriteCommand",
    );
    assert.equal(transactions.length, 1);
    const [rowUpdate, ...auditPuts] = transactions[0].input.TransactItems;
    assert.equal(rowUpdate.Update.TableName, "Requests");
    assert.match(
        rowUpdate.Update.ConditionExpression,
        /attribute_exists\(projectId\)/,
    );
    assert.ok(
        Object.values(rowUpdate.Update.ExpressionAttributeValues).includes(
            "Zebra",
        ),
        "old value is in the condition",
    );
    assert.equal(
        auditPuts.length,
        1,
        "priority did not change, so only projectName is audited",
    );
    assert.equal(auditPuts[0].Put.TableName, "Audit");
    assert.equal(auditPuts[0].Put.Item.auditPartition, "AUDIT");
    assert.equal(auditPuts[0].Put.Item.field, "projectName");
    assert.equal(auditPuts[0].Put.Item.oldValue, "Zebra");
    assert.equal(auditPuts[0].Put.Item.newValue, "Giraffe");
    assert.equal(auditPuts[0].Put.Item.actorEmail, "dev@example.com");
});

test("update with no real change writes nothing", async () => {
    const doc = fakeDoc(() => ({ Item: existingRow }));
    const store = createDdbStore({ ...TABLES, doc });
    const row = await store.update(5, { projectName: "Zebra" }, actor);
    assert.equal(row.projectName, "Zebra");
    assert.equal(
        doc.sent.filter((c) => c.name === "TransactWriteCommand").length,
        0,
    );
});

test("update of a missing project returns null", async () => {
    const doc = fakeDoc(() => ({}));
    const store = createDdbStore({ ...TABLES, doc });
    assert.equal(await store.update(99, { priority: "Low" }, actor), null);
});

test("update re-reads and retries when the row changed under it", async () => {
    let transactions = 0;
    const doc = fakeDoc((name) => {
        if (name === "GetCommand") return { Item: existingRow };
        transactions += 1;
        if (transactions === 1) throw cancelled("ConditionalCheckFailed");
        return {};
    });
    const store = createDdbStore({ ...TABLES, doc });
    const row = await store.update(5, { priority: "Low" }, actor);
    assert.equal(row.priority, "Low");
    assert.equal(doc.sent.filter((c) => c.name === "GetCommand").length, 2);
});

test("update gives up with EditConflict after 3 conflicting attempts", async () => {
    const doc = fakeDoc((name) => {
        if (name === "GetCommand") return { Item: existingRow };
        throw cancelled("ConditionalCheckFailed");
    });
    const store = createDdbStore({ ...TABLES, doc });
    await assert.rejects(store.update(5, { priority: "Low" }, actor), {
        name: "EditConflict",
    });
    assert.equal(
        doc.sent.filter((c) => c.name === "TransactWriteCommand").length,
        3,
    );
});

test("an audit write failure fails the save instead of being swallowed", async () => {
    const doc = fakeDoc((name) => {
        if (name === "GetCommand") return { Item: existingRow };
        throw Object.assign(new Error("audit table unavailable"), {
            name: "ResourceNotFoundException",
        });
    });
    const store = createDdbStore({ ...TABLES, doc });
    await assert.rejects(store.update(5, { priority: "Low" }, actor), {
        name: "ResourceNotFoundException",
    });
});

test("create increments the counter, then transacts the row and its audit entry", async () => {
    const doc = fakeDoc((name) =>
        name === "UpdateCommand" ? { Attributes: { lastId: 8 } } : {},
    );
    const store = createDdbStore({ ...TABLES, doc });
    const row = await store.create({ projectName: "Zebra" }, actor);
    assert.equal(row.projectId, 8);
    const [counter, transaction] = doc.sent;
    assert.equal(counter.name, "UpdateCommand");
    const [rowPut, auditPut] = transaction.input.TransactItems;
    assert.equal(rowPut.Put.TableName, "Requests");
    assert.equal(
        rowPut.Put.ConditionExpression,
        "attribute_not_exists(projectId)",
    );
    assert.equal(auditPut.Put.Item.action, "request.created");
    assert.equal(auditPut.Put.Item.projectId, 8);
});

test("setPrefs with audit entries is one transaction; without, a plain put", async () => {
    const doc = fakeDoc(() => ({}));
    const store = createDdbStore({ ...TABLES, doc });
    const entry = buildAuditEntry(actor, "savedFilter.saved", {
        details: { name: "Mine" },
    });
    await store.setPrefs("dev@example.com", { savedFilters: [] }, [entry]);
    await store.setPrefs("dev@example.com", { columnOrder: null });
    assert.equal(doc.sent[0].name, "TransactWriteCommand");
    assert.equal(doc.sent[0].input.TransactItems[0].Put.TableName, "Prefs");
    assert.equal(doc.sent[0].input.TransactItems[1].Put.TableName, "Audit");
    assert.equal(doc.sent[1].name, "PutCommand");
});

test("listAudit queries newest first and returns a cursor when more remain", async () => {
    const items = [3, 2, 1].map((n) => ({
        auditPartition: "AUDIT",
        sortKey: `2026-01-0${n}T00:00:00.000Z#aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
        id: String(n),
    }));
    const doc = fakeDoc(() => ({ Items: items }));
    const store = createDdbStore({ ...TABLES, doc });
    const page = await store.listAudit({ limit: 2 });
    const query = doc.sent[0].input;
    assert.equal(query.ScanIndexForward, false);
    assert.equal(query.Limit, 3);
    assert.deepEqual(
        page.entries.map((e) => e.id),
        ["3", "2"],
    );
    assert.equal("sortKey" in page.entries[0], false);
    assert.equal(page.nextCursor, encodeCursor(items[1].sortKey));
});

test("listAudit rejects a malformed cursor", async () => {
    const store = createDdbStore({ ...TABLES, doc: fakeDoc(() => ({})) });
    await assert.rejects(store.listAudit({ cursor: "not-a-real-cursor" }), {
        name: "InvalidCursor",
    });
});
