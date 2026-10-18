import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { FakeDynamo, type Item } from "./fake-dynamo";
import { parseSharedPrintRequest, templateFingerprint } from "../lib/shared-print-request";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";

const db = new FakeDynamo();
after(db.install());
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require("../handlers/customer-api") as typeof import("../handlers/customer-api");
const commands = "DMLabelPrinterCloudDeviceCommands";
const counters = "DMLabelPrinterCloudCounters";
for (const token of ["token-a", "rotated-a"])
  db.seed("DMLabelPrinterCloudCustomerTokens", {
    TokenHash: { S: createHash("sha256").update(token).digest("hex") },
    StoreIds: { SS: ["tenant-a"] },
  });
db.seed("DMLabelPrinterCloudCustomerTokens", {
  TokenHash: { S: createHash("sha256").update("token-b").digest("hex") },
  StoreIds: { SS: ["tenant-b"] },
});
for (const [device, group, protocol] of [
  ["device-a", "tenant-a", "1"],
  ["device-b", "tenant-b", "1"],
  ["old", "tenant-a", "0"],
])
  db.seed("DMLabelPrinterCloudDevices", {
    DeviceCode: { S: device },
    Group: { S: group },
    StoreCode: { S: "shop" },
    PrintRequestProtocolVersion: { S: protocol },
  });

