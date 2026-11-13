import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { FakeDynamo } from "./fake-dynamo";
import { imageKey, imageMetadata, parseImageManifest } from "../lib/print-image";

const db = new FakeDynamo();
const restoreDb = db.install();
const manifest = parseImageManifest(JSON.parse(readFileSync("src/test/fixtures/print-image-windows.json", "utf8")));
const bytes = readFileSync("src/test/fixtures/print-image-windows.png");
const scope = { group: "group-a", storeCode: "store-a", installationId: "install-a", deviceCode: "device-a" };
const key = imageKey(scope, manifest);
let missing = false,
  outage = false;
let storageCalls = 0;
const sdk: Record<string, unknown> = {
  S3Client: class {
    async send(command: { kind: string; input: Record<string, unknown> }) {
      storageCalls++;
      if (outage) throw new Error("fixture read outage");
      if (command.kind === "ListObjectsV2Command") {
        assert.ok(key.startsWith(String(command.input.Prefix)));
        return { Contents: missing ? [] : [{ Key: key }] };
      }
      assert.equal(command.input.Key, key);
      if (missing) throw Object.assign(new Error("gone"), { name: "NoSuchKey" });
      return {
        ContentType: "image/png",
        ContentLength: bytes.length,
        Metadata: imageMetadata(manifest),
        Body: { transformToByteArray: async () => bytes },
      };
    }
  },
};
for (const kind of ["ListObjectsV2Command", "HeadObjectCommand", "GetObjectCommand"])
  sdk[kind] = class {
    kind = kind;
    constructor(public input: Record<string, unknown>) {}
  };
const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
const original = loader._load;
loader._load = function (name, ...args) {
  return name === "@aws-sdk/client-s3" ? sdk : original.call(this, name, ...args);
};
process.env.DM_LABEL_PRINTER_IMAGE_BUCKET = "fixture-private-bucket";
after(() => {
  loader._load = original;
  restoreDb();
  delete process.env.DM_LABEL_PRINTER_IMAGE_BUCKET;
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require("../handlers/customer-api") as typeof import("../handlers/customer-api");
const tokenHash = createHash("sha256").update("fixture-token").digest("hex");
db.seed("DMLabelPrinterCloudCustomerTokens", { TokenHash: { S: tokenHash }, StoreIds: { SS: [scope.group] } });
db.seed("DMLabelPrinterCloudDevices", {
  DeviceCode: { S: scope.deviceCode },
  Group: { S: scope.group },
  StoreCode: { S: scope.storeCode },
  InstallationId: { S: scope.installationId },
});
db.seed("DMLabelPrinterCloudDevices", {
  DeviceCode: { S: "foreign-device" },
  Group: { S: "foreign-group" },
  StoreCode: { S: scope.storeCode },
  InstallationId: { S: scope.installationId },
});
db.seed("DMLabelPrinterCloudPrintJobs", {
  Id: { N: "123" },
  DeviceCode: { S: scope.deviceCode },
  StoreCode: { S: scope.storeCode },
  LocalJobId: { N: String(manifest.localJobId) },
  LocalCreatedAtUtc: { S: manifest.jobCreatedAtUtc },
});
db.seed("DMLabelPrinterCloudPrintJobs", {
  Id: { N: "124" },
  DeviceCode: { S: "other-device" },
  StoreCode: { S: scope.storeCode },
  LocalJobId: { N: String(manifest.localJobId) },
  LocalCreatedAtUtc: { S: manifest.jobCreatedAtUtc },
});
db.seed("DMLabelPrinterCloudPrintJobs", {
  Id: { N: "125" },
  DeviceCode: { S: scope.deviceCode },
  StoreCode: { S: "other-store" },
  LocalJobId: { N: String(manifest.localJobId) },
  LocalCreatedAtUtc: { S: manifest.jobCreatedAtUtc },
});
async function request(path: string, token = "fixture-token", method = "GET") {
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
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
    },
  };
  return (await handler(event, { awsRequestId: "isolated-image-history" } as Context, () => {})) as {
    statusCode: number;
    body: string;
    isBase64Encoded?: boolean;
    headers: Record<string, string>;
  };
}
const path = "/api/v1/me/devices/device-a/jobs/123/images";
test("authorized real handler lists the original manifest and downloads identical PNG bytes", async () => {
  const listed = await request(path);
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(JSON.parse(listed.body).items, [manifest]);
  const download = await request(path + "/" + manifest.artifactId);
  assert.equal(download.statusCode, 200);
  assert.equal(download.isBase64Encoded, true);
  assert.deepEqual(Buffer.from(download.body, "base64"), bytes);
  assert.equal(download.headers["Cache-Control"], "private, no-store");
  assert.equal(download.headers["Content-Type"], "image/png");
  assert.equal(db.table("DMLabelPrinterCloudDeviceCommands").size, 0);
});
test("unauthorized token, group, device and store are refused before object storage", async () => {
  const before = storageCalls;
  assert.equal((await request(path, "invalid")).statusCode, 401);
  assert.equal((await request(path.replace("device-a", "foreign-device"))).statusCode, 403);
  assert.equal((await request(path.replace("/123/", "/124/"))).statusCode, 404);
  assert.equal((await request(path.replace("/123/", "/125/"))).statusCode, 404);
  assert.equal((await request(path.replace("/123/", "/999/"))).statusCode, 404);
  assert.equal(storageCalls, before);
});
test("old/expired images and outages remain distinct, with no command writes", async () => {
  missing = true;
  const old = await request(path);
  assert.equal(old.statusCode, 200);
  assert.equal(JSON.parse(old.body).state, "unavailable");
  assert.equal((await request(path + "/" + manifest.artifactId)).statusCode, 404);
  missing = false;
  outage = true;
  assert.equal((await request(path)).statusCode, 500);
  outage = false;
  assert.equal((await request(path, "fixture-token", "POST")).statusCode, 405);
  assert.equal(db.table("DMLabelPrinterCloudDeviceCommands").size, 0);
});
