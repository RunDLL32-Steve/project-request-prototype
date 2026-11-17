// Audit log entries: who changed what, and when (UTC ISO timestamps).
import { randomUUID } from "node:crypto";

export const AUDIT_ACTIONS = {
    requestCreated: "request.created",
    requestUpdated: "request.updated",
    requestDeleted: "request.deleted",
    requestRestored: "request.restored",
    savedFilterSaved: "savedFilter.saved",
    savedFilterDeleted: "savedFilter.deleted",
};

/** Partition key shared by every audit item, so one descending Query lists them newest first. */
export const AUDIT_PARTITION = "AUDIT";

/**
 * @param {{ name: string, email: string }} actor the signed-in user making the change
 * @param {string} action one of AUDIT_ACTIONS
 * @param {object} fields action-specific details: projectId, field, oldValue, newValue, details
 */
export function buildAuditEntry(actor, action, fields = {}) {
    const id = randomUUID();
    const at = new Date().toISOString();
    return {
        id,
        at,
        sortKey: `${at}#${id}`,
        actorName: actor.name,
        actorEmail: actor.email,
        action,
        ...fields,
    };
}

/** The fields in `changes` whose value differs from `row` (a missing value and null count as equal). */
export function diffChanges(row, changes) {
    const diffs = [];
    for (const [field, newRaw] of Object.entries(changes)) {
        const oldValue = row[field] ?? null;
        const newValue = newRaw ?? null;
        if (!Object.is(oldValue, newValue)) {
            diffs.push({ field, oldValue, newValue });
        }
    }
    return diffs;
}

/**
 * The audit entry for one changed field of a request. Flipping Is Deleted? is logged as a
 * delete or a restore rather than as a generic edit.
 */
export function buildRequestChangeEntry(actor, projectId, diff) {
    let action = AUDIT_ACTIONS.requestUpdated;
    if (diff.field === "isDeleted") {
        action =
            diff.newValue === "Yes"
                ? AUDIT_ACTIONS.requestDeleted
                : AUDIT_ACTIONS.requestRestored;
    }
    return buildAuditEntry(actor, action, { projectId, ...diff });
}

/** An entry as sent to the browser: storage-only keys removed. */
export function toPublicEntry(item) {
    const { sortKey, auditPartition, ...publicEntry } = item;
    return publicEntry;
}

const SORT_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z#[0-9a-f-]{36}$/;

/** Opaque paging cursor for the audit list: the sortKey of the last entry already returned. */
export function encodeCursor(sortKey) {
    return Buffer.from(sortKey, "utf8").toString("base64url");
}

/** @returns {string|null} the sortKey, or null when no cursor was given. Throws InvalidCursor if malformed. */
export function decodeCursor(cursor) {
    if (cursor === null || cursor === undefined || cursor === "") return null;
    const sortKey =
        typeof cursor === "string"
            ? Buffer.from(cursor, "base64url").toString("utf8")
            : "";
    if (!SORT_KEY_PATTERN.test(sortKey)) {
        throw Object.assign(new Error("Invalid cursor"), {
            name: "InvalidCursor",
        });
    }
    return sortKey;
}
