import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

const config = { devAuth: true, isProduction: false, devUserName: "T", devUserEmail: "t@example.com", adminRole: "Admin", appEnv: "test" };
const memory = {};
const store = {
  getPrefs: async (id) => memory[id] || null,
  setPrefs: async (id, p) => (memory[id] = { ...p, userId: id }),
};
let server, base;
before(async () => {
  const app = createApp({ config, store, mailer: {}, log: { error() {} } });
  await new Promise((r) => (server = app.listen(0, r)));
  base = "http://localhost:" + server.address().port;
});
after(() => server.close());

const call = (method, path, body) =>
  fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const save = (name, filters = { status: { in: ["New"] } }) => call("POST", "/api/admin/saved-filters", { name, filters, search: "" });

test("saves a filter and returns it from GET prefs", async () => {
  const r = await save("Open work");
  assert.equal(r.status, 200);
  const p = await call("GET", "/api/admin/prefs");
  assert.equal(p.body.savedFilters.length, 1);
  assert.equal(p.body.savedFilters[0].name, "Open work");
  assert.ok(p.body.savedFilters[0].id);
});

test("same name in a different case overwrites and keeps the id", async () => {
  const before = (await call("GET", "/api/admin/prefs")).body.savedFilters[0];
  const r = await save("OPEN WORK", { priority: { in: ["High"] } });
  assert.equal(r.body.savedFilters.length, 1);
  assert.equal(r.body.savedFilters[0].id, before.id);
  assert.deepEqual(r.body.savedFilters[0].filters, { priority: { in: ["High"] } });
});

test("column order save keeps saved filters, and a filter save keeps column order", async () => {
  await call("PUT", "/api/admin/prefs", { columnOrder: ["projectId", "projectName"] });
  let p = (await call("GET", "/api/admin/prefs")).body;
  assert.equal(p.savedFilters.length, 1);
  await save("Another");
  p = (await call("GET", "/api/admin/prefs")).body;
  assert.deepEqual(p.columnOrder, ["projectId", "projectName"]);
  assert.equal(p.savedFilters.length, 2);
});

test("invalid body is rejected with 400", async () => {
  const r = await call("POST", "/api/admin/saved-filters", { name: "bad", filters: { bogus: { text: "x" } }, search: "" });
  assert.equal(r.status, 400);
});

test("delete removes a filter; unknown id is 404", async () => {
  const list = (await call("GET", "/api/admin/prefs")).body.savedFilters;
  const r = await call("DELETE", "/api/admin/saved-filters/" + list[0].id);
  assert.equal(r.status, 200);
  assert.equal(r.body.savedFilters.length, list.length - 1);
  assert.equal((await call("DELETE", "/api/admin/saved-filters/" + list[0].id)).status, 404);
});

test("the 26th distinct filter is rejected", async () => {
  for (let i = 0; memory["t@example.com"].savedFilters.length < 25; i++) await save("fill " + i);
  assert.equal((await save("one too many")).status, 400);
});
