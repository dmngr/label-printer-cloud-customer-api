import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
test("archive guards can only condition the library table inside a transaction", () => {
  const policy = JSON.parse(fs.readFileSync(new URL("../infra/customer-api-execution-policy.json", import.meta.url)));
  const grants = policy.Statement.filter(statement => [statement.Action].flat().includes("dynamodb:ConditionCheckItem"));
  assert.equal(grants.length, 1);
  assert.equal(grants[0].Effect, "Allow");
  assert.equal(grants[0].Resource, "arn:aws:dynamodb:eu-west-1:787324535455:table/DMLabelPrinterCloudTemplateLibrary");
  assert.deepEqual(grants[0].Condition, { "ForAnyValue:StringEquals": { "dynamodb:EnclosingOperation": ["TransactWriteItems"] } });
  assert.ok(policy.Statement.every(statement => ![statement.Action].flat().some(action => action.includes("*") || action === "dynamodb:DeleteItem")));
});
