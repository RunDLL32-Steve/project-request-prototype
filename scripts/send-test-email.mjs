// Local email test. NOTE: the STS corporate network blocks outbound SMTP, so this fails with
// ETIMEDOUT from a workstation. To test for real, invoke the deployed Lambda instead (see src/lambda.js):
//   aws lambda invoke --function-name <fn> --payload '{"selfTest":true}' out.json
import "dotenv/config";
import { config } from "../src/config.js";
import { createMailer, resolveRecipients, ready } from "../src/mailer.js";

if (config.notifyTransport !== "smtp" || !ready(config)) {
    console.error(
        "Email is not fully configured (NOTIFY_TRANSPORT=smtp, SMTP_HOST, SMTP_USER, WORKMAIL_PASSWORD) - nothing sent.",
    );
    process.exit(1);
}
console.log(
    `Sending [TEST] email to ${resolveRecipients(config).join(", ") || "(nobody - test mode with no recipient)"}`,
);
console.log("Result:", await createMailer(config).sendTest());
