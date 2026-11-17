// Notification email sent after a new request is saved (Amazon WorkMail over SMTP, nodemailer).
import nodemailer from "nodemailer";
import { FIELDS } from "./schema.js";

/** Subject + plain-text body: every field, one line per field. */
export function buildMessage(row) {
    const subject = `New Technology Project Request - ${row.executiveSponsor} - ${row.projectName}`;
    const fmt = (v) => (v === null || v === undefined ? "" : String(v));
    const body = FIELDS.filter(
        (f) => f.key !== "submittedAt" && f.key !== "isDeleted",
    )
        .map(
            (f) =>
                `${f.label}: ${fmt(row[f.key]).replace(/\s*\r?\n\s*/g, " ")}`,
        )
        .join("\n");
    return { subject, body };
}

/** Who actually receives the mail. In test mode: only the test recipient (empty = send nothing). */
export function resolveRecipients(config) {
    if (config.notifyTestMode)
        return config.notifyTestRecipient ? [config.notifyTestRecipient] : [];
    return config.notifyTo ? [config.notifyTo] : [];
}

/** A clearly labelled sample request used by the self-test. Not stored anywhere. */
export function sampleRow(config) {
    const row = Object.fromEntries(FIELDS.map((f) => [f.key, null]));
    return Object.assign(row, {
        projectId: 0,
        status: "New",
        requestDate: new Date().toISOString().slice(0, 10),
        projectName: "TEST - email notification check",
        executiveSponsor: "Test Sender",
        sponsorEmail: config.notifyTo,
        projectCategory: "Other",
        businessReason:
            "Test of the new-request notification email. No real request was created.",
        expectedBenefit: "n/a",
        estimatedAnnualBenefit: 0,
    });
}

// nodemailer's own timeouts do not reliably bound a dropped SYN (see the forecast app), so cap the
// whole operation as well.
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () =>
                reject(
                    Object.assign(
                        new Error(`${label} timed out after ${ms}ms`),
                        { code: "ETIMEDOUT" },
                    ),
                ),
            ms,
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function ready(config) {
    return (
        config.notifyTransport === "smtp" &&
        Boolean(config.smtpHost && config.smtpUser && config.smtpPassword)
    );
}

export function createMailer(config) {
    if (config.notifyTransport !== "smtp") {
        return {
            enabled: false,
            send: async () => ({ skipped: "disabled" }),
            sendTest: async () => ({ skipped: "disabled" }),
            verify: async () => ({ skipped: "disabled" }),
        };
    }
    let transport = null;
    const getTransport = () =>
        (transport ||= nodemailer.createTransport({
            host: config.smtpHost,
            port: config.smtpPort,
            secure: config.smtpPort === 465, // implicit TLS on 465 (WorkMail)
            auth: { user: config.smtpUser, pass: config.smtpPassword },
            connectionTimeout: config.notifySendTimeoutMs,
            greetingTimeout: config.notifySendTimeoutMs,
            socketTimeout: config.notifySendTimeoutMs * 2,
        }));
    const from = () => ({
        name: config.notifyFromName,
        address: config.notifyFrom || config.smtpUser,
    });

    async function deliver(row, { subjectPrefix = "" } = {}) {
        if (!ready(config)) return { skipped: "smtp not fully configured" };
        const to = resolveRecipients(config);
        if (!to.length)
            return {
                skipped:
                    "no recipient (test mode with no NOTIFY_TEST_RECIPIENT)",
            };
        const { subject, body } = buildMessage(row);
        await withTimeout(
            getTransport().sendMail({
                from: from(),
                to,
                subject: subjectPrefix + subject,
                text: body,
            }),
            config.notifySendTimeoutMs * 2,
            "SMTP send",
        );
        return { sent: true, to };
    }

    return {
        enabled: true,
        send: (row) => deliver(row),
        sendTest: () =>
            deliver(sampleRow(config), { subjectPrefix: "[TEST] " }),
        /** Connect + authenticate only; sends nothing. */
        async verify() {
            if (!ready(config)) return { skipped: "smtp not fully configured" };
            await withTimeout(
                getTransport().verify(),
                config.notifySendTimeoutMs * 2,
                "SMTP verify",
            );
            return {
                verified: true,
                host: config.smtpHost,
                user: config.smtpUser,
            };
        },
    };
}
