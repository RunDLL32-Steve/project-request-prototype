// Storage for requests, per-admin preferences and the audit log.
// DynamoDB when DDB_TABLE is set (production), otherwise local JSON files (local dev only).
// Project ID is an auto-incrementing integer (1,2,3,...) and the unique key.
// Every change is stored together with its audit entries (one transaction / one locked write),
// so a change never exists without its audit entry or the reverse.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient,
    PutCommand,
    UpdateCommand,
    GetCommand,
    ScanCommand,
    QueryCommand,
    TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { FIELDS } from "./schema.js";
import {
    AUDIT_ACTIONS,
    AUDIT_PARTITION,
    buildAuditEntry,
    decodeCursor,
    diffChanges,
    encodeCursor,
    toPublicEntry,
} from "./audit.js";

// Reserved item (projectId 0) in the same table holding the last issued Project ID.
const COUNTER_ID = 0;

// An edit re-reads the row and retries if someone else changed it in between.
const MAX_EDIT_ATTEMPTS = 3;

/** A new request row: every field present, hidden fields blank, status "New". */
export function blankRow() {
    const row = Object.fromEntries(FIELDS.map((f) => [f.key, null]));
    row.status = "New";
    return row;
}

const isTransactionCancelled = (error) =>
    error.name === "TransactionCanceledException";
const failedItsCondition = (error, itemIndex) =>
    error.CancellationReasons?.[itemIndex]?.Code === "ConditionalCheckFailed";

/** A Put of one audit entry into the audit table, for use inside a transaction. */
const auditPut = (auditTable, entry) => ({
    Put: {
        TableName: auditTable,
        Item: { auditPartition: AUDIT_PARTITION, ...entry },
    },
});

/** `doc` can be injected for tests. */
export function createDdbStore({
    table,
    prefsTable,
    auditTable,
    region,
    doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
        marshallOptions: { removeUndefinedValues: true },
    }),
}) {
    return {
        kind: "dynamodb",
        async create(values, actor) {
            // Atomic counter => unique, sequential IDs even under concurrency. A counter
            // value can't be read back inside a transaction, so it is incremented first
            // (a failure after this only leaves a gap in the Project IDs).
            const c = await doc.send(
                new UpdateCommand({
                    TableName: table,
                    Key: { projectId: COUNTER_ID },
                    UpdateExpression: "ADD lastId :one",
                    ExpressionAttributeValues: { ":one": 1 },
                    ReturnValues: "UPDATED_NEW",
                }),
            );
            const row = {
                ...blankRow(),
                ...values,
                projectId: c.Attributes.lastId,
            };
            const entry = buildAuditEntry(actor, AUDIT_ACTIONS.requestCreated, {
                projectId: row.projectId,
                details: { projectName: row.projectName ?? null },
            });
            await doc.send(
                new TransactWriteCommand({
                    TransactItems: [
                        {
                            Put: {
                                TableName: table,
                                Item: row,
                                ConditionExpression:
                                    "attribute_not_exists(projectId)",
                            },
                        },
                        auditPut(auditTable, entry),
                    ],
                }),
            );
            return row;
        },
        async list() {
            const items = [];
            let key;
            do {
                const r = await doc.send(
                    new ScanCommand({
                        TableName: table,
                        ExclusiveStartKey: key,
                    }),
                );
                items.push(...(r.Items || []));
                key = r.LastEvaluatedKey;
            } while (key);
            return items
                .filter((i) => i.projectId !== COUNTER_ID)
                .sort((a, b) => a.projectId - b.projectId);
        },
        async update(projectId, changes, actor) {
            for (let attempt = 1; attempt <= MAX_EDIT_ATTEMPTS; attempt++) {
                const read = await doc.send(
                    new GetCommand({
                        TableName: table,
                        Key: { projectId },
                        ConsistentRead: true,
                    }),
                );
                const row = read.Item;
                if (!row) return null;
                const diffs = diffChanges(row, changes);
                if (!diffs.length) return row;

                // Commit only if each changed field still holds the value we read, so the
                // old value in the audit entry is exactly what was replaced.
                const names = {};
                const values = {};
                const conditions = ["attribute_exists(projectId)"];
                const assignments = [];
                diffs.forEach(({ field, oldValue, newValue }, i) => {
                    names[`#k${i}`] = field;
                    values[`:new${i}`] = newValue;
                    assignments.push(`#k${i} = :new${i}`);
                    if (field in row) {
                        values[`:old${i}`] = oldValue;
                        conditions.push(`#k${i} = :old${i}`);
                    } else {
                        conditions.push(`attribute_not_exists(#k${i})`);
                    }
                });
                const entries = diffs.map((diff) =>
                    buildAuditEntry(actor, AUDIT_ACTIONS.requestUpdated, {
                        projectId,
                        ...diff,
                    }),
                );
                try {
                    await doc.send(
                        new TransactWriteCommand({
                            TransactItems: [
                                {
                                    Update: {
                                        TableName: table,
                                        Key: { projectId },
                                        UpdateExpression:
                                            "SET " + assignments.join(", "),
                                        ConditionExpression:
                                            conditions.join(" AND "),
                                        ExpressionAttributeNames: names,
                                        ExpressionAttributeValues: values,
                                    },
                                },
                                ...entries.map((entry) =>
                                    auditPut(auditTable, entry),
                                ),
                            ],
                        }),
                    );
                    return { ...row, ...changes };
                } catch (e) {
                    if (!(
                        isTransactionCancelled(e) && failedItsCondition(e, 0)
                    ))
                        throw e;
                }
            }
            throw Object.assign(
                new Error("This record was changed by someone else"),
                { name: "EditConflict" },
            );
        },
        // Per-admin preferences: one item per user (partition key userId).
        async getPrefs(userId) {
            const r = await doc.send(
                new GetCommand({ TableName: prefsTable, Key: { userId } }),
            );
            return r.Item || null;
        },
        async setPrefs(userId, prefs, auditEntries = []) {
            const item = {
                ...prefs,
                userId,
                updatedAt: new Date().toISOString(),
            };
            if (!auditEntries.length) {
                await doc.send(
                    new PutCommand({ TableName: prefsTable, Item: item }),
                );
                return item;
            }
            await doc.send(
                new TransactWriteCommand({
                    TransactItems: [
                        { Put: { TableName: prefsTable, Item: item } },
                        ...auditEntries.map((entry) =>
                            auditPut(auditTable, entry),
                        ),
                    ],
                }),
            );
            return item;
        },
        // Newest first, paged by an opaque cursor (see encodeCursor). Reads one extra
        // item to know whether another page exists.
        async listAudit({ limit = 50, cursor = null } = {}) {
            const startAfter = decodeCursor(cursor);
            const r = await doc.send(
                new QueryCommand({
                    TableName: auditTable,
                    KeyConditionExpression: "auditPartition = :partition",
                    ExpressionAttributeValues: {
                        ":partition": AUDIT_PARTITION,
                    },
                    ScanIndexForward: false,
                    Limit: limit + 1,
                    ExclusiveStartKey: startAfter
                        ? {
                              auditPartition: AUDIT_PARTITION,
                              sortKey: startAfter,
                          }
                        : undefined,
                }),
            );
            const items = r.Items || [];
            const page = items.slice(0, limit);
            return {
                entries: page.map(toPublicEntry),
                nextCursor:
                    items.length > limit
                        ? encodeCursor(page[page.length - 1].sortKey)
                        : null,
            };
        },
    };
}

