# Technology Project Request

Intake form and admin table for new STS technology project requests (vendor systems, custom software,
integrations, process automation, data analytics).

- **`/` — request form.** Managers/executives fill in the visible fields. Executive Sponsor and Sponsor Email
  come from the Microsoft SSO sign-in and are set server-side (the browser cannot override them).
- **`/admin` — admin table.** Every field is a column and is editable inline (drop-downs for Priority, Status,
  Risk, Category). Each cell saves when you leave it. Sort by clicking a header, drag headers to reorder columns
  (saved per admin), and narrow the table with the search box or the **Filters** panel: text "contains" boxes,
  date/number ranges, and multi-select dropdowns for the choice fields (tick several values to match any of them).
  **Saved filters** keeps named filter sets per admin for quick switching between views (nothing is applied on page
  load; up to 25 per admin; saving an existing name replaces it).
  Column order and saved filters belong to the signed-in admin only: one admin's changes never affect another's, and
  nobody can see or delete another admin's saved filters. (Rows per page and the light/dark theme are remembered per
  browser.) Running locally with dev auth, everyone is the same dev user, so they share one set.
  **Soft delete:** the trash button on a row (or **Delete** in the detail panel) hides a request without erasing it.
  The **Is Deleted?** filter defaults to **No**, so deleted requests are hidden until you tick **Yes**. A deleted
  request shows a red **DELETED** banner across the top of its detail panel and is read-only (greyed out in the grid)
  until you **Restore** it (the ↩ button or **Restore** in the panel). Requests are never hard-deleted and their
  Project IDs are never reused. Clear all returns the filters to that default (Is Deleted? = No).
- **`/audit-log` — audit log** (admin only, linked from the admin header). Every request submission, field edit
  (old → new value), request delete/restore, and saved-filter save/delete, with who made it and when. Stored in UTC, shown in your local
  time zone (hover a time for UTC). Newest first, 50 per page. Each change is written in the same DynamoDB
  transaction as its audit entry, so a request change is never saved without its audit entry (or the reverse). The log
  starts empty at deploy time (nothing earlier was recorded) and column-order changes are not logged.
