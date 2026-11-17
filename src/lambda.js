// AWS Lambda entry. Two kinds of event:
//  - API Gateway HTTP API requests -> Express via serverless-http
//  - Direct invoke { "selfTest": "verify" | true } -> email transport self-test (no HTTP, needs IAM
//    lambda:InvokeFunction). Mirrors the forecast app's reminders-Lambda selfTest, because the
//    corporate network blocks outbound SMTP so a real send can only be exercised from AWS:
//      aws lambda invoke --function-name <fn> --payload '{"selfTest":"verify"}' out.json   # login check only
//      aws lambda invoke --function-name <fn> --payload '{"selfTest":true}'     out.json   # sends one [TEST] email
import serverless from "serverless-http";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { createStore } from "./store.js";
import { createMailer } from "./mailer.js";

const mailer = createMailer(config);
const http = serverless(
    createApp({ config, store: createStore(config), mailer }),
);

async function runSelfTest(event) {
    const base = {
        transport: config.notifyTransport,
        testMode: config.notifyTestMode,
        from: config.notifyFrom || config.smtpUser,
    };
    try {
        const result =
            event.selfTest === "verify"
                ? await mailer.verify()
                : await mailer.sendTest();
        return {
            ok: true,
            mode: event.selfTest === "verify" ? "verify" : "send",
            ...base,
            result,
        };
    } catch (e) {
        // Never include credentials in the output; the error code + message are enough to diagnose.
        return {
            ok: false,
            ...base,
            error: `${e.code || "ERROR"}: ${e.message}`,
        };
    }
}

export const handler = async (event, context) => {
    // API Gateway events always carry requestContext, so a web request can never trigger the self-test.
    if (
        event &&
        !event.requestContext &&
        Object.prototype.hasOwnProperty.call(event, "selfTest")
    ) {
        return runSelfTest(event);
    }
    return http(event, context);
};
