import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { FakeDynamo } from "./fake-dynamo";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
const db = new FakeDynamo();
const restore = db.install();
after(restore);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require("../handlers/customer-api") as typeof import("../handlers/customer-api");
db.seed("DMLabelPrinterCloudCustomerTokens", {
  TokenHash: { S: createHash("sha256").update("fixture").digest("hex") },
  StoreIds: { SS: ["allowed"] },
});
const layout = '{"inputs":[{"key":"title","required":true}]}';
async function request(): Promise<{ statusCode: number; body: string }> {
  const event: APIGatewayProxyEventV2 = {
    version: "2.0",
    routeKey: "$default",
    rawQueryString: "",
    isBase64Encoded: false,
    rawPath: "/api/v1/me/devices/guard-device/commands",
    headers: { authorization: "Bearer fixture" },
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
      http: { method: "POST", path: "/api/v1/me/devices/guard-device/commands", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
    },
    body: JSON.stringify({
      commandType: "print-label",
      templateCode: "DISPATCH",
      fields: { title: "Test" },
      expectedTemplate: { layoutJson: "caller cannot replace the assertion" },
    }),
  };
  return (await handler(event, {} as Context, () => {})) as { statusCode: number; body: string };
}
test("inactive/old-agent/malformed-template commands cannot create jobs; valid payload pins actual mirror content", async () => {
  const device = { DeviceCode: { S: "guard-device" }, Group: { S: "allowed" }, StoreCode: { S: "store" }, AppVersion: { S: "1.0.98" } };
  const template = {
    Id: { N: "501" },
    LocalTemplateId: { N: "6" },
    DeviceCode: { S: "guard-device" },
    Code: { S: "DISPATCH" },
    CodeSortKey: { S: "DISPATCH#0000000006" },
    Name: { S: "Dispatch" },
    Width: { N: "57" },
    Height: { N: "40" },
    LayoutJson: { S: layout },
    IsActive: { BOOL: true },
  };
  db.seed("DMLabelPrinterCloudDevices", device);
  db.seed("DMLabelPrinterCloudCatalogTemplates", template);
  assert.equal((await request()).statusCode, 409);
  db.seed("DMLabelPrinterCloudDevices", { ...device, AppVersion: { S: "1.0.100" } });
  db.seed("DMLabelPrinterCloudCatalogTemplates", { ...template, IsActive: { BOOL: false } });
  assert.equal((await request()).statusCode, 400);
  db.seed("DMLabelPrinterCloudCatalogTemplates", { ...template, LayoutJson: { S: "broken json" } });
  assert.equal((await request()).statusCode, 400);
  assert.equal(db.table("DMLabelPrinterCloudDeviceCommands").size, 0);
  db.seed("DMLabelPrinterCloudCatalogTemplates", template);
  assert.equal((await request()).statusCode, 201);
  const payload = JSON.parse([...db.table("DMLabelPrinterCloudDeviceCommands").values()][0].PayloadJson.S!);
  assert.deepEqual(payload.ExpectedTemplate, { Width: 57, Height: 40, LayoutJson: layout });
});