export function createFileStore(dir) {
    const file = path.join(dir, "requests.json");
    const prefsFile = path.join(dir, "prefs.json");
    const auditFile = path.join(dir, "audit.json");
    let chain = Promise.resolve(); // serialize writes
    const readJson = async (f, fallback) => {
        try {
            return JSON.parse(await fs.readFile(f, "utf8"));
        } catch (e) {
            if (e.code === "ENOENT") return fallback;
            throw e;
        }
    };
    const writeJson = (f, d) =>
        fs
            .mkdir(dir, { recursive: true })
            .then(() => fs.writeFile(f, JSON.stringify(d, null, 2)));
    const locked = (fn) => (chain = chain.then(fn, fn));
    const appendAudit = async (entries) => {
        if (!entries.length) return;
        const all = await readJson(auditFile, []);
        await writeJson(auditFile, [...all, ...entries]);
    };
    return {
        kind: "file",
        create: (values, actor) =>
            locked(async () => {
                const d = await readJson(file, { lastId: 0, rows: [] });
                d.lastId += 1;
                const row = { ...blankRow(), ...values, projectId: d.lastId };
                d.rows.push(row);
                await writeJson(file, d);
                await appendAudit([
                    buildAuditEntry(actor, AUDIT_ACTIONS.requestCreated, {
                        projectId: row.projectId,
                        details: { projectName: row.projectName ?? null },
                    }),
                ]);
                return row;
            }),
        list: async () => (await readJson(file, { lastId: 0, rows: [] })).rows,
        update: (projectId, changes, actor) =>
            locked(async () => {
                const d = await readJson(file, { lastId: 0, rows: [] });
                const row = d.rows.find((r) => r.projectId === projectId);
                if (!row) return null;
                const diffs = diffChanges(row, changes);
                if (!diffs.length) return row;
                Object.assign(row, changes);
                await writeJson(file, d);
                await appendAudit(
                    diffs.map((diff) =>
                        buildAuditEntry(actor, AUDIT_ACTIONS.requestUpdated, {
                            projectId,
                            ...diff,
                        }),
                    ),
                );
                return row;
            }),
        getPrefs: async (userId) =>
            (await readJson(prefsFile, {}))[userId] || null,
        setPrefs: (userId, prefs, auditEntries = []) =>
            locked(async () => {
                const all = await readJson(prefsFile, {});
                all[userId] = {
                    ...prefs,
                    userId,
                    updatedAt: new Date().toISOString(),
                };
                await writeJson(prefsFile, all);
                await appendAudit(auditEntries);
                return all[userId];
            }),
        // Newest first, paged by an opaque cursor (see encodeCursor).
        listAudit: async ({ limit = 50, cursor = null } = {}) => {
            const startAfter = decodeCursor(cursor);
            const all = await readJson(auditFile, []);
            const newestFirst = all.sort((a, b) =>
                a.sortKey < b.sortKey ? 1 : -1,
            );
            const remaining = startAfter
                ? newestFirst.filter((entry) => entry.sortKey < startAfter)
                : newestFirst;
            const page = remaining.slice(0, limit);
            return {
                entries: page.map(toPublicEntry),
                nextCursor:
                    remaining.length > limit
                        ? encodeCursor(page[page.length - 1].sortKey)
                        : null,
            };
        },
    };
}

export function createStore(config) {
    if (config.ddbTable) {
        if (!config.prefsTable)
            throw new Error("PREFS_TABLE must be set when DDB_TABLE is set");
        if (!config.auditTable)
            throw new Error("AUDIT_TABLE must be set when DDB_TABLE is set");
        return createDdbStore({
            table: config.ddbTable,
            prefsTable: config.prefsTable,
            auditTable: config.auditTable,
            region: config.region,
        });
    }
    return createFileStore(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data"),
    );
}
