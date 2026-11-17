import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FIELD_BY_KEY } from "../src/schema.js";
import { createFileStore, createDdbStore, blankRow } from "../src/store.js";
import { buildMessage } from "../src/mailer.js";
import { isDeleted, assertEditable } from "../src/request-rules.js";

const actor = { name: "Dev User", email: "dev@example.com" };
const TABLES = { table: "Requests", prefsTable: "Prefs", auditTable: "Audit" };

test("Is Deleted? is an admin select that defaults to No", () => {
    const field = FIELD_BY_KEY.isDeleted;
    assert.equal(field.label, "Is Deleted?");
    assert.deepEqual(field.options, ["No", "Yes"]);
    assert.equal(field.defaultValue, "No");
    assert.equal(field.source, "admin");
    assert.equal(blankRow().isDeleted, "No");
});

test("a row with no isDeleted value counts as not deleted", () => {
    assert.equal(isDeleted({}), false);
    assert.equal(isDeleted({ isDeleted: null }), false);
    assert.equal(isDeleted({ isDeleted: "No" }), false);
    assert.equal(isDeleted({ isDeleted: "Yes" }), true);
});

test("assertEditable: deleted rows accept only an exact restore", () => {
    const deletedRow = { isDeleted: "Yes" };
    assert.doesNotThrow(() => assertEditable(deletedRow, { isDeleted: "No" }));
    for (const changes of [
        { priority: "High" },
        { isDeleted: "No", priority: "High" },
        { isDeleted: "Yes" },
    ]) {
        assert.throws(() => assertEditable(deletedRow, changes), {
            name: "RecordDeleted",
        });
    }
});

test("assertEditable: live rows accept any change, including deleting", () => {
    assert.doesNotThrow(() => assertEditable({}, { priority: "High" }));
    assert.doesNotThrow(() =>
        assertEditable({ isDeleted: "No" }, { isDeleted: "Yes" }),
    );
});

test("the new-request email never mentions Is Deleted?", () => {
    const row = { ...blankRow(), projectName: "Zebra", executiveSponsor: "X" };
    assert.doesNotMatch(buildMessage(row).body, /Is Deleted/);
});

// ---- file store ----
let store;
let storeDir;
beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "del-"));
    store = createFileStore(storeDir);
});
const auditActions = async () =>
    (await store.listAudit({ limit: 50 })).entries.map((e) => e.action);

test("file store: delete is audited as request.deleted, restore as request.restored", async () => {
    const row = await store.create({ projectName: "Zebra" }, actor);
    await store.update(row.projectId, { isDeleted: "Yes" }, actor);
    await store.update(row.projectId, { isDeleted: "No" }, actor);
    const actions = await auditActions();
    assert.ok(actions.includes("request.deleted"));
    assert.ok(actions.includes("request.restored"));
    assert.equal(actions.filter((a) => a === "request.updated").length, 0);
});

test("file store: a deleted row cannot be edited until restored", async () => {
    const row = await store.create({ projectName: "Zebra" }, actor);
    await store.update(row.projectId, { isDeleted: "Yes" }, actor);
    await assert.rejects(
        store.update(row.projectId, { priority: "High" }, actor),
        { name: "RecordDeleted" },
    );
    await assert.rejects(
        store.update(
            row.projectId,
            { isDeleted: "No", priority: "High" },
            actor,
        ),
        { name: "RecordDeleted" },
    );
    const restored = await store.update(
        row.projectId,
        { isDeleted: "No" },
        actor,
    );
    assert.equal(restored.isDeleted, "No");
    const edited = await store.update(
        row.projectId,
        { priority: "High" },
        actor,
    );
    assert.equal(edited.priority, "High");
});

// ---- DynamoDB store (fake client) ----
function fakeDoc(row) {
    const sent = [];
    return {
        sent,
        send: async (command) => {
            sent.push({ name: command.constructor.name, input: command.input });
            return command.constructor.name === "GetCommand"
                ? { Item: row }
                : {};
        },
    };
}
const transactions = (doc) =>
    doc.sent.filter((c) => c.name === "TransactWriteCommand");

test("ddb store: editing a deleted row is rejected before any write", async () => {
    const doc = fakeDoc({ projectId: 5, isDeleted: "Yes", priority: null });
    const ddb = createDdbStore({ ...TABLES, doc });
    await assert.rejects(ddb.update(5, { priority: "High" }, actor), {
        name: "RecordDeleted",
    });
    assert.equal(transactions(doc).length, 0);
});

test("ddb store: restoring a deleted row is one transaction audited as request.restored", async () => {
    const doc = fakeDoc({ projectId: 5, isDeleted: "Yes" });
    const ddb = createDdbStore({ ...TABLES, doc });
    await ddb.update(5, { isDeleted: "No" }, actor);
    const [transaction] = transactions(doc);
    const audit = transaction.input.TransactItems[1].Put.Item;
    assert.equal(audit.action, "request.restored");
});

