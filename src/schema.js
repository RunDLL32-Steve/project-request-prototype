// Single source of truth for the request fields. Used by the server (validation, email)
// and served to the browser (/api/schema) so the form and admin table never drift.

export const CATEGORIES = [
    "Infrastructure",
    "New System Implementation",
    "System Upgrade / Migration",
    "Integration",
    "Process Automation / RPA",
    "Data Analytics",
    "Security & Compliance",
    "Other",
];
export const PRIORITIES = ["High", "Medium", "Low"];
export const STATUSES = [
    "New",
    "Closed Not Needed",
    "Expanding",
    "Future",
    "In Work",
    "Maintain",
    "Complete",
];
export const RISKS = ["Green", "Yellow", "Red"];
export const SEGMENTS = [
    "MRO",
    "Parts Distribution",
    "Workforce Management",
    "Engineering",
    "ERP",
    "IT / Infrastructure",
    "Corporate / Shared Services",
    "Cross-Functional",
];
export const WORK_NEW = ["W", "N"];

// type: text | longtext | email | date | number | money | select
// source: "submitter" = visible on the public form; "admin" = hidden, admin-edited only.
export const FIELDS = [
    {
        key: "projectId",
        label: "Project ID",
        type: "number",
        source: "system",
        readOnly: true,
    },
    { key: "legacyId", label: "Legacy ID", type: "text", source: "admin" },
    {
        key: "requestDate",
        label: "Request Date",
        type: "date",
        source: "submitter",
        required: true,
    },
    {
        key: "projectName",
        label: "Project Name",
        type: "text",
        source: "submitter",
        required: true,
    },
    {
        key: "executiveSponsor",
        label: "Executive Sponsor",
        type: "text",
        source: "submitter",
        required: true,
    },
    {
        key: "sponsorEmail",
        label: "Sponsor Email",
        type: "email",
        source: "submitter",
        required: true,
    },
    {
        key: "projectCategory",
        label: "Project Category",
        type: "select",
        options: CATEGORIES,
        source: "submitter",
        required: true,
    },
    {
        key: "businessReason",
        label: "Business Reason / Problem Statement",
        type: "longtext",
        source: "submitter",
        required: true,
    },
    {
        key: "expectedBenefit",
        label: "Expected Benefit",
        type: "longtext",
        source: "submitter",
        required: true,
    },
    {
        key: "estimatedAnnualBenefit",
        label: "Estimated Annual $ Benefit or Savings",
        type: "money",
        source: "submitter",
        required: true,
    },
    {
        key: "priority",
        label: "Priority",
        type: "select",
        options: PRIORITIES,
        source: "admin",
    },
    {
        key: "status",
        label: "Status",
        type: "select",
        options: STATUSES,
        source: "admin",
    },
    {
        key: "businessSegment",
        label: "Business Segment",
        type: "select",
        options: SEGMENTS,
        source: "admin",
    },
    {
        key: "workNew",
        label: "W/N",
        type: "select",
        options: WORK_NEW,
        source: "admin",
    },
    {
        key: "internalSupport",
        label: "Internal Support",
        type: "text",
        source: "admin",
    },
    {
        key: "externalSupport",
        label: "External Support",
        type: "text",
        source: "admin",
    },
    {
        key: "approvedTotalBudget",
        label: "Approved Total Budget ($)",
        type: "money",
        source: "admin",
    },
    {
        key: "costToDateSoftwareHardware",
        label: "Cost incurred to date (Software/Hardware)",
        type: "money",
        source: "admin",
    },
    {
        key: "costToDateExternal",
        label: "Cost incurred to date (External)",
        type: "money",
        source: "admin",
    },
    {
        key: "hoursToDateInternal",
        label: "Hours incurred to date (Internal)",
        type: "number",
        source: "admin",
    },
    {
        key: "costToDateInternal",
        label: "Cost incurred to date (Internal)",
        type: "money",
        source: "admin",
    },
    {
        key: "totalCostToDate",
        label: "Total Cost incurred to date ($)",
        type: "money",
        source: "admin",
    },
    {
        key: "estCtcSoftware",
        label: "Est. CTC Software ($)",
        type: "money",
        source: "admin",
    },
    {
        key: "estCocConsulting",
        label: "Est. CoC Consulting ($)",
        type: "money",
        source: "admin",
    },
    {
        key: "estCocInternal",
        label: "Est. CoC Internal ($)",
        type: "money",
        source: "admin",
    },
    {
        key: "totalEstCostToComplete",
        label: "Total Est. Cost to Complete ($)",
        type: "money",
        source: "admin",
    },
    {
        key: "estHoursRemainingExternal",
        label: "Est. Hours Remaining (External)",
        type: "number",
        source: "admin",
    },
    {
        key: "estHoursRemainingInternal",
        label: "Est. Hours Remaining (Internal)",
        type: "number",
        source: "admin",
    },
    {
        key: "totalEstCostAtCompletion",
        label: "Total Est. Cost at Completion ($)",
        type: "money",
        source: "admin",
    },
    {
        key: "budgetVariance",
        label: "Budget Variance ($)",
        type: "money",
        source: "admin",
    },
    { key: "startDate", label: "Start Date", type: "date", source: "admin" },
    {
        key: "estCompletionDate",
        label: "Est. Completion Date",
        type: "date",
        source: "admin",
    },
    {
        key: "originalTargetCompletion",
        label: "Original Target Completion",
        type: "date",
        source: "admin",
    },
    {
        key: "riskToCompletionDate",
        label: "Risk to Est. Completion Date",
        type: "select",
        options: RISKS,
        source: "admin",
    },
    {
        key: "overallStatus",
        label: "Overall Status",
        type: "longtext",
        source: "admin",
    },
    {
        key: "keyRisksIssues",
        label: "Key Risks / Issues",
        type: "longtext",
        source: "admin",
    },
    {
        key: "submittedAt",
        label: "Submitted At",
        type: "text",
        source: "system",
        readOnly: true,
    },
];

export const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
export const SUBMITTER_KEYS = FIELDS.filter(
    (f) => f.source === "submitter",
).map((f) => f.key);
export const ADMIN_KEYS = FIELDS.filter((f) => f.source === "admin").map(
    (f) => f.key,
);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Coerce + validate one value. Returns { value } or { error }. Blank is allowed unless required. */
export function coerce(field, raw, { requireIfRequired = false } = {}) {
    const blank =
        raw === undefined ||
        raw === null ||
        (typeof raw === "string" && raw.trim() === "");
    if (blank) {
        if (requireIfRequired && field.required)
            return { error: `${field.label} is required` };
        return { value: null };
    }
    switch (field.type) {
        case "number":
        case "money": {
            const n =
                typeof raw === "number"
                    ? raw
                    : Number(String(raw).replace(/[$,\s]/g, ""));
            if (!Number.isFinite(n))
                return { error: `${field.label} must be a number` };
            return { value: n };
        }
        case "date": {
            const s = String(raw).trim();
            if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s)))
                return { error: `${field.label} must be a valid date` };
            return { value: s };
        }
        case "email": {
            const s = String(raw).trim();
            if (!EMAIL_RE.test(s))
                return { error: `${field.label} must be a valid email` };
            return { value: s };
        }
        case "select": {
            const s = String(raw).trim();
            if (!field.options.includes(s))
                return {
                    error: `${field.label} must be one of: ${field.options.join(", ")}`,
                };
            return { value: s };
        }
        default:
            return { value: String(raw).trim().slice(0, 5000) };
    }
}
