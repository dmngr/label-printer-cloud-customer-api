import assert from "node:assert/strict";
import { after, test } from "node:test";
import { FakeDynamo } from "./fake-dynamo";
import { loadOptions } from "../config";
import { PrintRequestStore } from "../storage/print-request-store";
import { parseSharedPrintRequest, templateFingerprint } from "../lib/shared-print-request";
import type { DeviceRecord } from "../types";

const db = new FakeDynamo();
after(db.install());
const options = { ...loadOptions(), deliveryInboxTableName: "FixtureDeliveryInbox" };
const store = new PrintRequestStore(options);
const device: DeviceRecord = { deviceCode: "push-fixture", storeId: "fixture-group", storeCode: "fixture-store", installationId: "fixture-install",
  printRequestProtocolVersion: 1, hostName: null, printers: null, printersReportedAtUtc: null, deviceName: "fixture", appVersion: "1.0.124",
  lastSeenAtUtc: "", pendingCommands: 0, failedJobs: 0 };
const seed = (changes = {}) => db.seed(options.devicesTableName, { DeviceCode: { S: device.deviceCode }, Group: { S: device.storeId },
  StoreCode: { S: device.storeCode }, InstallationId: { S: device.installationId! }, DeliveryMode: { S: "push-v1" }, PrintRequestProtocolVersion: { S: "1" }, ...changes });
const intent = (id: string) => parseSharedPrintRequest({ protocolVersion: 1, printRequestId: id, deviceCode: device.deviceCode,
  templateCode: "GENERIC", printerName: "Fixture", templateFingerprint: templateFingerprint(58, 40, "{}"), quantity: 1, fields: { barcode: "001234567890" } });
let counter = 0;
const submit = (id: string) => store.submit(device, intent(id), async () => ++counter, "fixture");

test("customer push admission creates one command, inbox and permanent receipt under concurrent sends", async () => {
  seed();
  const responses = await Promise.all(Array.from({ length: 24 }, () => submit("parallel")));
  assert.equal(new Set(responses.map(x => x.id)).size, 1);
  assert.equal(db.table(options.deviceCommandsTableName).size, 1);
  assert.equal(db.table(options.deliveryInboxTableName).size, 1);
  assert.equal(db.table(options.countersTableName).size, 1);
  const row = [...db.table(options.deviceCommandsTableName).values()][0];
  assert.match(row.DeliveryPartition.S!, /^INSTALL:[a-f0-9]{64}$/u);
  assert.equal(row.InstallationId.S, device.installationId);
});

test("reassignment before the fresh read or atomic commit, unknown mode and migration pause fail closed", async () => {
  const before = db.table(options.deviceCommandsTableName).size;
  seed({ Group: { S: "foreign" } });
  await assert.rejects(submit("moved-before-read"));
  seed({ DeliveryMode: { S: "push-preparing" } });
  await assert.rejects(submit("migration-paused"));
  seed({ DeliveryMode: { S: "future-unsupported" } });
  await assert.rejects(submit("unknown-mode"));
  seed();
  const original = db.send.bind(db);
  db.send = async command => {
    if (command.kind === "TransactWriteItemsCommand") seed({ InstallationId: { S: "replacement" } });
    return original(command);
  };
  try { await assert.rejects(submit("moved-before-commit")); } finally { db.send = original; }
  assert.equal(db.table(options.deviceCommandsTableName).size, before);
  seed();
  assert.equal((await submit("positive-after-rejection")).replayed, false);
  assert.equal(db.table(options.deviceCommandsTableName).size, before + 1);
});
