import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("delivery fences and inbox writes stay on their exact tables", () => {
  const policy = JSON.parse(fs.readFileSync(new URL("../infra/customer-api-execution-policy.json", import.meta.url)));
  const fences = policy.Statement.filter(statement => [statement.Action].flat().includes("dynamodb:ConditionCheckItem"));
  assert.equal(fences.length, 2);
  assert.deepEqual(fences.map(statement => statement.Resource).sort(), [
    "arn:aws:dynamodb:eu-west-1:787324535455:table/DMLabelPrinterCloudDevices",
    "arn:aws:dynamodb:eu-west-1:787324535455:table/DMLabelPrinterCloudTemplateLibrary",
  ]);
  for (const fence of fences) {
    assert.equal(fence.Effect, "Allow");
    assert.deepEqual(fence.Condition, { "ForAnyValue:StringEquals": { "dynamodb:EnclosingOperation": ["TransactWriteItems"] } });
  }
  const inbox = policy.Statement.filter(statement => [statement.Resource].flat().some(resource => resource.endsWith("/DMLabelPrinterCloudDeliveryInbox")));
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].Effect, "Allow");
  assert.equal(inbox[0].Action, "dynamodb:PutItem");
  assert.equal(inbox[0].Resource, "arn:aws:dynamodb:eu-west-1:787324535455:table/DMLabelPrinterCloudDeliveryInbox");
});
