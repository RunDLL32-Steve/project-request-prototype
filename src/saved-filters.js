// Validation for per-user saved admin-table filters.
import { FIELD_BY_KEY } from "./schema.js";

export const MAX_SAVED = 25;
const MAX_NAME = 60, MAX_TEXT = 200, MAX_IN = 50, MAX_RANGE = 50;

const isStr = (v, max) => typeof v === "string" && v.length <= max;

function validFilterValue(fv) {
  if (!fv || typeof fv !== "object" || Array.isArray(fv)) return false;
  const keys = Object.keys(fv);
  if (!keys.length) return false;
  return keys.every((k) => {
    if (k === "text") return isStr(fv.text, MAX_TEXT);
    if (k === "in") return Array.isArray(fv.in) && fv.in.length <= MAX_IN && fv.in.every((s) => isStr(s, MAX_TEXT));
    if (k === "from" || k === "to") return isStr(fv[k], MAX_RANGE);
    return false;
  });
}

/** @returns {{ value: { name: string, filters: object, search: string } } | { error: string }} */
export function validateSavedFilter(body) {
  if (!body || typeof body !== "object") return { error: "Request body is required" };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_NAME) return { error: `Name must be 1-${MAX_NAME} characters` };
  const filters = body.filters ?? {};
  if (typeof filters !== "object" || Array.isArray(filters)) return { error: "filters must be an object" };
  for (const [key, fv] of Object.entries(filters)) {
    if (!FIELD_BY_KEY[key]) return { error: `Unknown filter field: ${key}` };
    if (!validFilterValue(fv)) return { error: `Invalid filter value for ${key}` };
  }
  const search = body.search ?? "";
  if (!isStr(search, MAX_TEXT)) return { error: `search must be at most ${MAX_TEXT} characters` };
  return { value: { name, filters, search } };
}
