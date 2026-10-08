import assert from "node:assert/strict";
import { after, test } from "node:test";
import { FakeDynamo } from "./fake-dynamo";
import { LibraryError, TemplateLibrary } from "../lib/template-library";
import { DynamoTemplateLibraryTable } from "../storage/template-library-table";
import { libraryRoute } from "../lib/library-routes";

const db = new FakeDynamo();
after(db.install());
const tableName = "DMLabelPrinterCloudTemplateLibrary";
const table = new DynamoTemplateLibraryTable(tableName);
const library = new TemplateLibrary(table);
const id = "00000000-0000-4000-8000-000000000001";
const input = { name: "Archive acceptance", width: 57, height: 40, layoutJson: '{"elements":[],"custom":{"retained":true}}' };
const entry = { templateId: id, version: 1 };
const selection = { expectedRevision: 0, inherit: false, entries: [entry] };
const code =
  (expected: string) =>
  (error: unknown): boolean =>
    error instanceof LibraryError && error.code === expected;
const conflict = code("library_revision_conflict");
const archived = code("library_template_archived");

test("archive and restore change only state; old pinned versions, selection hash and content remain exact", async () => {
  const group = "preserve";
  await library.save(group, id, 0, input);
  await library.save(group, id, 1, { ...input, name: "New content" });
  await library.saveAssignment(group, "store", "s", selection);
  const before = await library.resolve(group, "s", "i");
  const assignment = await library.getAssignment(group, "store", "s");
  const rows = [...db.table(tableName)].filter(([key]) => key.startsWith(group + "/"));
  assert.equal((await library.list(group))[0].archiveRevision, 0);
  const result = await library.setArchived(group, id, 2, 0, true);
  assert.equal(result.version, 2);
  assert.equal(result.archiveRevision, 1);
  assert.deepEqual(await library.list(group), []);
  assert.equal((await library.list(group, true))[0].archived, true);
  for (const [key, row] of rows) assert.deepEqual(db.table(tableName).get(key), row);
  assert.deepEqual(await library.resolve(group, "s", "i"), before);
  assert.deepEqual(await library.getAssignment(group, "store", "s"), assignment);
  assert.equal((await library.get(group, id, 1)).layoutJson, input.layoutJson);
  assert.equal((await library.get(group, id)).version, 2);
  await assert.rejects(library.save(group, id, 2, input), archived);
  await assert.rejects(library.saveAssignment(group, "installation", "new", selection), archived);
  await assert.rejects(
    library.saveAssignment(group, "store", "s", { ...selection, expectedRevision: 1, entries: [{ ...entry, version: 2 }] }),
    archived,
  );
  const retained = await library.saveAssignment(group, "store", "s", {
    ...selection,
    expectedRevision: 1,
    entries: [{ ...entry, printerName: "Other printer" }],
  });
  assert.equal(retained.entries[0].version, 1);
  assert.equal(retained.entries[0].printerName, "Other printer");
  const restore = await library.setArchived(group, id, 2, 1, false);
  assert.equal(restore.archiveRevision, 2);
  assert.equal((await library.list(group)).length, 1);
  assert.equal((await library.save(group, id, 2, input)).archiveRevision, 2);
  await library.saveAssignment(group, "installation", "new", selection);
  assert.equal((await library.getAssignment(group, "installation", "new")).entries.length, 1);
});

test("stale content/archive revisions reject; idempotent same-state request creates no version", async () => {
  const group = "revisions";
  await library.save(group, id, 0, input);
  await assert.rejects(library.setArchived(group, id, 0, 0, true), conflict);
  await assert.rejects(library.setArchived(group, id, 1, 1, true), conflict);
  await library.setArchived(group, id, 1, 0, true);
  const writes = db.calls.filter(call => call.kind === "TransactWriteItemsCommand").length;
  assert.equal((await library.setArchived(group, id, 1, 1, true)).archiveRevision, 1);
  assert.equal(db.calls.filter(call => call.kind === "TransactWriteItemsCommand").length, writes);
  await assert.rejects(library.setArchived(group, id, 1, 0, false), conflict);
  await library.setArchived(group, id, 1, 1, false);
  await assert.rejects(library.setArchived(group, id, 1, 0, true), conflict);
  await assert.rejects(library.setArchived("missing", id, 1, 0, true), code("library_template_not_found"));
});

