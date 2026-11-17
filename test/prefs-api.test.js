import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

const testConfig = {
    devAuth: true,
    isProduction: false,
    devUserName: "T",
    devUserEmail: "t@example.com",
    adminRole: "Admin",
    appEnv: "test",
};
const TEST_USER_ID = "t@example.com"; // the dev-auth user id is the lower-cased email
const prefsByUserId = {};
const inMemoryStore = {
    getPrefs: async (userId) => prefsByUserId[userId] || null,
    setPrefs: async (userId, prefs) =>
        (prefsByUserId[userId] = { ...prefs, userId }),
};
let server;
let baseUrl;
before(async () => {
    const app = createApp({
        config: testConfig,
        store: inMemoryStore,
        mailer: {},
        log: { error() {} },
    });
    await new Promise((resolve) => (server = app.listen(0, resolve)));
    baseUrl = "http://localhost:" + server.address().port;
});
after(() => server.close());

const callApi = (method, path, body) =>
    fetch(baseUrl + path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    }).then(async (response) => ({
        status: response.status,
        body: await response.json(),
    }));
const saveFilter = (name, filters = { status: { in: ["New"] } }) =>
    callApi("POST", "/api/admin/saved-filters", { name, filters, search: "" });
const getPrefs = async () => (await callApi("GET", "/api/admin/prefs")).body;

test("saves a filter and returns it from GET prefs", async () => {
    const saveResponse = await saveFilter("Open work");
    assert.equal(saveResponse.status, 200);
    const prefs = await getPrefs();
    assert.equal(prefs.savedFilters.length, 1);
    assert.equal(prefs.savedFilters[0].name, "Open work");
    assert.ok(prefs.savedFilters[0].id);
});

test("same name in a different case overwrites and keeps the id", async () => {
    const filterBeforeOverwrite = (await getPrefs()).savedFilters[0];
    const overwriteResponse = await saveFilter("OPEN WORK", {
        priority: { in: ["High"] },
    });
    assert.equal(overwriteResponse.body.savedFilters.length, 1);
    assert.equal(
        overwriteResponse.body.savedFilters[0].id,
        filterBeforeOverwrite.id,
    );
    assert.deepEqual(overwriteResponse.body.savedFilters[0].filters, {
        priority: { in: ["High"] },
    });
});

test("column order save keeps saved filters, and a filter save keeps column order", async () => {
    await callApi("PUT", "/api/admin/prefs", {
        columnOrder: ["projectId", "projectName"],
    });
    let prefs = await getPrefs();
    assert.equal(prefs.savedFilters.length, 1);
    await saveFilter("Another");
    prefs = await getPrefs();
    assert.deepEqual(prefs.columnOrder, ["projectId", "projectName"]);
    assert.equal(prefs.savedFilters.length, 2);
});

test("invalid body is rejected with 400", async () => {
    const response = await callApi("POST", "/api/admin/saved-filters", {
        name: "bad",
        filters: { bogus: { text: "x" } },
        search: "",
    });
    assert.equal(response.status, 400);
});

test("delete removes a filter; unknown id is 404", async () => {
    const savedFilters = (await getPrefs()).savedFilters;
    const deleteResponse = await callApi(
        "DELETE",
        "/api/admin/saved-filters/" + savedFilters[0].id,
    );
    assert.equal(deleteResponse.status, 200);
    assert.equal(
        deleteResponse.body.savedFilters.length,
        savedFilters.length - 1,
    );
    assert.equal(
        (
            await callApi(
                "DELETE",
                "/api/admin/saved-filters/" + savedFilters[0].id,
            )
        ).status,
        404,
    );
});

test("the 26th distinct filter is rejected", async () => {
    for (let n = 0; prefsByUserId[TEST_USER_ID].savedFilters.length < 25; n++)
        await saveFilter("fill " + n);
    assert.equal((await saveFilter("one too many")).status, 400);
});