- **On submit:** the request is saved with the next auto-numbered Project ID (1, 2, 3, ...), `Status = New`,
  and all hidden fields blank; then a notification email is sent (see [Email](#email)).

## Stack

Node 18+ / Express, vanilla JS front end (no build step), Microsoft Entra ID SSO (MSAL, auth code + PKCE),
DynamoDB for storage. Deployed to AWS via SAM as one Lambda (`serverless-http`) behind an API Gateway HTTP API and
a CloudFront distribution (caching disabled, so a deploy is live immediately — no invalidation needed).

```
public/        index.html (form), admin.html (table), audit-log.html, common.js (MSAL + fetch),
               datepicker.js, theme.js, styles.css
src/schema.js  Field definitions + validation — single source of truth for form, admin table, API, email
src/app.js     Express routes            src/store.js          Storage: DynamoDB (transactions) / local JSON files
src/audit.js   Audit entries + paging    src/saved-filters.js  Validation for saved admin filters
src/auth.js    Entra token validation    src/mailer.js         Notification email (SMTP)
src/server.js  Local server              src/lambda.js         Lambda handler
test/          node --test suites        scripts/              Spreadsheet seed tooling (see "Seeding")
template.yaml  SAM template (3 DynamoDB tables + Lambda + HTTP API + CloudFront)
samconfig.toml SAM deploy settings: default = nonprod, `prod` = production
```

To add or rename a field, edit `src/schema.js` only.

## Run locally

```bash
npm install
cp .env.example .env      # defaults are fine for local: DEV_AUTH=true, no DynamoDB, email off
npm start                 # http://localhost:3000   (admin: http://localhost:3000/admin)
```

- **Sign-in is faked locally** (`DEV_AUTH=true`): you are `DEV_USER_NAME` / `DEV_USER_EMAIL`, and you are always an admin. This bypass is ignored whenever `NODE_ENV=production` (always set on Lambda).
- **Storage is local files** in `data/` (git-ignored): `requests.json`, `prefs.json` (column order + saved filters) and
  `audit.json` (audit log), used while `DDB_TABLE` is blank. Delete them to reset.
  To develop against real tables instead, set `DDB_TABLE`, `PREFS_TABLE`, `AUDIT_TABLE` (all three are required
  together) and `AWS_REGION`, and have AWS credentials available (e.g. `aws login` / a profile).
- **Email is off** while `NOTIFY_TRANSPORT=none`.
- `npm run dev` restarts on file changes.

### Tests and formatting

```bash
npm test               # node --test: validation, saved filters, audit log, file store, DynamoDB store (fake client), API
npm run format         # Prettier (4 spaces, 80 columns, double quotes; see .prettierrc) — rewrites files
npm run format:check   # fails if any file is not formatted
```

The DynamoDB store tests use a fake client, so they check the exact transactions it would send but do not touch AWS;
verify a real deploy in non-prod (see [Verify](#3-verify)). Dev auth always makes you an admin, so the 403 path for
non-admins is not covered by the tests.

## Deploy to AWS

There are two environments, deployed from the same template and the same `samconfig.toml`. Always deploy to
non-prod first and verify there before prod.

| Environment | `samconfig.toml` section     | Stack name                | Credentials                                               | Notes                                                                                                           |
| ----------- | ---------------------------- | ------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| non-prod    | `default`                    | `project-request-nonprod` | an `aws login` session in the non-prod account            | Red "NON-PROD" banner on every page. `NotifyTestMode=true`: all email goes only to the test recipient.          |
| prod        | `prod` (`--config-env prod`) | `project-request-prod`    | an `aws login` session in the prod account (461280016391) | No banner. `NotifyTestMode=false`: email goes to `NotifyTo`. Asks you to review the change set before applying. |

Both use region `us-east-1`. Each environment is its own stack with its own DynamoDB tables, Lambda, API and
CloudFront URL, so data never mixes.

### 1. Entra setup (one app registration per environment)

Do this in the [Entra admin center](https://entra.microsoft.com) (needs Application Administrator or higher).
A separate registration per environment is recommended. Note that the checked-in `samconfig.toml` currently lists the
same `EntraClientId` in both the non-prod and prod sections: if you create a separate prod registration, update the
`prod` section. Whichever you use, every environment's `AppUrl` must be added as a redirect URI (step D).

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
2. Add one URI per page, for **each environment's `AppUrl`** (the CloudFront address users actually open — not the raw
   `ApiUrl`). The app sends the page's own URL, so `/` and `/admin` are both needed (`/audit-log` signs in through
   `/admin`, so it needs no URI of its own):
    - `https://<distribution>.cloudfront.net/`
    - `https://<distribution>.cloudfront.net/admin`
    - optional, for testing real SSO locally: `http://localhost:3000/` and `http://localhost:3000/admin`
3. Leave implicit grant checkboxes **unchecked** (the app uses auth code + PKCE). **Configure / Save.**

You will not know the CloudFront address until the first SAM deploy of that environment (step 2 below), so deploy
first, then come back and add the URIs from the `AppUrl` stack output.

**E. Pre-consent the scope** (so users never see a consent prompt)

1. **API permissions → Add a permission → My APIs →** this app **→ Delegated → `access_as_user` → Add.**
2. **Grant admin consent for <tenant>** and confirm. (`User.Read` is already there by default.)

**F. Create the app roles**

1. **App roles → Create app role**, twice:

    | Display name | Value (must match exactly) | Allowed member types | Description                                  |
    | ------------ | -------------------------- | -------------------- | -------------------------------------------- |
    | Default      | `Default`                  | Users/Groups         | Can sign in and submit technology requests   |
    | Admin        | `Admin`                    | Users/Groups         | Can use the admin area and edit all requests |

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

Requires the SAM CLI and AWS credentials for the account you are deploying to.

**Credentials.** Sign in with `aws login` to the account for that environment; SAM then uses that session.
No `--profile` option is needed or used in this project's commands.

> **Check the account before every deploy:** `aws sts get-caller-identity` (prod is `461280016391`).
> `samconfig.toml` does not pin an account, so SAM deploys to whichever account your session is signed in to. Running
> the non-prod config in the prod account (or the reverse) would create a stack in the wrong place. For prod,
> read the change set before confirming it. If your SAM CLI does not pick up the `aws login` session, update the SAM
> CLI.

**First deploy of a new environment** (creates the stack):

```bash
sam build
sam deploy --guided \
  --stack-name project-request-nonprod \
  --parameter-overrides Environment=nonprod EntraTenantId=<tenant-id> EntraClientId=<client-id>
```

`--guided` saves your answers to `samconfig.toml`.

**Routine deploys** (the stacks already exist and `samconfig.toml` has their settings):

```bash
# non-prod (the default config)
sam build && sam deploy

# prod — review the change set when prompted before confirming
sam build && sam deploy --config-env prod
```

Static pages are served by the Lambda too, so a deploy updates the pages, API and infrastructure together.
Nothing needs to be invalidated or copied separately.

**Upgrading an existing stack to the audit-log release:** the deploy creates one new table (`AuditLogTable`), adds
the `AUDIT_TABLE` setting to the Lambda and grants it `PutItem`/`Query` on that table. There are no new parameters
and no data to migrate. The audit log starts empty, so entries exist only for changes made after the deploy. Deploy
to non-prod, make an edit, and confirm it appears at `/audit-log` before deploying prod.

> **Gotcha:** on an existing stack, `sam deploy` keeps each parameter's _previous_ value unless you override it,
> not the template's new default. If you add or change a parameter default, pass it explicitly with
> `--parameter-overrides` (and `--save-params`), then confirm with `GetFunctionConfiguration`.

| Parameter                               | Default                                                           | Purpose                                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Environment`                           | `nonprod`                                                         | `nonprod` or `prod`. Anything but `prod` shows a red environment banner on every page.                                      |
| `EntraTenantId`, `EntraClientId`        | required                                                          | Used to validate sign-in tokens.                                                                                            |
| `NotifyTo`                              | rob.wire@stsaviationgroup.com                                     | Who gets the new-request email.                                                                                             |
| `NotifyTransport`                       | `smtp`                                                            | `none` or `smtp`.                                                                                                           |
| `NotifyTestMode`, `NotifyTestRecipient` | `true`, steven.millard@...                                        | **Safety rail:** while `true`, every email goes only to `NotifyTestRecipient`. Keep `true` outside prod.                    |
| `SmtpHost`, `SmtpUser`                  | WorkMail host, `otp-notifications@sts-aviation-group.awsapps.com` | SMTP server and sending mailbox.                                                                                            |
| `LambdaSecretsArn`                      | the forecast app's nonprod secret                                 | Secret whose `WORKMAIL_PASSWORD` is the mailbox password. Read at runtime; never stored in the template or Lambda settings. |

What it creates: three DynamoDB tables (pay-per-request, encrypted, point-in-time recovery, **retained if the stack
is deleted**): requests (partition key `projectId`, Number), per-admin preferences (partition key `userId`, String)
and the append-only audit log (partition key `auditPartition`, sort key `sortKey`; the Lambda may only `PutItem` and
`Query` it, never change or delete entries), plus the Lambda, an HTTP API and a CloudFront distribution. The `AppUrl`
output (CloudFront) is the site URL; use it for the Entra redirect URIs. Other outputs: `ApiUrl` (raw API Gateway
origin), `DistributionId`, `TableName`, `UserPrefsTableName`, `AuditLogTableName`.

### 3. Verify

Do this in non-prod after every deploy, and again in prod.

1. Open `AppUrl` — you should be redirected to Microsoft sign-in, then see the form with your name/email filled in.
2. Submit a test request; the confirmation shows its Project ID.
3. Open `/admin` — the row should appear; edit a cell and reload to confirm it persisted.
4. Open **Audit Log** from the admin header — the submission and your edit should be listed with your name and the
   time in your local time zone (hover the time for UTC).
5. Check Lambda logs in CloudWatch (`/aws/lambda/<stack>-AppFunction-...`) for errors. An audit-write failure makes
   the save fail (nothing is saved without its audit entry), so an unexpected 500 on save usually means the Lambda
   cannot reach the audit table: check `AUDIT_TABLE` and its IAM permission first.

### Seeding the requests table from the portfolio spreadsheet

One-off tooling used to load the existing IT project portfolio:

```bash
python scripts/xlsx-to-json.py <workbook.xlsx> projects.json          # needs openpyxl
node scripts/seed-projects.mjs projects.json                          # DRY RUN: map and validate, write nothing
node scripts/seed-projects.mjs projects.json --apply --table <requests table name>   # uses your `aws login` session
```

Re-running is safe: existing Project IDs are never overwritten. Seeding writes straight to the requests table, so
seeded rows have **no audit-log entries**.

## Data model

Three DynamoDB tables (local files with the same shapes in `data/`):

- **Requests** — one item per request, keyed by `projectId`. Item `projectId = 0` is the ID counter and is hidden
  from the admin list.
- **Preferences** — one item per admin, keyed by `userId` (their Entra object ID; the email when running locally
  with dev auth): `columnOrder` and `savedFilters`
  (`[{ id, name, filters, search }]`, where `filters` maps a field key to `{ text }`, `{ in: [...] }` or
  `{ from, to }`).
- **Audit log** — append-only. Partition key `auditPartition` (always `AUDIT`), sort key `sortKey`
  (`<UTC ISO time>#<id>`, so a descending query is newest first). Each entry has `id`, `at` (UTC ISO), `actorName`,
  `actorEmail`, `action` (`request.created`, `request.updated`, `request.deleted`, `request.restored`,
  `savedFilter.saved`, `savedFilter.deleted`) and
  `projectId` / `field` / `oldValue` / `newValue` / `details` as relevant. A request edit writes one entry per field
  that actually changed. Saving a value that is already there writes nothing.

Every change is written in one DynamoDB transaction together with its audit entries, so they succeed or fail
together. A creation increments the ID counter first (a failure after that only leaves a gap in the Project IDs).

`isDeleted` (label **Is Deleted?**, `No`/`Yes`) is the soft-delete flag on a request. A row with no value, such as
one created before the field existed, counts as `No`, so no migration is needed. It is never included in the
notification email.

Request fields (in `src/schema.js`):

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

See `.env.example` for all environment variables (`PORT`, `ENTRA_*`, `DEV_AUTH`, `DEV_USER_*`, `DDB_TABLE`,
`PREFS_TABLE`, `AUDIT_TABLE`, `AWS_REGION`, `NOTIFY_*`, `SMTP_*`, `WORKMAIL_PASSWORD`, `APP_ENV`). When deployed, the
SAM template sets the table names, `APP_ENV` and the Entra IDs for you. The three table variables must be set
together: the server refuses to start with `DDB_TABLE` set but `PREFS_TABLE` or `AUDIT_TABLE` missing.

## API

All `/api/*` routes need a valid Entra bearer token (except `GET /api/auth/config`, the sign-in bootstrap).

| Route                                 | Who                | Purpose                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/me`, `GET /api/schema`      | any signed-in user | Current user; field definitions                                                                                                                                                                                                  |
| `POST /api/requests`                  | any signed-in user | Submit a request                                                                                                                                                                                                                 |
| `GET /api/admin/requests`             | admin              | List all requests                                                                                                                                                                                                                |
| `PATCH /api/admin/requests/:id`       | admin              | Update fields of a request. `{ "isDeleted": "Yes" }` soft-deletes and `{ "isDeleted": "No" }` restores. `409` if it kept changing under you (reload and retry), or if the request is deleted (only an exact restore is accepted) |
| `GET`, `PUT /api/admin/prefs`         | admin              | Your column order (and, on GET, your saved filters)                                                                                                                                                                              |
| `POST /api/admin/saved-filters`       | admin              | Save a filter set (`{ name, filters, search }`); the same name replaces it. Returns the list                                                                                                                                     |
| `DELETE /api/admin/saved-filters/:id` | admin              | Delete one of your saved filters. Returns the list                                                                                                                                                                               |
| `GET /api/admin/audit-log`            | admin              | Audit entries, newest first: `?limit=` (1-200, default 50) and `?cursor=` from the previous `nextCursor`                                                                                                                         |
| `GET /healthz`                        | public             | Liveness                                                                                                                                                                                                                         |

## Known gaps

- The tests cover logic and the exact DynamoDB requests (fake client), not a live AWS run, and there are no browser
  tests: the admin and audit pages were checked by hand. Verify each deploy in non-prod ([Verify](#3-verify)).
- Two admins editing the _same field_ at once: the later save wins, but the audit log records exactly what was
  replaced. Editing different fields of the same record never conflicts.
- Saved filters and column order live in one per-admin record that is saved last-write-wins. If the _same admin_
  saves from two tabs at the same moment, one save can overwrite the other, and the audit log then shows the save
  that was attempted (not necessarily the one that survived). Request edits, deletes and restores are not affected.
- The audit log has no search, filter or export, only newest-first paging. Column-order changes are not logged, and
  neither are rows loaded by the seed script.
- Delete is soft only: there is no hard delete or purge, and no bulk delete. Deleted requests stay in the table
  (hidden by the default filter) and count toward the Project ID sequence.
- Any admin can read the whole audit log, including other admins' saved-filter names.
