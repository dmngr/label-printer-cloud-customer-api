import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_ACCOUNT = "787324535455";
const EXPECTED_REGION = "eu-west-1";
const FUNCTION_NAME = "label-printer-cloud-customer-api";
const ROLE_NAME = "label-printer-cloud-customer-api-role";
const POLICY_NAME = "label-printer-cloud-customer-api-permissions";
const HANDLER = "dist/handlers/customer-api.handler";
const SHARED_ROLE_NAME = "lambda_dynamo_2";

const EXPECTED_ENVIRONMENT = Object.freeze({
  DM_LABEL_PRINTER_CLOUD_DEVICES_TABLE: "DMLabelPrinterCloudDevices",
  DM_LABEL_PRINTER_CLOUD_CUSTOMER_TOKENS_TABLE: "DMLabelPrinterCloudCustomerTokens",
  DM_LABEL_PRINTER_CLOUD_CATALOG_PRODUCTS_TABLE: "DMLabelPrinterCloudCatalogProducts",
  DM_LABEL_PRINTER_CLOUD_CATALOG_TEMPLATES_TABLE: "DMLabelPrinterCloudCatalogTemplates",
  DM_LABEL_PRINTER_CLOUD_PRINT_JOBS_TABLE: "DMLabelPrinterCloudPrintJobs",
  DM_LABEL_PRINTER_CLOUD_DEVICE_COMMANDS_TABLE: "DMLabelPrinterCloudDeviceCommands",
  DM_LABEL_PRINTER_CLOUD_COUNTERS_TABLE: "DMLabelPrinterCloudCounters",
  DM_LABEL_PRINTER_CLOUD_CATALOG_DEVICE_CODE_INDEX: "DeviceCodeIndex",
  DM_LABEL_PRINTER_CLOUD_PRINT_JOBS_DEVICE_CREATED_INDEX: "DeviceCreatedIndex",
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const zipPath = path.join(os.homedir(), "localLambdas", `${packageJson.name}.zip`);
const trustPolicyPath = path.join(repoRoot, "infra", "lambda-assume-role-policy.json");
const executionPolicyPath = path.join(repoRoot, "infra", "customer-api-execution-policy.json");
const profile = process.env.AWS_PROFILE?.trim() || "dm";
const region = process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim() || EXPECTED_REGION;
const checkOnly = process.argv.includes("--check");

function aws(args, { json = true } = {}) {
  const output = execFileSync(
    "aws",
    [...args, "--profile", profile, "--region", region, "--no-cli-pager", ...(json ? ["--output", "json"] : [])],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  return json && output ? JSON.parse(output) : output;
}

function fileArgument(prefix, targetPath) {
  return `${prefix}${path.resolve(targetPath).replaceAll("\\", "/")}`;
}

function waitForUpdate() {
  aws(["lambda", "wait", "function-updated", "--function-name", FUNCTION_NAME], { json: false });
}

function assertPolicyIsScoped(policyPath) {
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  for (const statement of policy.Statement ?? []) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    if (actions.some((action) => typeof action !== "string" || action.includes("*"))) {
      throw new Error(`Wildcard or invalid action in ${policyPath}`);
    }
    if (resources.some((resource) => resource === "*" || typeof resource !== "string")) {
      throw new Error(`Unscoped resource in ${policyPath}`);
    }
  }
}

function assertLocalInputs() {
  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
    throw new Error(`Deployment package not found or empty: ${zipPath}`);
  }
  if (packageJson.engines?.node !== ">=24") {
    throw new Error("package.json must require Node.js 24 or newer");
  }
  if (packageJson.lambda_role !== ROLE_NAME) {
    throw new Error(`package.json lambda_role must be ${ROLE_NAME}`);
  }
  assertPolicyIsScoped(executionPolicyPath);
  JSON.parse(fs.readFileSync(trustPolicyPath, "utf8"));
}

function getRole() {
  try {
    return aws(["iam", "get-role", "--role-name", ROLE_NAME]).Role;
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (stderr.includes("NoSuchEntity")) return null;
    throw error;
  }
}

function assertExclusiveAndUnmanaged(role) {
  const consumers =
    aws(["lambda", "list-functions", "--query", `Functions[?Role=='${role.Arn}'].FunctionName`]) ?? [];
  const unexpectedConsumers = consumers.filter((name) => name !== FUNCTION_NAME);
  if (unexpectedConsumers.length > 0) {
    throw new Error(`Refusing to modify role used by other Lambdas: ${unexpectedConsumers.join(", ")}`);
  }
  const attached = aws(["iam", "list-attached-role-policies", "--role-name", ROLE_NAME]).AttachedPolicies ?? [];
  if (attached.length > 0) {
    throw new Error(`Unexpected managed policies on ${ROLE_NAME}: ${attached.map((policy) => policy.PolicyName).join(", ")}`);
  }
  const inline = aws(["iam", "list-role-policies", "--role-name", ROLE_NAME]).PolicyNames ?? [];
  const unexpectedInline = inline.filter((name) => name !== POLICY_NAME);
  if (unexpectedInline.length > 0) {
    throw new Error(`Unexpected inline policies on ${ROLE_NAME}: ${unexpectedInline.join(", ")}`);
  }
}

function ensureRole() {
  let role = getRole();
  if (!role) {
    aws([
      "iam",
      "create-role",
      "--role-name",
      ROLE_NAME,
      "--description",
      "Least-privilege execution role for the DM Label Printer customer API",
      "--assume-role-policy-document",
      fileArgument("file://", trustPolicyPath),
      "--tags",
      "Key=ManagedBy,Value=label-printer-cloud-customer-api",
    ]);
    aws(["iam", "wait", "role-exists", "--role-name", ROLE_NAME], { json: false });
    role = aws(["iam", "get-role", "--role-name", ROLE_NAME]).Role;
  }

  assertExclusiveAndUnmanaged(role);
  aws(
    [
      "iam",
      "put-role-policy",
      "--role-name",
      ROLE_NAME,
      "--policy-name",
      POLICY_NAME,
      "--policy-document",
      fileArgument("file://", executionPolicyPath),
    ],
    { json: false },
  );
  return role.Arn;
}

function writeEnvironment(tempDir, name, variables) {
  const outputPath = path.join(tempDir, name);
  fs.writeFileSync(outputPath, JSON.stringify({ Variables: variables }));
  return outputPath;
}

function updateConfiguration(args, attempts = 1) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      aws(["lambda", "update-function-configuration", "--function-name", FUNCTION_NAME, ...args]);
      waitForUpdate();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
      }
    }
  }
  throw lastError;
}

