// Validation for per-user saved admin-table filters.
import { FIELD_BY_KEY } from "./schema.js";

export const MAX_SAVED = 25;
const MAX_NAME_LENGTH = 60;
const MAX_TEXT_LENGTH = 200;
const MAX_VALUES_PER_FIELD = 50;
const MAX_RANGE_LENGTH = 50;

const isStringUpTo = (value, maxLength) =>
    typeof value === "string" && value.length <= maxLength;

/** A field's filter is one of: { text }, { in: [...] }, or { from, to } (either bound may be omitted). */
function isValidFieldFilter(fieldFilter) {
    if (
        !fieldFilter ||
        typeof fieldFilter !== "object" ||
        Array.isArray(fieldFilter)
    )
        return false;
    const properties = Object.keys(fieldFilter);
    if (!properties.length) return false;
    return properties.every((property) => {
        if (property === "text")
            return isStringUpTo(fieldFilter.text, MAX_TEXT_LENGTH);
        if (property === "in") {
            return (
                Array.isArray(fieldFilter.in) &&
                fieldFilter.in.length <= MAX_VALUES_PER_FIELD &&
                fieldFilter.in.every((value) =>
                    isStringUpTo(value, MAX_TEXT_LENGTH),
                )
            );
        }
        if (property === "from" || property === "to")
            return isStringUpTo(fieldFilter[property], MAX_RANGE_LENGTH);
        return false;
    });
}

/** @returns {{ value: { name: string, filters: object, search: string } } | { error: string }} */
export function validateSavedFilter(body) {
    if (!body || typeof body !== "object")
        return { error: "Request body is required" };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH)
        return { error: `Name must be 1-${MAX_NAME_LENGTH} characters` };
    const filters = body.filters ?? {};
    if (typeof filters !== "object" || Array.isArray(filters))
        return { error: "filters must be an object" };
    for (const [fieldKey, fieldFilter] of Object.entries(filters)) {
        if (!FIELD_BY_KEY[fieldKey])
            return { error: `Unknown filter field: ${fieldKey}` };
        if (!isValidFieldFilter(fieldFilter))
            return { error: `Invalid filter value for ${fieldKey}` };
    }
    const search = body.search ?? "";
    if (!isStringUpTo(search, MAX_TEXT_LENGTH))
        return {
            error: `search must be at most ${MAX_TEXT_LENGTH} characters`,
        };
    return { value: { name, filters, search } };
}
