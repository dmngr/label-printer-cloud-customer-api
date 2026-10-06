import test from "node:test";
import assert from "node:assert/strict";
import { createFrozenAws } from "./frozen-aws.mjs";

test("profile credentials resolve once; writes recheck identity without child profile or endpoint overrides", () => {
  const calls = [];
  const run = (file, args, options) => {
    calls.push({ file, args, env: { ...options.env } });
    if (args[0] === "configure")
      return JSON.stringify({ AccessKeyId: "fixture-key", SecretAccessKey: "fixture-secret", SessionToken: "fixture-session" });
    if (args[0] === "sts") return JSON.stringify({ Account: "787324535455" });
    return "{}";
  };
  const aws = createFrozenAws({ run, environment: {} });
  aws(["lambda", "get-function-configuration", "--function-name", "fixture"]);
  aws(["lambda", "update-function-code", "--function-name", "fixture"]);
  aws(["iam", "put-role-policy", "--role-name", "fixture"]);
  aws(["cloudfront", "create-invalidation", "--distribution-id", "fixture"]);
  assert.equal(calls.filter(c => c.args[0] === "configure").length, 1);
  assert.equal(calls.filter(c => c.args[0] === "sts").length, 4);
  assert.ok(calls.slice(1).every(c => !c.args.includes("--profile") && c.env.AWS_SESSION_TOKEN === "fixture-session"));
  assert.ok(calls.slice(1).every(c => c.args.includes("--endpoint-url")));
  for (const call of calls.filter(c => ["iam", "cloudfront", "lambda"].includes(c.args[0]))) {
    assert.equal(call.args[call.args.indexOf("--region") + 1], call.args[0] === "lambda" ? "eu-west-1" : "us-east-1");
  }
  assert.throws(() => aws(["s3", "sync", "a", "b", "--delete"]), /Unsafe/);
  assert.throws(() => aws(["lambda", "list-functions", "--profile", "other"]), /override/);
});

test("ambiguous selectors and wrong account fail before mutation", () => {
  assert.throws(() => createFrozenAws({ environment: { AWS_ENDPOINT_URL: "fixture" } }), /Ambiguous/);
  const calls = [];
  assert.throws(
    () =>
      createFrozenAws({
        environment: {},
        run: (_file, args) => {
          calls.push(args[0]);
          return JSON.stringify(args[0] === "configure" ? { AccessKeyId: "fixture", SecretAccessKey: "fixture" } : { Account: "000000000000" });
        },
      }),
    /Unexpected AWS account/,
  );
  assert.deepEqual(calls, ["configure", "sts"]);
});
