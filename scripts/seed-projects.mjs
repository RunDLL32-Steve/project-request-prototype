// Seeds the requests table from the portfolio spreadsheet (converted by scripts/xlsx-to-json.py).
//
//   node scripts/seed-projects.mjs <projects.json>                              # DRY RUN: map + validate, write nothing
//   node scripts/seed-projects.mjs <projects.json> --apply --table <name> [--region us-east-1]
//
// Uses the standard AWS credential chain (sign in first with `aws login`). Safe to re-run: each row is written
// with attribute_not_exists(projectId), so existing projects are never overwritten, and the ID counter only
// ever moves up. Prints a validation report; --apply refuses to run if any value fails validation.
import fs from "node:fs";
import { FIELD_BY_KEY, coerce } from "../src/schema.js";
import { blankRow } from "../src/store.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const flag = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : null;
};
const apply = args.includes("--apply");
const table = flag("--table");
const region = flag("--region") || "us-east-1";
if (!file || (apply && !table)) {
    console.error(
        "usage: seed-projects.mjs <projects.json> [--apply --table <name> [--region r]]",
    );
    process.exit(2);
}

// spreadsheet header -> app field. Project ID is handled separately (IT-001 -> 1, kept as legacyId).
const COLUMNS = {
    Priority: "priority",
    "W/N": "workNew",
    Status: "status",
    "Project Name": "projectName",
    "Business Segment": "businessSegment",
    "Executive Sponsor": "executiveSponsor",
    "Internal Support": "internalSupport",
    "External Support": "externalSupport",
    "Project Category": "projectCategory",
    "Business Reason / Problem Statement": "businessReason",
    "Expected Benefit": "expectedBenefit",
    "Est. Annual $ Benefit or Savings": "estimatedAnnualBenefit",
    "Approved Total Budget ($)": "approvedTotalBudget",
    "Cost incurred to date (Software/Hardware)": "costToDateSoftwareHardware",
    "Cost incurred to date (External)": "costToDateExternal",
    "Hours incurred to date (Internal)": "hoursToDateInternal",
    "Cost incurred to date (Internal)": "costToDateInternal",
    "Total Cost Incurred to Date ($)": "totalCostToDate",
    "Est. CTC Software ($)": "estCtcSoftware",
    "Est. CoC Consulting($)": "estCocConsulting",
    "Est. CoC Internal ($)": "estCocInternal",
    "Total Est. Cost to Complete ($)": "totalEstCostToComplete",
    "Est Hours Remaining (External)": "estHoursRemainingExternal",
    "Est Hours Remaining (Internal)": "estHoursRemainingInternal",
    "Total Est. Cost at Completion ($)": "totalEstCostAtCompletion",
    "Budget Variance ($)": "budgetVariance",
    "Start Date": "startDate",
    "Est. Completion Date": "estCompletionDate",
    "Original Target Completion": "originalTargetCompletion",
    "Risk to Est. Completion Date": "riskToCompletionDate",
    "Overall Status": "overallStatus",
    "Key Risks / Issues": "keyRisksIssues",
};
// Spreadsheet wording that differs from the app's drop-down lists.
const VALUE_MAP = { projectCategory: { "Data & Analytics": "Data Analytics" } };

const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const rows = [];
const problems = [];
const cleaned = [];
const mapped = [];
const unknownColumns = new Set();

