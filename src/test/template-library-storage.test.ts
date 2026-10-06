import assert from "node:assert/strict";
import { after, test } from "node:test";
import { FakeDynamo } from "./fake-dynamo";
import { LibraryError } from "../lib/template-library";
import { DynamoTemplateLibraryTable } from "../storage/template-library-table";
const db = new FakeDynamo();
const restore = db.install();
after(restore);
const tableName = "DMLabelPrinterCloudTemplateLibrary";
const table = new DynamoTemplateLibraryTable(tableName);
test("strongly consistent library query follows all pages and keeps group isolation", async () => {
  for (let i = 0; i < 7; i++)
    db.seed(tableName, { GroupId: { S: "a" }, ItemKey: { S: "T#" + i }, Version: { N: "1" }, Payload: { S: JSON.stringify({ name: String(i) }) } });
  db.seed(tableName, { GroupId: { S: "b" }, ItemKey: { S: "T#0" }, Version: { N: "1" }, Payload: { S: "{}" } });
  const rows = await table.list("a", "T#");
  assert.equal(rows.length, 7);
  const queries = db.calls.filter(call => call.kind === "QueryCommand");
  assert.equal(queries.length, 4);
  assert.ok(queries.every(call => call.input.ConsistentRead === true));
  db.failTable = tableName;
  await assert.rejects(table.list("a", "T#"), /unavailable/);
  db.failTable = "";
});
test("missing transaction reasons use a head read only to prove a revision conflict", async () => {
  const send = db.send.bind(db);
  db.send = async command => {
    if (command.kind === "TransactWriteItemsCommand") throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
    return send(command);
  };
  await assert.rejects(table.write("a", { key: "T#0", version: 2, payload: {} }, 0), error => error instanceof LibraryError && error.status === 409);
  await assert.rejects(
    table.write("a", { key: "T#0", version: 2, payload: {} }, 1),
    error => !(error instanceof LibraryError) && (error as Error).message === "cancelled",
  );
});