async function race(beforeTransaction: () => Promise<unknown>, operation: () => Promise<unknown>): Promise<void> {
  const send = db.send.bind(db);
  let fired = false;
  db.send = async command => {
    if (!fired && command.kind === "TransactWriteItemsCommand") {
      fired = true;
      await beforeTransaction();
    }
    return send(command);
  };
  try {
    await assert.rejects(operation(), conflict);
    assert.equal(fired, true);
  } finally {
    db.send = send;
  }
}
test("archive after edit validation cancels the entire content/version transaction", async () => {
  const group = "race-edit";
  await library.save(group, id, 0, input);
  await race(
    () => library.setArchived(group, id, 1, 0, true),
    () => library.save(group, id, 1, { ...input, name: "Must not persist" }),
  );
  assert.equal((await library.get(group, id)).version, 1);
  await assert.rejects(library.get(group, id, 2), code("library_template_not_found"));
});
test("archive after new-assignment validation cancels its write", async () => {
  const group = "race-assignment";
  await library.save(group, id, 0, input);
  await race(
    () => library.setArchived(group, id, 1, 0, true),
    () => library.saveAssignment(group, "store", "s", selection),
  );
  assert.equal((await library.getAssignment(group, "store", "s")).revision, 0);
});
test("content edit after archive validation cancels the archive", async () => {
  const group = "race-archive";
  await library.save(group, id, 0, input);
  await race(
    () => library.save(group, id, 1, input),
    () => library.setArchived(group, id, 1, 0, true),
  );
  assert.equal((await library.list(group))[0].version, 2);
  assert.equal((await library.list(group))[0].archiveRevision, 0);
});
test("restore-then-rearchive between validation and write is detected even though state was active", async () => {
  const group = "race-cycle";
  await library.save(group, id, 0, input);
  await race(
    async () => {
      await library.setArchived(group, id, 1, 0, true);
      await library.setArchived(group, id, 1, 1, false);
    },
    () => library.saveAssignment(group, "store", "s", selection),
  );
  assert.equal((await library.getAssignment(group, "store", "s")).revision, 0);
});
test("state read/query failures and malformed state fail loudly, never active or empty", async () => {
  const group = "failed-state";
  await library.save(group, id, 0, input);
  const send = db.send.bind(db);
  db.send = async command => {
    const text = JSON.stringify(command.input);
    if (text.includes("S#")) throw new Error("state unavailable");
    return send(command);
  };
  try {
    await assert.rejects(library.list(group), /state unavailable/);
    await assert.rejects(library.save(group, id, 1, input), /state unavailable/);
    await assert.rejects(library.saveAssignment(group, "store", "s", selection), /state unavailable/);
  } finally {
    db.send = send;
  }
  await table.write(group, { key: "S#" + id, version: 1, payload: { archived: "false" } }, 0);
  await assert.rejects(library.list(group), /Invalid stored archive state/);
  await assert.rejects(library.save(group, id, 1, input), /Invalid stored archive state/);
});
test("transaction cancellation without reasons proves changed guard revision or preserves unknown outage", async () => {
  const group = "no-reasons";
  await library.save(group, id, 0, input);
  await library.setArchived(group, id, 1, 0, true);
  const send = db.send.bind(db);
  db.send = async command => {
    if (command.kind === "TransactWriteItemsCommand") throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
    return send(command);
  };
  try {
    await assert.rejects(table.write(group, { key: "T#" + id, version: 2, payload: {} }, 1, undefined, [{ key: "S#" + id, version: 0 }]), conflict);
    await assert.rejects(
      table.write(group, { key: "T#" + id, version: 2, payload: {} }, 1, undefined, [{ key: "S#" + id, version: 1 }]),
      error => !(error instanceof LibraryError) && (error as Error).message === "cancelled",
    );
  } finally {
    db.send = send;
  }
});
test("archive route derives group from grants and rejects malformed bodies before storage", async () => {
  const store = { getDevice: async () => null, scanDevicesByStoreIds: async () => [] };
  const call = (group: string, body: object) =>
    libraryRoute("POST", `/api/v1/me/groups/${group}/templates/${id}/archive`, ["route"], JSON.stringify(body), undefined, store, library);
  const body = { expectedVersion: 1, expectedArchiveRevision: 0, archived: true };
  const before = db.calls.length;
  await assert.rejects(call("foreign", body), code("library_forbidden_group"));
  await assert.rejects(call("route", { ...body, groupId: "foreign" }), code("library_forbidden_group"));
  await assert.rejects(call("route", { ...body, group: "foreign" }), code("library_forbidden_group"));
  await assert.rejects(call("route", { ...body, archived: "true" }), code("library_invalid_archive"));
  await assert.rejects(call("route", { ...body, expectedArchiveRevision: -1 }), code("library_invalid_revision"));
  assert.equal(db.calls.length, before);
  await library.save("route", id, 0, input);
  assert.equal((await call("route", body))?.status, 200);
  const listed = await libraryRoute("GET", "/api/v1/me/groups/route/templates", ["route"], undefined, { includeArchived: "true" }, store, library);
  assert.equal((listed?.body as { items: unknown[] }).items.length, 1);
  const active = await libraryRoute("GET", "/api/v1/me/groups/route/templates", ["route"], undefined, undefined, store, library);
  assert.deepEqual(active?.body, { items: [] });
});
