import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const policy = JSON.parse(fs.readFileSync(new URL("../infra/customer-api-execution-policy.json", import.meta.url), "utf8"));
test("history image access is read-only, prefix-limited and page-bounded", () => {
  const read = policy.Statement.find(s => s.Sid === "ReadPrintImageJob");
  assert.equal(read.Action, "dynamodb:GetItem");
  assert.equal(read.Resource, "arn:aws:dynamodb:eu-west-1:787324535455:table/DMLabelPrinterCloudPrintJobs");
  const s3 = policy.Statement.filter(s => (Array.isArray(s.Action) ? s.Action : [s.Action]).some(a => a.startsWith("s3:")));
  assert.equal(s3.length, 2);
  assert.deepEqual(s3.map(s => s.Action).sort(), ["s3:GetObject", "s3:ListBucket"]);
  const list = s3.find(s => s.Action === "s3:ListBucket");
  assert.equal(list.Resource, "arn:aws:s3:::dm-label-printer-images-dev-787324535455-eu-west-1");
  assert.deepEqual(list.Condition, { StringLike: { "s3:prefix": "label-images/v1/*" }, NumericLessThanEquals: { "s3:max-keys": "20" } });
  assert.equal(s3.find(s => s.Action === "s3:GetObject").Resource, list.Resource + "/label-images/v1/*");
});
