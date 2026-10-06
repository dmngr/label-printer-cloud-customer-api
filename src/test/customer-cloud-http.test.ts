import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import type { Context, APIGatewayProxyEventV2 } from "aws-lambda";
import { FakeDynamo } from "./fake-dynamo";

const db = new FakeDynamo();
const restore = db.install();
after(restore);
// Import only after replacing the AWS transport; no live SDK is constructed.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require("../handlers/customer-api") as typeof import("../handlers/customer-api");
const hash = createHash("sha256").update("fixture-token").digest("hex");
db.seed("DMLabelPrinterCloudCustomerTokens", { TokenHash: { S: hash }, StoreIds: { SS: ["group-a"] } });
db.seed("DMLabelPrinterCloudDevices", {
  DeviceCode: { S: "installation-a" },
  Group: { S: "group-a" },
  StoreCode: { S: "store-1" },
  AppVersion: { S: "1.0.99" },
});
db.seed("DMLabelPrinterCloudDevices", {
  DeviceCode: { S: "installation-b" },
  Group: { S: "group-b" },
  StoreCode: { S: "store-1" },
  AppVersion: { S: "1.0.100" },
});
const layout = JSON.stringify({
  inputs: [
    { key: "title", required: true },
    { key: "route", defaultValue: "R-7" },
  ],
});
db.seed("DMLabelPrinterCloudCatalogTemplates", {
  Id: { N: "999" },
  LocalTemplateId: { N: "7" },
  DeviceCode: { S: "installation-a" },
  Code: { S: "DISPATCH" },
  CodeSortKey: { S: "DISPATCH#0000000007" },
  Name: { S: "Dispatch" },
  LayoutJson: { S: layout },
  IsActive: { BOOL: true },
});
async function request(path: string, body?: unknown, token = "fixture-token"): Promise<{ statusCode: number; body: string }> {
  const event: APIGatewayProxyEventV2 = {
    version: "2.0",
    routeKey: "$default",
    rawQueryString: "",
    isBase64Encoded: false,
    rawPath: path,
    headers: { authorization: "Bearer " + token },
    requestContext: {
      accountId: "fixture",
      apiId: "fixture",
      domainName: "fixture",
      domainPrefix: "fixture",
      requestId: "fixture",
      routeKey: "$default",
      stage: "$default",
      time: "",
      timeEpoch: 0,
      http: { method: body === undefined ? "GET" : "POST", path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  return (await handler(event, { awsRequestId: "local-test" } as Context, () => {})) as { statusCode: number; body: string };
}
test("real handler authorizes legacy token, lists real stores and queues a template-only command with fields", async () => {
  const hierarchy = await request("/api/v1/me/groups");
  assert.equal(hierarchy.statusCode, 200);
  assert.equal(JSON.parse(hierarchy.body).groups[0].stores[0].storeCode, "store-1");
  assert.equal((await request("/api/v1/me/stores")).statusCode, 200);
  const before = db.table("DMLabelPrinterCloudDeviceCommands").size;
  assert.equal(
    (await request("/api/v1/me/devices/installation-b/commands", { commandType: "print-label", templateCode: "DISPATCH" })).statusCode,
    403,
  );
  assert.equal(
    (await request("/api/v1/me/devices/installation-a/commands", { commandType: "print-label", templateCode: "DISPATCH", fields: {} })).statusCode,
    400,
  );
  assert.equal(db.table("DMLabelPrinterCloudDeviceCommands").size, before);
  const response = await request("/api/v1/me/devices/installation-a/commands", {
    commandType: "print-label",
    templateCode: "DISPATCH",
    fields: { title: "Test label" },
    quantity: 2,
  });
  assert.equal(response.statusCode, 201);
  const stored = db.table("DMLabelPrinterCloudDeviceCommands").get(String(JSON.parse(response.body).id))!;
  const payload = JSON.parse(stored.PayloadJson.S!);
  assert.equal(stored.StoreCode.S, "store-1");
  assert.equal(payload.ProductId, null);
  assert.equal(payload.TemplateId, 7);
  assert.equal(payload.ExpectedTemplate, undefined, "1.0.99 commands retain their old receipt-compatible payload shape");
  assert.deepEqual(payload.Fields, { title: "Test label", route: "R-7" });
  assert.equal(payload.Quantity, 2);
  assert.deepEqual(db.table("DMLabelPrinterCloudCustomerTokens").get(hash)!.StoreIds.SS, ["group-a"]);
});
test("real handler persists and reads library transactions; foreign group writes leave no rows", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const input = { expectedVersion: 0, name: "Dispatch", width: 57, height: 40, layoutJson: layout };
  assert.equal((await request("/api/v1/me/groups/group-b/templates/" + id, input)).statusCode, 403);
  assert.equal(db.table("DMLabelPrinterCloudTemplateLibrary").size, 0);
  assert.equal((await request("/api/v1/me/groups/group-a/templates/" + id, input)).statusCode, 201);
  assert.equal((await request("/api/v1/me/groups/group-a/templates/" + id, input)).statusCode, 409);
  const selection = { expectedRevision: 0, inherit: false, entries: [{ templateId: id, version: 1 }] };
  assert.equal((await request("/api/v1/me/groups/group-a/stores/store-1/assignment", selection)).statusCode, 200);
  assert.equal(JSON.parse((await request("/api/v1/me/groups/group-a/templates")).body).items.length, 1);
  assert.equal(db.table("DMLabelPrinterCloudTemplateLibrary").size, 3);
  assert.equal((await request("/api/v1/me/groups/group-a/templates", undefined, "invalid")).statusCode, 401);
});
