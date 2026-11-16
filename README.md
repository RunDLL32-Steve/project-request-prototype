# Technology Project Request

Intake form and admin table for new STS technology project requests (vendor systems, custom software,
integrations, process automation, data analytics).

- **`/` — request form.** Managers/executives fill in the visible fields. Executive Sponsor and Sponsor Email
  come from the Microsoft SSO sign-in and are set server-side (the browser cannot override them).
- **`/admin` — admin table.** Every field is a column and is editable inline (drop-downs for Priority, Status,
  Risk, Category). Each cell saves when you leave it. Sort by clicking a header; filter with the search box.
- **On submit:** the request is saved with the next auto-numbered Project ID (1, 2, 3, ...), `Status = New`,
  and all hidden fields blank; then a notification email is sent (see [Email](#email)).

## Stack

Node 18+ / Express, vanilla JS front end (no build step), Microsoft Entra ID SSO (MSAL, auth code + PKCE),
DynamoDB for storage. Deployed to AWS as one Lambda (`serverless-http`) behind an API Gateway HTTP API, via SAM.

```
public/        index.html (form), admin.html (table), common.js (MSAL + fetch), styles.css
src/schema.js  Field definitions + validation — single source of truth for form, admin table, API, email
src/app.js     Express routes          src/store.js   DynamoDB store (local JSON file fallback)
src/auth.js    Entra token validation  src/mailer.js  Notification email (SMTP)
src/server.js  Local server            src/lambda.js  Lambda handler
template.yaml  SAM template (DynamoDB table + Lambda + HTTP API)
```

To add or rename a field, edit `src/schema.js` only.

## Run locally

```bash
npm install
cp .env.example .env      # defaults are fine for local: DEV_AUTH=true, no DynamoDB, email off
npm start                 # http://localhost:3000   (admin: http://localhost:3000/admin)
```

- **Sign-in is faked locally** (`DEV_AUTH=true`): you are `DEV_USER_NAME` / `DEV_USER_EMAIL`, and you are always an admin. This bypass is ignored whenever `NODE_ENV=production` (always set on Lambda).
- **Storage is a local file** (`data/requests.json`, git-ignored) while `DDB_TABLE` is blank. Delete the file to reset.
  To develop against a real table instead, set `DDB_TABLE` and `AWS_REGION` and have AWS credentials available
  (e.g. `aws login` / a profile).
- **Email is off** while `NOTIFY_TRANSPORT=none`.
- `npm run dev` restarts on file changes.

## Deploy to AWS

Non-prod first. Prod is the same template with `Environment=prod`.

### 1. Entra setup (one app registration per environment)

Do this in the [Entra admin center](https://entra.microsoft.com) (needs Application Administrator or higher).
Create a separate registration for non-prod and prod.

**A. Register the app**
1. **Entra ID → App registrations → New registration.**
2. Name: `Technology Project Request (nonprod)`. Supported account types: **Accounts in this organizational
   directory only** (single tenant). Leave Redirect URI blank for now. **Register.**
3. On the **Overview** page copy the **Application (client) ID** and **Directory (tenant) ID**. They are the
   `EntraClientId` and `EntraTenantId` deploy parameters.

**B. Expose the API scope** (the browser requests an access token for this scope)
1. **Expose an API → Application ID URI → Add**; accept the default `api://<client-id>` and **Save**.
2. **Add a scope:** name `access_as_user`; who can consent: **Admins and users**; fill in the display
   name/description (e.g. "Access the Technology Request app as the signed-in user"); state **Enabled**; **Add scope**.

**C. Token version**
1. **Manifest** (Microsoft Graph app manifest): under `api`, set `"requestedAccessTokenVersion": 2`. **Save.**
   (In the older AAD Graph manifest format it is `accessTokenAcceptedVersion` at the top level.)

**D. Redirect URIs** (single-page application)
1. **Authentication → Add a platform → Single-page application.**
2. Add one URI per page. The app sends the page's own URL, so `/` and `/admin` are both needed:
   - `https://<api-id>.execute-api.<region>.amazonaws.com/`
   - `https://<api-id>.execute-api.<region>.amazonaws.com/admin`
   - optional, for testing real SSO locally: `http://localhost:3000/` and `http://localhost:3000/admin`
3. Leave implicit grant checkboxes **unchecked** (the app uses auth code + PKCE). **Configure / Save.**

You will not know the API URL until the first SAM deploy (step 2 below), so deploy first, then come back and add
the URIs from the `AppUrl` stack output.

**E. Pre-consent the scope** (so users never see a consent prompt)
1. **API permissions → Add a permission → My APIs →** this app **→ Delegated → `access_as_user` → Add.**
2. **Grant admin consent for <tenant>** and confirm. (`User.Read` is already there by default.)

**F. Create the app roles**
1. **App roles → Create app role**, twice:

   | Display name | Value (must match exactly) | Allowed member types | Description |
   |---|---|---|---|
   | Default | `Default` | Users/Groups | Can sign in and submit technology requests |
   | Admin | `Admin` | Users/Groups | Can use the admin area and edit all requests |

   Both enabled. The **Value** is what the app reads from the token (`ENTRA_USER_ROLE` / `ENTRA_ADMIN_ROLE`).

**G. Assign people to the roles** (this is how access is controlled)
1. **Entra ID → Enterprise applications →** open this app (same name) **→ Users and groups → Add user/group.**
2. Select the users (or a security group; group-to-role assignment needs Entra ID P1/P2) and the role:
   `Default` for everyone who may submit requests, `Admin` for admins. An admin does not also need `Default`.
3. **Properties → Assignment required? = Yes → Save.** Users without a role are then blocked by Microsoft at
   sign-in, and the server also rejects any signed-in user who holds neither role.
4. Role changes take effect on the user's next token: have them sign out and back in (or close the browser tab/session).

**H. Check it**
- A `Default` user sees the form but no Admin link; `/admin` shows an access error and the admin API returns 403.
- An `Admin` user sees the **Admin** link in the form header and can use `/admin`.
- A user with no role cannot sign in (blocked by assignment) or gets "You have not been granted access".

### 2. Deploy with SAM

Requires AWS credentials for the target account (`aws login` / profile) and the SAM CLI.

```bash
sam build
sam deploy --guided \
  --stack-name project-request-nonprod \
  --parameter-overrides Environment=nonprod EntraTenantId=<tenant-id> EntraClientId=<client-id>
```

`--guided` saves your answers to `samconfig.toml` so later deploys are just `sam build && sam deploy`.

> **Gotcha:** on an existing stack, `sam deploy` keeps each parameter's *previous* value unless you override it,
> not the template's new default. If you add or change a parameter default, pass it explicitly with
> `--parameter-overrides` (and `--save-params`), then confirm with `GetFunctionConfiguration`.

| Parameter | Default | Purpose |
|---|---|---|
| `Environment` | `nonprod` | `nonprod` or `prod`. Anything but `prod` shows a red environment banner on every page. |
| `EntraTenantId`, `EntraClientId` | required | Used to validate sign-in tokens. |
| `NotifyTo` | steven.millard@stsaviationgroup.com | Who gets the new-request email. |
| `NotifyTransport` | `smtp` | `none` or `smtp`. |
| `NotifyTestMode`, `NotifyTestRecipient` | `true`, steven.millard@... | **Safety rail:** while `true`, every email goes only to `NotifyTestRecipient`. Keep `true` outside prod. |
| `SmtpHost`, `SmtpUser` | WorkMail host, `otp-notifications@sts-aviation-group.awsapps.com` | SMTP server and sending mailbox. |
| `LambdaSecretsArn` | the forecast app's nonprod secret | Secret whose `WORKMAIL_PASSWORD` is the mailbox password. Read at runtime; never stored in the template or Lambda settings. |

What it creates: two DynamoDB tables (pay-per-request, encrypted, point-in-time recovery, **retained if the stack
is deleted**): requests (partition key `projectId`, Number) and per-admin preferences (partition key `userId`, String),
plus the Lambda, an HTTP API and a CloudFront distribution. The `AppUrl` output (CloudFront) is the site URL; use it for
the Entra redirect URIs.

### 3. Verify

1. Open `AppUrl` — you should be redirected to Microsoft sign-in, then see the form with your name/email filled in.
2. Submit a test request; the confirmation shows its Project ID.
3. Open `/admin` — the row should appear; edit a cell and reload to confirm it persisted.
4. Check Lambda logs in CloudWatch (`/aws/lambda/<stack>-AppFunction-...`) for errors.

## Data model

The table holds one row per request, keyed by `projectId`. Item `projectId = 0` is the ID counter and is hidden
from the admin list. Fields (in `src/schema.js`):

- **Submitted on the form:** Request Date, Project Name, Executive Sponsor, Sponsor Email, Project Category,
  Business Reason / Problem Statement, Expected Benefit, Estimated Annual $ Benefit or Savings (+ `submittedAt` timestamp).
- **Admin-only (blank on submit):** Priority (High/Medium/Low), Status (starts `New`; New, Closed Not Needed,
  Expanding, Future, In Work, Maintain, Complete), the budget/cost/hours fields, Start / Est. Completion /
  Original Target dates, Risk to Est. Completion Date (Green/Yellow/Red), Overall Status, Key Risks / Issues.

Cost, total and variance fields are plain editable values; nothing is auto-calculated.

## Email

After a request is saved, an email goes to `NOTIFY_TO`:

- **Subject:** `New Technology Project Request - <Executive Sponsor> - <Project Name>`
- **Body:** every field, one `Label: value` line per field.

Sent through the STS WorkMail mailbox over SMTP (port 465), the same mailbox the forecast app uses. A send failure is
logged but never loses the request.

- **Password:** the WorkMail personal access token. Locally it comes from `WORKMAIL_PASSWORD` in `.env`. Deployed, the
  Lambda reads `WORKMAIL_PASSWORD` from the Secrets Manager secret in `LambdaSecretsArn` at cold start (its role can read
  only that secret).
- **Test mode:** `NOTIFY_TEST_MODE=true` sends every email only to `NOTIFY_TEST_RECIPIENT`. It is on in non-prod.
- **The STS corporate network blocks outbound SMTP**, so sending from a workstation always times out. Test from AWS by
  invoking the deployed Lambda directly:

```bash
aws lambda invoke --function-name <AppFunction name> --cli-binary-format raw-in-base64-out \
  --payload '{"selfTest":"verify"}' out.json   # logs in to the mail server, sends nothing
aws lambda invoke --function-name <AppFunction name> --cli-binary-format raw-in-base64-out \
  --payload '{"selfTest":true}' out.json       # sends one [TEST] email to the test recipient
```

Web requests can never trigger the self-test; it needs permission to invoke the function.

## Configuration reference

See `.env.example` for all environment variables (`PORT`, `ENTRA_*`, `DEV_AUTH`, `DDB_TABLE`,
`AWS_REGION`, `PREFS_TABLE`, `NOTIFY_*`, `SMTP_*`, `WORKMAIL_PASSWORD`, `APP_ENV`).

## API

All `/api/*` routes need a valid Entra bearer token (except `GET /api/auth/config`, the sign-in bootstrap).

| Route | Who | Purpose |
|---|---|---|
| `GET /api/me`, `GET /api/schema` | any signed-in user | Current user; field definitions |
| `POST /api/requests` | any signed-in user | Submit a request |
| `GET /api/admin/requests` | admin | List all requests |
| `PATCH /api/admin/requests/:id` | admin | Update one or more fields of a request |
| `GET /healthz` | public | Liveness |

## Known gaps

- No automated tests yet (`npm test` runs the Node test runner but finds none).
- Admin edits overwrite the whole cell (last write wins); there is no change history.
- No delete/archive; set Status to `Closed Not Needed` instead.
