import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { createFileStore } from "../src/store.js";

// Two different signed-in users sharing ONE store (as in production): neither may see or
// change the other's saved filters or column order.
const configFor = (name, email) => ({
    devAuth: true,
    isProduction: false,
    devUserName: name,
    devUserEmail: email,
    adminRole: "Admin",
    appEnv: "test",
});

const servers = [];
let alice;
let bob;

async function startAs(store, name, email) {
    const app = createApp({
        config: configFor(name, email),
        store,
        mailer: { enabled: false },
        log: { error() {} },
    });
    let server;
    await new Promise((resolve) => (server = app.listen(0, resolve)));
    servers.push(server);
    const baseUrl = "http://localhost:" + server.address().port;
    return (method, apiPath, body) =>
        fetch(baseUrl + apiPath, {
            method,
            headers: { "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
        }).then(async (response) => ({
            status: response.status,
            body: await response.json(),
        }));
}

before(async () => {
    const store = createFileStore(
        await fs.mkdtemp(path.join(os.tmpdir(), "users-")),
    );
    alice = await startAs(store, "Alice", "alice@example.com");
    bob = await startAs(store, "Bob", "bob@example.com");
});
after(() => servers.forEach((server) => server.close()));

const saveFilter = (call, name, status) =>
    call("POST", "/api/admin/saved-filters", {
        name,
        filters: { status: { in: [status] } },
        search: "",
    });
const prefsOf = async (call) => (await call("GET", "/api/admin/prefs")).body;

test("a new user starts with no column order and no saved filters of their own", async () => {
    await alice("PUT", "/api/admin/prefs", {
        columnOrder: ["projectId", "projectName"],
    });
    await saveFilter(alice, "Alice view", "New");
    const bobPrefs = await prefsOf(bob);
    assert.equal(bobPrefs.columnOrder, null);
    assert.deepEqual(bobPrefs.savedFilters, []);
});

test("one user's column order and saved filters never change another's", async () => {
    await bob("PUT", "/api/admin/prefs", {
        columnOrder: ["projectId", "priority"],
    });
    await saveFilter(bob, "Bob view", "In Work");
    await saveFilter(bob, "Alice view", "Complete"); // same NAME as Alice's, different user

    const alicePrefs = await prefsOf(alice);
    assert.deepEqual(alicePrefs.columnOrder, ["projectId", "projectName"]);
    assert.equal(alicePrefs.savedFilters.length, 1);
    assert.deepEqual(alicePrefs.savedFilters[0].filters, {
        status: { in: ["New"] },
    });

    const bobPrefs = await prefsOf(bob);
    assert.deepEqual(bobPrefs.columnOrder, ["projectId", "priority"]);
    assert.equal(bobPrefs.savedFilters.length, 2);
});

test("a user cannot delete another user's saved filter, even knowing its id", async () => {
    const aliceFilterId = (await prefsOf(alice)).savedFilters[0].id;
    const attempt = await bob(
        "DELETE",
        "/api/admin/saved-filters/" + aliceFilterId,
    );
    assert.equal(attempt.status, 404);
    assert.equal((await prefsOf(alice)).savedFilters.length, 1);
});

test("resetting or deleting your own never touches the other user's", async () => {
    await alice("PUT", "/api/admin/prefs", { columnOrder: null });
    const bobAfterAliceReset = await prefsOf(bob);
    assert.deepEqual(bobAfterAliceReset.columnOrder, ["projectId", "priority"]);

    const aliceFilterId = (await prefsOf(alice)).savedFilters[0].id;
    await alice("DELETE", "/api/admin/saved-filters/" + aliceFilterId);
    assert.equal((await prefsOf(alice)).savedFilters.length, 0);
    assert.equal((await prefsOf(bob)).savedFilters.length, 2);
});