for (const rec of raw) {
    const m = /^IT-0*(\d+)$/.exec(String(rec["Project ID"]).trim());
    if (!m) {
        problems.push(`${rec["Project ID"]}: Project ID is not IT-nnn`);
        continue;
    }
    const id = Number(m[1]);
    const row = {
        ...blankRow(),
        projectId: id,
        legacyId: String(rec["Project ID"]).trim(),
        submittedAt: null,
    };
    row.status = null; // from the sheet; falls back to New below
    const notes = [];
    for (const [col, val] of Object.entries(rec)) {
        if (col === "Project ID") continue;
        const key = COLUMNS[col];
        if (!key) {
            unknownColumns.add(col);
            continue;
        }
        const field = FIELD_BY_KEY[key];
        const v = VALUE_MAP[key]?.[val] ?? val;
        const r = coerce(field, v);
        if (r.error) {
            if (["number", "money", "date"].includes(field.type)) {
                // Free text where the app needs a number/date (e.g. "NA", "Needs Scoped", "11/30/202"): don't guess.
                // Leave the field blank and keep the original text in Key Risks / Issues so nothing is lost.
                cleaned.push(
                    `${row.legacyId} (${rec["Project Name"] ?? "?"}): ${col} was ${JSON.stringify(val)} -> left blank, original text kept in Key Risks / Issues`,
                );
                notes.push(
                    `Import note: "${col}" in the source spreadsheet was "${val}".`,
                );
                continue;
            }
            problems.push(
                `${row.legacyId} (${rec["Project Name"] ?? "?"}): ${col}: ${JSON.stringify(val)} -> ${r.error}`,
            );
            continue;
        }
        row[key] = r.value;
    }
    row.status ??= "New";
    if (notes.length)
        row.keyRisksIssues = [row.keyRisksIssues, ...notes]
            .filter(Boolean)
            .join("\n");
    rows.push(row);
}
if (new Set(rows.map((r) => r.projectId)).size !== rows.length)
    problems.push("duplicate Project IDs after mapping");

const ids = rows.map((r) => r.projectId);
const maxId = Math.max(...ids);
console.log(
    `Mapped ${rows.length} projects (Project ID ${Math.min(...ids)}..${maxId}); counter will be set to ${maxId}.`,
);
if (unknownColumns.size)
    console.log(
        "Unmapped spreadsheet columns (ignored):",
        [...unknownColumns].join(", "),
    );
const count = (k) =>
    Object.entries(
        rows.reduce(
            (a, r) => (
                (a[r[k] ?? "(blank)"] = (a[r[k] ?? "(blank)"] || 0) + 1),
                a
            ),
            {},
        ),
    )
        .map(([k2, v]) => `${k2}=${v}`)
        .join(", ");
for (const k of [
    "status",
    "priority",
    "projectCategory",
    "businessSegment",
    "riskToCompletionDate",
])
    console.log(`  ${k}: ${count(k)}`);
console.log(
    `  blank sponsorEmail: ${rows.filter((r) => !r.sponsorEmail).length}, blank requestDate: ${rows.filter((r) => !r.requestDate).length} (not in the spreadsheet; left blank)`,
);
if (cleaned.length) {
    console.log(`\n${cleaned.length} cell(s) cleaned:`);
    cleaned.forEach((c) => console.log("  - " + c));
}
if (problems.length) {
    console.log(`\n${problems.length} VALIDATION PROBLEM(S):`);
    problems.forEach((p) => console.log("  - " + p));
} else console.log("\nNo validation problems.");

if (!apply) {
    console.log(
        "\nDry run only - nothing written. Re-run with --apply --table <name> to write.",
    );
    process.exit(problems.length ? 1 : 0);
}
if (problems.length) {
    console.error(
        "\nRefusing to --apply with validation problems. Fix the data or the mapping first.",
    );
    process.exit(1);
}

const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand } =
    await import("@aws-sdk/lib-dynamodb");
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
});

let written = 0,
    skipped = 0;
for (const row of rows) {
    try {
        await doc.send(
            new PutCommand({
                TableName: table,
                Item: row,
                ConditionExpression: "attribute_not_exists(projectId)",
            }),
        );
        written++;
    } catch (e) {
        if (e.name === "ConditionalCheckFailedException") {
            skipped++;
            console.log(
                `  skipped Project ${row.projectId} (${row.legacyId}): already exists`,
            );
        } else throw e;
    }
}
// Move the ID counter up to the highest seeded ID (never down), so new requests continue at maxId + 1.
const cur =
    (
        await doc.send(
            new GetCommand({ TableName: table, Key: { projectId: 0 } }),
        )
    ).Item?.lastId ?? 0;
if (cur < maxId)
    await doc.send(
        new UpdateCommand({
            TableName: table,
            Key: { projectId: 0 },
            UpdateExpression: "SET lastId = :v",
            ExpressionAttributeValues: { ":v": maxId },
        }),
    );
console.log(
    `\nWrote ${written} projects, skipped ${skipped}. Counter ${cur} -> ${Math.max(cur, maxId)}.`,
);
