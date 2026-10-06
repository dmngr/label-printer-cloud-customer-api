/** Release-only AWS CLI adapter. Resolve the named profile once, keep its
 * credentials in memory, and use canonical endpoints without child --profile
 * overrides. Canonical copy: customer-api; copied to catalog-sync and web.
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export function createFrozenAws({
  profile = "dm",
  region = "eu-west-1",
  expectedAccount = "787324535455",
  run = execFileSync,
  environment = process.env,
} = {}) {
  if (profile !== "dm" || region !== "eu-west-1") throw new Error("Unexpected deployment target");
  const selectors = Object.keys(environment).filter(
    key => key.startsWith("AWS_") && environment[key] && !["AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PAGER"].includes(key),
  );
  if (
    selectors.length ||
    (environment.AWS_PROFILE && environment.AWS_PROFILE !== profile) ||
    [environment.AWS_REGION, environment.AWS_DEFAULT_REGION].some(value => value && value !== region)
  )
    throw new Error("Ambiguous ambient AWS selectors; use the intended named profile");
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("AWS_")));
  env.AWS_CONFIG_FILE = path.join(os.homedir(), ".aws", "config");
  env.AWS_SHARED_CREDENTIALS_FILE = path.join(os.homedir(), ".aws", "credentials");
  env.AWS_PAGER = "";
  env.AWS_CLI_AUTO_PROMPT = "off";
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env };
  const resolved = JSON.parse(run("aws", ["configure", "export-credentials", "--profile", profile, "--format", "process"], options));
  if (!resolved.AccessKeyId || !resolved.SecretAccessKey) throw new Error("Profile credentials were not resolved");
  env.AWS_ACCESS_KEY_ID = resolved.AccessKeyId;
  env.AWS_SECRET_ACCESS_KEY = resolved.SecretAccessKey;
  if (resolved.SessionToken) env.AWS_SESSION_TOKEN = resolved.SessionToken;
  const invoke = (args, json = true) => {
    if (args.includes("--profile") || args.includes("--endpoint-url"))
      throw new Error("Child selectors must not override frozen credentials/endpoints");
    const service = args[0] === "s3api" ? "s3" : args[0];
    const endpoint =
      service === "iam" || service === "cloudfront" ? `https://${service}.amazonaws.com` : `https://${service}.${region}.amazonaws.com`;
    const output = run(
      "aws",
      [...args, "--region", region, "--endpoint-url", endpoint, "--no-cli-pager", ...(json ? ["--output", "json"] : [])],
      options,
    ).trim();
    return json && output ? JSON.parse(output) : output;
  };
  const verify = () => {
    if (invoke(["sts", "get-caller-identity"]).Account !== expectedAccount) throw new Error("Unexpected AWS account");
  };
  verify();
  const aws = (args, { json = true } = {}) => {
    if (
      [
        "put-role-policy",
        "create-role",
        "update-function-configuration",
        "update-function-code",
        "deploy",
        "create-invalidation",
        "sync",
        "cp",
        "invoke",
      ].includes(args[1])
    )
      verify();
    if (args.includes("--delete") || args.includes("--size-only")) throw new Error("Unsafe artifact sync flags");
    return invoke(args, json);
  };
  aws.verifyIdentity = verify;
  return aws;
}
