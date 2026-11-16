// Runtime secret fetch (mirrors sts-exec-budget-forecast/src/secrets.js).
// The mail password is never a CloudFormation parameter or a literal Lambda environment variable:
// the template only passes the secret's ARN (LAMBDA_SECRETS_ARN) and the Lambda role may read just
// that secret. Fetched once per cold start; unset (local dev) resolves to {} so callers fall back
// to process.env.
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

async function loadLambdaSecrets() {
  const secretArn = process.env.LAMBDA_SECRETS_ARN;
  if (!secretArn) return {};
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  return SecretString ? JSON.parse(SecretString) : {};
}

export const lambdaSecrets = await loadLambdaSecrets();
