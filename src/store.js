// Storage for requests and per-admin preferences.
// DynamoDB when DDB_TABLE is set (production), otherwise local JSON files (local dev only).
// Project ID is an auto-incrementing integer (1,2,3,...) and the unique key.
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
} from "@aws-sdk/lib-dynamodb";
import { FIELDS } from "./schema.js";

// Reserved item (projectId 0) in the same table holding the last issued Project ID.
const COUNTER_ID = 0;

/** A new request row: every field present, hidden fields blank, status "New". */
export function blankRow() {
    const row = Object.fromEntries(FIELDS.map((f) => [f.key, null]));
    row.status = "New";
    return row;
}

function ddbStore(table, prefsTable, region) {
    const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
        marshallOptions: { removeUndefinedValues: true },
    });
    return {
        kind: "dynamodb",
        async create(values) {
            // Atomic counter => unique, sequential IDs even under concurrency.
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
            await doc.send(
                new PutCommand({
                    TableName: table,
                    Item: row,
                    ConditionExpression: "attribute_not_exists(projectId)",
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
        async update(projectId, changes) {
            const keys = Object.keys(changes);
            if (!keys.length) {
                const r = await doc.send(
                    new GetCommand({ TableName: table, Key: { projectId } }),
                );
                return r.Item || null;
            }
            try {
                const r = await doc.send(
                    new UpdateCommand({
                        TableName: table,
                        Key: { projectId },
                        UpdateExpression:
                            "SET " +
                            keys.map((k, i) => `#k${i} = :v${i}`).join(", "),
                        ExpressionAttributeNames: Object.fromEntries(
                            keys.map((k, i) => [`#k${i}`, k]),
                        ),
                        ExpressionAttributeValues: Object.fromEntries(
                            keys.map((k, i) => [`:v${i}`, changes[k]]),
                        ),
                        ConditionExpression: "attribute_exists(projectId)",
                        ReturnValues: "ALL_NEW",
                    }),
                );
                return r.Attributes;
            } catch (e) {
                if (e.name === "ConditionalCheckFailedException") return null;
                throw e;
            }
        },
        // Per-admin preferences: one item per user (partition key userId).
        async getPrefs(userId) {
            const r = await doc.send(
                new GetCommand({ TableName: prefsTable, Key: { userId } }),
            );
            return r.Item || null;
        },
        async setPrefs(userId, prefs) {
            const item = {
                ...prefs,
                userId,
                updatedAt: new Date().toISOString(),
            };
            await doc.send(
                new PutCommand({ TableName: prefsTable, Item: item }),
            );
            return item;
        },
    };
}

function fileStore(dir) {
    const file = path.join(dir, "requests.json");
    const prefsFile = path.join(dir, "prefs.json");
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
    return {
        kind: "file",
        create: (values) =>
            locked(async () => {
                const d = await readJson(file, { lastId: 0, rows: [] });
                d.lastId += 1;
                const row = { ...blankRow(), ...values, projectId: d.lastId };
                d.rows.push(row);
                await writeJson(file, d);
                return row;
            }),
        list: async () => (await readJson(file, { lastId: 0, rows: [] })).rows,
        update: (projectId, changes) =>
            locked(async () => {
                const d = await readJson(file, { lastId: 0, rows: [] });
                const row = d.rows.find((r) => r.projectId === projectId);
                if (!row) return null;
                Object.assign(row, changes);
                await writeJson(file, d);
                return row;
            }),
        getPrefs: async (userId) =>
            (await readJson(prefsFile, {}))[userId] || null,
        setPrefs: (userId, prefs) =>
            locked(async () => {
                const all = await readJson(prefsFile, {});
                all[userId] = {
                    ...prefs,
                    userId,
                    updatedAt: new Date().toISOString(),
                };
                await writeJson(prefsFile, all);
                return all[userId];
            }),
    };
}

export function createStore(config) {
    if (config.ddbTable) {
        if (!config.prefsTable)
            throw new Error("PREFS_TABLE must be set when DDB_TABLE is set");
        return ddbStore(config.ddbTable, config.prefsTable, config.region);
    }
    return fileStore(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data"),
    );
}