let fail: "before" | "after" | undefined;
const originalSend = db.send.bind(db);
db.send = async command => {
  if (command.kind !== "TransactWriteItemsCommand") return originalSend(command);
  const entries = command.input.TransactItems as { Put: { TableName: string; Item: Item; ConditionExpression: string } }[];
  assert.equal(entries.length, 2);
  assert.equal(entries[0].Put.TableName, counters);
  assert.equal(entries[1].Put.TableName, commands);
  assert.equal(entries[0].Put.ConditionExpression, "attribute_not_exists(CounterName)");
  assert.equal(entries[1].Put.ConditionExpression, "attribute_not_exists(Id)");
  if (fail === "before") {
    fail = undefined;
    throw new Error("transport disconnected before commit");
  }
  // Evaluate BOTH conditions before writing either item, as Dynamo transactions do.
  for (const { Put: put } of entries) {
    const key = put.TableName === counters ? put.Item.CounterName.S! : put.Item.Id.N!;
    if (db.table(put.TableName).has(key)) throw Object.assign(new Error("conditional conflict"), { name: "TransactionCanceledException" });
  }
  entries.forEach(({ Put: put }) => db.seed(put.TableName, put.Item));
  if (fail === "after") {
    fail = undefined;
    throw new Error("transaction response lost after commit");
  }
  return {};
};
function intent(id: string, deviceCode = "device-a") {
  return {
    protocolVersion: 1,
    printRequestId: id,
    deviceCode,
    templateCode: "GENERIC",
    printerName: "Fixture printer",
    templateFingerprint: templateFingerprint(58, 40, "{}"),
    quantity: 1,
    fields: { barcode: "123456789012", header: "TEST-NIK-001", recordedTime: "14:32", content: "Χωρίς κρεμμύδι" },
  };
}
async function request(value: unknown, device = "device-a", token = "token-a", requestKey?: string) {
  const path = `/api/v1/me/devices/${device}/commands`;
  const event = {
    version: "2.0",
    routeKey: "$default",
    rawQueryString: "",
    isBase64Encoded: false,
    rawPath: path,
    headers: { authorization: "Bearer " + token, ...(requestKey === undefined ? {} : { "idempotency-key": requestKey }) },
    body: JSON.stringify({ commandType: "print-request", printRequest: value }),
    requestContext: {
      accountId: "fixture",
      apiId: "fixture",
      domainName: "fixture",
      domainPrefix: "fixture",
      routeKey: "$default",
      stage: "$default",
      time: "",
      timeEpoch: 0,
      http: { method: "POST", path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      requestId: "isolated-test",
    },
  } as APIGatewayProxyEventV2;
  return (await handler(event, {} as Context, () => {})) as { statusCode: number; body: string };
}
test("24 simultaneous cloud submissions commit one command and one durable receipt", async () => {
  const before = db.table(commands).size;
  const replies = await Promise.all(Array.from({ length: 24 }, () => request(intent("concurrent"))));
  assert.ok(replies.every(reply => reply.statusCode === 201));
  assert.equal(new Set(replies.map(reply => JSON.parse(reply.body).id)).size, 1);
  assert.equal(replies.filter(reply => !JSON.parse(reply.body).replayed).length, 1);
  assert.equal(db.table(commands).size, before + 1);
  const stored = db.table(commands).get(String(JSON.parse(replies[0].body).id))!;
  assert.equal(stored.CommandType.S, "print-request");
  assert.deepEqual(JSON.parse(stored.PayloadJson.S!), parseSharedPrintRequest(intent("concurrent")));
});
test("HTTP response loss and credential rotation replay the same receipt", async () => {
  const first = await request(intent("lost-http")); // sender loses this successful response
  const retry = await request(intent("lost-http"), "device-a", "rotated-a");
  assert.equal(retry.statusCode, 201);
  assert.equal(JSON.parse(retry.body).id, JSON.parse(first.body).id);
  assert.equal(JSON.parse(retry.body).replayed, true);
});
test("transaction response loss reconciles committed state; disconnect before commit remains retryable", async () => {
  const before = db.table(commands).size;
  fail = "after";
  assert.equal((await request(intent("lost-transaction"))).statusCode, 201);
  assert.equal(db.table(commands).size, before + 1);
  fail = "before";
  assert.equal((await request(intent("offline"))).statusCode, 500);
  assert.equal(db.table(commands).size, before + 1);
  assert.equal((await request(intent("offline"))).statusCode, 201);
  assert.equal(db.table(commands).size, before + 2);
});
test("payload conflicts reject; distinct identities and distinct authorized tenants remain independent", async () => {
  const value = intent("conflict");
  assert.equal((await request(value)).statusCode, 201);
  assert.equal((await request({ ...value, quantity: 2 })).statusCode, 409);
  assert.equal((await request(intent("independent"))).statusCode, 201);
  assert.equal((await request(intent("conflict", "device-b"), "device-b", "token-b")).statusCode, 201);
});
test("unauthorized, wrong tenant/destination, old client and unknown attributes do not create commands", async () => {
  const before = db.table(commands).size;
  assert.equal((await request(intent("no-auth"), "device-a", "invalid")).statusCode, 401);
  assert.equal((await request(intent("wrong-tenant", "device-b"), "device-b")).statusCode, 403);
  assert.equal((await request(intent("wrong-device", "device-b"))).statusCode, 409);
  assert.equal((await request(intent("old", "old"), "old")).statusCode, 409);
  assert.equal((await request({ ...intent("unknown"), group: "forged" })).statusCode, 400);
  assert.equal(db.table(commands).size, before);
});
test("receipt survives command cleanup and capability downgrade; expired new work is rejected", async () => {
  const value = intent("retained");
  const first = JSON.parse((await request(value)).body);
  db.table(commands).delete(String(first.id));
  const device = db.table("DMLabelPrinterCloudDevices").get("device-a")!;
  device.PrintRequestProtocolVersion = { S: "0" };
  const retry = await request(value);
  assert.equal(retry.statusCode, 201);
  assert.equal(JSON.parse(retry.body).id, first.id);
  assert.equal(db.table(commands).has(String(first.id)), false);
  device.PrintRequestProtocolVersion = { S: "1" };
  assert.equal((await request({ ...intent("expired"), expiresAtUtc: "2020-01-01T00:00:00Z" })).statusCode, 409);
});
test("schema normalizes field order/case while rejecting collisions and invalid timestamps", () => {
  const a = parseSharedPrintRequest(intent("schema"));
  assert.deepEqual(
    parseSharedPrintRequest({
      ...intent("schema"),
      fields: { Header: "TEST-NIK-001", barcode: "123456789012", content: "Χωρίς κρεμμύδι", recordedTime: "14:32" },
    }),
    a,
  );
  assert.throws(() => parseSharedPrintRequest({ ...intent("schema"), fields: { header: "a", Header: "b" } }));
  assert.throws(() => parseSharedPrintRequest({ ...intent("schema"), expiresAtUtc: "2026-02-30T00:00:00Z" }));
});

test("optional cloud header must equal the shared body identity and never overrides it", async () => {
  const before = db.table(commands).size;
  assert.equal((await request(intent("header-test"), "device-a", "token-a", "another-id")).statusCode, 400);
  assert.equal(db.table(commands).size, before);
  assert.equal((await request(intent("header-test"), "device-a", "token-a", "header-test")).statusCode, 201);
  assert.equal(db.table(commands).size, before + 1);
});
