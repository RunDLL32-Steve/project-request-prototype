import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSavedFilter } from "../src/saved-filters.js";

const validBody = {
    name: " Mine ",
    filters: { status: { in: ["New"] } },
    search: "",
};

test("accepts a valid saved filter and trims the name", () => {
    const result = validateSavedFilter(validBody);
    assert.deepEqual(result.value, {
        name: "Mine",
        filters: { status: { in: ["New"] } },
        search: "",
    });
});

test("accepts text, range and search values", () => {
    const result = validateSavedFilter({
        name: "x",
        filters: {
            projectName: { text: "zebra" },
            approvedTotalBudget: { from: "100", to: "500" },
        },
        search: "abc",
    });
    assert.ok(result.value);
});

for (const [description, invalidBody] of [
    ["empty name", { ...validBody, name: "   " }],
    ["61-char name", { ...validBody, name: "a".repeat(61) }],
    ["unknown field key", { ...validBody, filters: { bogus: { text: "x" } } }],
    ["in not an array", { ...validBody, filters: { status: { in: "New" } } }],
    [
        "in with 51 items",
        { ...validBody, filters: { status: { in: Array(51).fill("a") } } },
    ],
    ["unexpected property", { ...validBody, filters: { status: { eq: "x" } } }],
    ["201-char search", { ...validBody, search: "a".repeat(201) }],
    ["not an object", null],
]) {
    test("rejects " + description, () =>
        assert.ok(validateSavedFilter(invalidBody).error),
    );
}
