import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSavedFilter } from "../src/saved-filters.js";

const ok = { name: " Mine ", filters: { status: { in: ["New"] } }, search: "" };

test("accepts a valid saved filter and trims the name", () => {
  const r = validateSavedFilter(ok);
  assert.deepEqual(r.value, { name: "Mine", filters: { status: { in: ["New"] } }, search: "" });
});

test("accepts text, range and search values", () => {
  const r = validateSavedFilter({ name: "x", filters: { projectName: { text: "zebra" }, approvedTotalBudget: { from: "100", to: "500" } }, search: "abc" });
  assert.ok(r.value);
});

for (const [label, body] of [
  ["empty name", { ...ok, name: "   " }],
  ["61-char name", { ...ok, name: "a".repeat(61) }],
  ["unknown field key", { ...ok, filters: { bogus: { text: "x" } } }],
  ["in not an array", { ...ok, filters: { status: { in: "New" } } }],
  ["in with 51 items", { ...ok, filters: { status: { in: Array(51).fill("a") } } }],
  ["unexpected property", { ...ok, filters: { status: { eq: "x" } } }],
  ["201-char search", { ...ok, search: "a".repeat(201) }],
  ["not an object", null],
]) {
  test("rejects " + label, () => assert.ok(validateSavedFilter(body).error));
}