function invokeUnauthorizedCanary(tempDir) {
  const payload = {
    version: "2.0",
    rawPath: "/api/v1/me/stores",
    headers: { authorization: "Bearer deployment-canary-invalid" },
    requestContext: {
      requestId: `deploy-canary-${Date.now()}`,
      http: {
        method: "GET",
        path: "/api/v1/me/stores",
        sourceIp: "127.0.0.1",
        userAgent: "customer-api-deploy-canary",
      },
    },
    isBase64Encoded: false,
  };
  const responsePath = path.join(tempDir, `invoke-${Date.now()}.json`);
  const metadata = aws([
    "lambda",
    "invoke",
    "--function-name",
    FUNCTION_NAME,
    "--cli-binary-format",
    "raw-in-base64-out",
    "--payload",
    JSON.stringify(payload),
    responsePath,
  ]);
  if (metadata.FunctionError) throw new Error(`Canary invocation failed: ${metadata.FunctionError}`);
  const response = JSON.parse(fs.readFileSync(responsePath, "utf8"));
  if (response.statusCode !== 401) {
    throw new Error(`Expected customer API canary status 401, received ${response.statusCode}`);
  }
}

assertLocalInputs();

if (checkOnly) {
  console.log(
    JSON.stringify({
      check: "ok",
      account: EXPECTED_ACCOUNT,
      region: EXPECTED_REGION,
      functionName: FUNCTION_NAME,
      roleName: ROLE_NAME,
      package: zipPath,
      version: packageJson.version,
    }),
  );
  process.exit(0);
}

if (region !== EXPECTED_REGION) {
  throw new Error(`Refusing deployment to ${region}; expected ${EXPECTED_REGION}`);
}

const identity = aws(["sts", "get-caller-identity"]);
if (identity.Account !== EXPECTED_ACCOUNT) {
  throw new Error(`Refusing deployment to AWS account ${identity.Account}; expected ${EXPECTED_ACCOUNT}`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "customer-api-deploy-"));
const before = aws(["lambda", "get-function-configuration", "--function-name", FUNCTION_NAME]);
const beforeEnvironment = { ...(before.Environment?.Variables ?? {}) };
let roleChanged = false;

try {
  const previousRoleName = before.Role?.split("/").at(-1);
  if (![SHARED_ROLE_NAME, ROLE_NAME].includes(previousRoleName)) {
    throw new Error(`Refusing to replace unexpected role ${previousRoleName} on ${FUNCTION_NAME}`);
  }
  const roleArn = ensureRole();
  roleChanged = before.Role !== roleArn;
  const nextEnvironment = { ...beforeEnvironment, ...EXPECTED_ENVIRONMENT };
  const environmentPath = writeEnvironment(tempDir, "environment.json", nextEnvironment);

  updateConfiguration(
    [
      "--revision-id",
      before.RevisionId,
      "--role",
      roleArn,
      "--runtime",
      "nodejs24.x",
      "--handler",
      HANDLER,
      "--environment",
      fileArgument("file://", environmentPath),
    ],
    6,
  );
  // Exercise DynamoDB GetItem before replacing code; failure restores the old role/config.
  invokeUnauthorizedCanary(tempDir);

  aws([
    "lambda",
    "update-function-code",
    "--function-name",
    FUNCTION_NAME,
    "--zip-file",
    fileArgument("fileb://", zipPath),
    "--architectures",
    "arm64",
  ]);
  waitForUpdate();
  invokeUnauthorizedCanary(tempDir);

  const after = aws(["lambda", "get-function-configuration", "--function-name", FUNCTION_NAME]);
  if (
    after.Role !== roleArn ||
    after.Runtime !== "nodejs24.x" ||
    after.Architectures?.[0] !== "arm64" ||
    after.Handler !== HANDLER
  ) {
    throw new Error("Post-deploy configuration verification failed");
  }

  console.log(
    JSON.stringify({
      deployed: FUNCTION_NAME,
      role: ROLE_NAME,
      runtime: after.Runtime,
      architecture: after.Architectures[0],
      codeSha256: after.CodeSha256,
      account: identity.Account,
      region,
    }),
  );
} catch (error) {
  if (roleChanged) {
    const rollbackEnvironmentPath = writeEnvironment(tempDir, "rollback-environment.json", beforeEnvironment);
    const current = aws(["lambda", "get-function-configuration", "--function-name", FUNCTION_NAME]);
    updateConfiguration([
      "--revision-id",
      current.RevisionId,
      "--role",
      before.Role,
      "--runtime",
      before.Runtime,
      "--handler",
      before.Handler,
      "--environment",
      fileArgument("file://", rollbackEnvironmentPath),
    ]);
  }
  throw error;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