test("ddb store: an edit is conditioned on the row still being not deleted", async () => {
    const doc = fakeDoc({ projectId: 5, isDeleted: "No", priority: null });
    const ddb = createDdbStore({ ...TABLES, doc });
    await ddb.update(5, { priority: "High" }, actor);
    const update = transactions(doc)[0].input.TransactItems[0].Update;
    const guardedAttributes = Object.values(update.ExpressionAttributeNames);
    assert.ok(
        guardedAttributes.includes("isDeleted"),
        "a concurrent delete must cancel the edit",
    );
    assert.ok(Object.values(update.ExpressionAttributeValues).includes("No"));
});

test("ddb store: a row with no isDeleted value is guarded as not-yet-set", async () => {
    const doc = fakeDoc({ projectId: 5, priority: null });
    const ddb = createDdbStore({ ...TABLES, doc });
    await ddb.update(5, { priority: "High" }, actor);
    const update = transactions(doc)[0].input.TransactItems[0].Update;
    assert.match(update.ConditionExpression, /attribute_not_exists\(#del\)/);
});

// ---- found by independent review ----
const cancelledWith = (code) =>
    Object.assign(new Error("cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: code }, { Code: "None" }],
    });

test("ddb store: a TransactionConflict (two writers at once) is retried, not a 500", async () => {
    let writes = 0;
    const doc = {
        sent: [],
        send: async (command) => {
            doc.sent.push(command.constructor.name);
            if (command.constructor.name === "GetCommand")
                return {
                    Item: { projectId: 5, isDeleted: "No", priority: null },
                };
            writes += 1;
            if (writes === 1) throw cancelledWith("TransactionConflict");
            return {};
        },
    };
    const ddb = createDdbStore({ ...TABLES, doc });
    const row = await ddb.update(5, { priority: "High" }, actor);
    assert.equal(row.priority, "High");
    assert.equal(writes, 2);
});

test("ddb store: if the row is deleted while an edit is retrying, the retry is refused", async () => {
    let reads = 0;
    const doc = {
        sent: [],
        send: async (command) => {
            doc.sent.push(command.constructor.name);
            if (command.constructor.name === "GetCommand") {
                reads += 1;
                return {
                    Item: {
                        projectId: 5,
                        isDeleted: reads === 1 ? "No" : "Yes",
                        priority: null,
                    },
                };
            }
            throw cancelledWith("ConditionalCheckFailed");
        },
    };
    const ddb = createDdbStore({ ...TABLES, doc });
    await assert.rejects(ddb.update(5, { priority: "High" }, actor), {
        name: "RecordDeleted",
    });
    assert.equal(
        doc.sent.filter((name) => name === "TransactWriteCommand").length,
        1,
    );
});

test("ddb store: a restore is conditioned on the row still being deleted", async () => {
    const doc = fakeDoc({ projectId: 5, isDeleted: "Yes" });
    const ddb = createDdbStore({ ...TABLES, doc });
    await ddb.update(5, { isDeleted: "No" }, actor);
    const update = transactions(doc)[0].input.TransactItems[0].Update;
    assert.equal(
        Object.values(update.ExpressionAttributeNames).includes("isDeleted"),
        true,
    );
    assert.match(update.ConditionExpression, /#k0 = :old0/);
    assert.equal(update.ExpressionAttributeValues[":old0"], "Yes");
    assert.equal(update.ExpressionAttributeValues[":new0"], "No");
});

test("ddb store: a row with no isDeleted value is audited as No -> Yes when deleted", async () => {
    const doc = fakeDoc({ projectId: 5, priority: null });
    const ddb = createDdbStore({ ...TABLES, doc });
    await ddb.update(5, { isDeleted: "Yes" }, actor);
    const audit = transactions(doc)[0].input.TransactItems[1].Put.Item;
    assert.equal(audit.action, "request.deleted");
    assert.equal(audit.oldValue, "No");
    assert.equal(audit.newValue, "Yes");
    const update = transactions(doc)[0].input.TransactItems[0].Update;
    assert.match(update.ConditionExpression, /attribute_not_exists\(#k0\)/);
});

test("ddb store: 'restoring' a row that was never deleted writes nothing", async () => {
    const doc = fakeDoc({ projectId: 5, priority: null });
    const ddb = createDdbStore({ ...TABLES, doc });
    await ddb.update(5, { isDeleted: "No" }, actor);
    assert.equal(transactions(doc).length, 0);
});

test("file store: 'restoring' a legacy row that has no isDeleted value logs nothing", async () => {
    const row = await store.create({ projectName: "Legacy" }, actor);
    const file = path.join(storeDir, "requests.json");
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    delete data.rows[0].isDeleted;
    await fs.writeFile(file, JSON.stringify(data));
    const before = (await store.listAudit({ limit: 50 })).entries.length;
    await store.update(row.projectId, { isDeleted: "No" }, actor);
    assert.equal((await store.listAudit({ limit: 50 })).entries.length, before);
});
