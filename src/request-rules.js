// Business rules about editing a request, shared by every store.
import { FIELDS } from "./schema.js";

/** A row with no isDeleted value (created before soft delete existed) is not deleted. */
export function isDeleted(row) {
    return row.isDeleted === "Yes";
}

/**
 * A deleted request is read-only until it is restored: the only accepted change is exactly
 * `{ isDeleted: "No" }`. Throws an error named RecordDeleted otherwise.
 */
export function assertEditable(row, changes) {
    if (!isDeleted(row)) return;
    const keys = Object.keys(changes);
    const isRestore =
        keys.length === 1 &&
        keys[0] === "isDeleted" &&
        changes.isDeleted === "No";
    if (!isRestore) {
        throw Object.assign(
            new Error("This request is deleted. Restore it before editing."),
            { name: "RecordDeleted" },
        );
    }
}

/**
 * The row as the app sees it: a blank value takes its field's defaultValue (a row saved before
 * Is Deleted? existed reads as "No"). Used to diff edits, so the audit log records "No -> Yes"
 * rather than "blank -> Yes", and re-saving a default value is not logged as a change.
 */
export function withDefaults(row) {
    const effective = { ...row };
    for (const field of FIELDS) {
        if (field.defaultValue === undefined) continue;
        const value = effective[field.key];
        if (value === null || value === undefined || value === "")
            effective[field.key] = field.defaultValue;
    }
    return effective;
}
