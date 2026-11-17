import { lambdaSecrets } from "./secrets.js";

const env = process.env;

export const config = {
    port: Number(env.PORT || 3000),
    appEnv: env.APP_ENV || "local",
    isProduction: env.NODE_ENV === "production",
    devAuth: env.DEV_AUTH === "true",
    devUserName: env.DEV_USER_NAME || "Dev User",
    devUserEmail: env.DEV_USER_EMAIL || "dev.user@stsaviationgroup.com",
    tenantId: env.ENTRA_TENANT_ID,
    clientId: env.ENTRA_CLIENT_ID,
    adminRole: env.ENTRA_ADMIN_ROLE || "Admin",
    userRole: env.ENTRA_USER_ROLE || "Default",
    ddbTable: env.DDB_TABLE || null,
    prefsTable: env.PREFS_TABLE || null,
    region: env.AWS_REGION || "us-east-1",
    notifyTransport: (env.NOTIFY_TRANSPORT || "none").toLowerCase(),
    notifyTo: env.NOTIFY_TO || "steven.millard@stsaviationgroup.com",
    notifyFrom: env.NOTIFY_FROM,
    notifyFromName: env.NOTIFY_FROM_NAME || "STS Technology Project Request",
    // SAFETY RAIL: when true, every email goes ONLY to notifyTestRecipient (fail-closed if unset).
    notifyTestMode: String(env.NOTIFY_TEST_MODE || "").toLowerCase() === "true",
    notifyTestRecipient: (env.NOTIFY_TEST_RECIPIENT || "").trim() || null,
    // On Lambda the sandbox is frozen once the response is sent, so a background send would be lost:
    // there we wait for the email. Elsewhere (local dev) send in the background so a slow or blocked
    // mail server never delays the user.
    awaitEmail: Boolean(env.AWS_LAMBDA_FUNCTION_NAME),
    notifySendTimeoutMs: Number(env.NOTIFY_SEND_TIMEOUT_MS || 10000),
    smtpHost: env.SMTP_HOST,
    smtpPort: Number(env.SMTP_PORT || 465),
    smtpUser: env.SMTP_USER,
    // WorkMail personal access token (not the mailbox login password). Env first (local dev),
    // then Secrets Manager (deployed). SMTP_PASSWORD is accepted as an alias.
    smtpPassword:
        env.WORKMAIL_PASSWORD ||
        env.SMTP_PASSWORD ||
        lambdaSecrets.WORKMAIL_PASSWORD ||
        null,
};
