import assert from "node:assert/strict";
import test from "node:test";
import { LibraryError, TemplateLibrary, type LibraryRow, type LibraryTable, type LibraryGuard } from "../lib/template-library";
import { LibraryApplications, parseApplicationReport, applicationKey, type ApplicationReport } from "../lib/library-application";
import { libraryRoute } from "../lib/library-routes";
import type { DeviceRecord } from "../types";

class MemoryTable implements LibraryTable {
  rows = new Map<string, LibraryRow>();
  reads = 0;
  writes = 0;
  conflict = false;
  async get(group: string, key: string) {
    this.reads++;
    return structuredClone(this.rows.get(group + "/" + key) ?? null);
  }
  async list() {
    return [];
  }
  async write(group: string, row: LibraryRow, expected: number, immutable?: LibraryRow, guards: LibraryGuard[] = []) {
    if (this.conflict) {
      this.conflict = false;
      throw new LibraryError(409, "library_revision_conflict");
    }
    for (const guard of guards) {
      if ((this.rows.get(group + "/" + guard.key)?.version ?? 0) !== guard.version) throw new LibraryError(409, "library_revision_conflict");
    }
    const key = group + "/" + row.key;
    if ((this.rows.get(key)?.version ?? 0) !== expected) throw new LibraryError(409, "library_revision_conflict");
    this.writes++;
    this.rows.set(key, structuredClone(row));
    if (immutable) this.rows.set(group + "/" + immutable.key, structuredClone(immutable));
  }
}
const id = "00000000-0000-4000-8000-000000000001";
const device = (code = "i", group = "a", version = "1.0.106"): DeviceRecord => ({
  deviceCode: code,
  deviceName: code,
  storeCode: "s",
  storeId: group,
  appVersion: version,
  lastSeenAtUtc: new Date().toISOString(),
  pendingCommands: 0,
  failedJobs: 0,
  installationId: null,
  hostName: null,
  printers: null,
  printersReportedAtUtc: null,
});
async function fixture() {
  const table = new MemoryTable();
  const library = new TemplateLibrary(table);
  const applications = new LibraryApplications(table, library);
  await library.save("a", id, 0, { name: "Dispatch", width: 57, height: 40, layoutJson: "{}" });
  await library.saveAssignment("a", "store", "s", { expectedRevision: 0, inherit: false, entries: [{ templateId: id, version: 1 }] });
  return { table, library, applications, desired: await library.resolve("a", "s", "i") };
}
const applied = (selectionId: string, sequence = 1): ApplicationReport => ({
  selectionId,
  sequence,
  status: "applied",
  reasonCode: null,
  appliedAtUtc: "2026-10-08T10:00:00.1234567Z",
});

test("selection identity binds group, store, installation, exact versions and ABA/retry revisions", async () => {
  const { library, applications, desired } = await fixture();
  assert.match(desired.selectionId!, /^[a-f0-9]{64}$/);
  assert.equal((await library.resolve("a", "s", "i")).selectionId, desired.selectionId);
  for (const args of [
    ["b", "s", "i"],
    ["a", "other", "i"],
    ["a", "s", "other"],
  ])
    assert.notEqual((await library.resolve(args[0], args[1], args[2])).selectionId, desired.selectionId);
  await applications.retry("a", "s", "i", desired.selectionId);
  const retried = await library.resolve("a", "s", "i");
  assert.notEqual(retried.selectionId, desired.selectionId);
  assert.deepEqual(retried.templates, desired.templates);
  assert.equal(retried.source, "store");
  await assert.rejects(applications.retry("a", "s", "i", desired.selectionId), error => error instanceof LibraryError && error.status === 409);
  await library.saveAssignment("a", "installation", "i", { expectedRevision: 1, inherit: false, entries: [] });
  const empty = await library.resolve("a", "s", "i");
  assert.equal(empty.templates.length, 0);
  await library.saveAssignment("a", "installation", "i", { expectedRevision: 2, inherit: true, entries: [] });
  assert.notEqual((await library.resolve("a", "s", "i")).selectionId, retried.selectionId);
  await library.save("a", id, 1, { name: "Dispatch v2", width: 57, height: 40, layoutJson: "{}" });
  const pinned = await library.resolve("a", "s", "i");
  assert.equal(pinned.templates[0].version, 1);
  await library.saveAssignment("a", "store", "s", { expectedRevision: 1, inherit: false, entries: [{ templateId: id, version: 2 }] });
  assert.notEqual((await library.resolve("a", "s", "i")).selectionId, pinned.selectionId);
});

test("receipts are idempotent, reject delayed outcomes, and retain the last confirmed success", async () => {
  const { table, library, applications, desired } = await fixture();
  await applications.record("a", "i", desired, null);
  const writes = table.writes;
  await applications.record("a", "i", desired, null);
  assert.equal(table.writes, writes);
  table.conflict = true;
  await applications.record("a", "i", desired, applied(desired.selectionId!, 10));
  const confirmed = await applications.status("a", "s", device());
  assert.equal(confirmed.state, "applied");
  assert.equal(confirmed.lastApplied?.templates[0].version, 1);
  await applications.record("a", "i", desired, {
    selectionId: desired.selectionId!,
    sequence: 9,
    status: "pending",
    reasonCode: "printing_busy",
    appliedAtUtc: null,
  });
  assert.equal((await applications.status("a", "s", device())).state, "applied");
  await applications.retry("a", "s", "i", desired.selectionId);
  const next = await library.resolve("a", "s", "i");
  assert.equal((await applications.status("a", "s", device())).state, "waiting");
  await applications.record("a", "i", next, applied(desired.selectionId!, 11));
  assert.equal((await applications.status("a", "s", device())).state, "waiting");
  await applications.record("a", "i", next, {
    selectionId: next.selectionId!,
    sequence: 12,
    status: "failed",
    reasonCode: "local_template_modified",
    appliedAtUtc: null,
  });
  const failed = await applications.status("a", "s", device());
  assert.equal(failed.state, "failed");
  assert.equal(failed.lastApplied?.selectionId, desired.selectionId);
  await applications.record("a", "i", next, applied(next.selectionId!, 13));
  // An old HTTP invocation resolved its desired state before the newer one.
  await applications.record("a", "i", desired, applied(desired.selectionId!, 10));
  assert.equal((await applications.status("a", "s", device())).lastApplied?.selectionId, next.selectionId);
  assert.ok(table.rows.has("a/" + applicationKey("i")));
});

test("offline and legacy installations are never represented as confirmed without a receipt", async () => {
  const { applications, desired } = await fixture();
  assert.equal((await applications.status("a", "s", device("i", "a", "1.0.105"))).state, "unsupported");
  assert.equal((await applications.status("a", "s", device("i", "a", "unknown"))).state, "waiting");
  const offline = { ...device(), lastSeenAtUtc: "2026-01-01T00:00:00Z" };
  assert.equal((await applications.status("a", "s", offline)).state, "offline");
  await applications.record("a", "i", desired, applied(desired.selectionId!));
  const confirmed = await applications.status("a", "s", offline);
  assert.equal(confirmed.state, "applied");
  assert.equal(confirmed.isOnline, false);
});

test("receipt parsing rejects malformed status, arbitrary messages, unsafe sequences and invalid timestamps", () => {
  const valid = applied("a".repeat(64));
  assert.deepEqual(parseApplicationReport(valid), valid);
  assert.equal(parseApplicationReport(undefined), null);
  for (const change of [
    { sequence: 0 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { selectionId: "guess" },
    { status: "success" },
    { reasonCode: "secret exception" },
    { appliedAtUtc: "2026-10-08" },
    { status: "pending", reasonCode: "printing_busy" },
  ])
    assert.throws(() => parseApplicationReport({ ...valid, ...change }));
  assert.equal(parseApplicationReport({ ...valid, status: "pending", reasonCode: "printing_busy", appliedAtUtc: null })?.status, "pending");
});

test("status and retry authorize token group plus installation before any library access", async () => {
  const { table, library, applications, desired } = await fixture();
  const records = [device(), device("other", "b")];
  const store = {
    getDevice: async (code: string) => records.find(d => d.deviceCode === code) ?? null,
    scanDevicesByStoreIds: async (groups: ReadonlyArray<string>) => records.filter(d => groups.includes(d.storeId)),
  };
  const call = (path: string, method = "GET", body?: object) =>
    libraryRoute(method, "/api/v1/me/groups" + path, ["a"], body ? JSON.stringify(body) : undefined, undefined, store, library, applications);
  const reads = table.reads;
  const writes = table.writes;
  for (const path of ["/b/stores/s/applications", "/a/stores/missing/applications", "/a/installations/other/applications"])
    await assert.rejects(call(path), error => error instanceof LibraryError && [403, 404].includes(error.status));
  await assert.rejects(call("/a/installations/other/applications/retry", "POST", { expectedSelectionId: desired.selectionId }));
  await assert.rejects(call("/a/installations/i/applications/retry", "POST", { group: "b", expectedSelectionId: desired.selectionId }));
  assert.equal(table.reads, reads);
  assert.equal(table.writes, writes);
  const response = (await call("/a/stores/s/applications"))?.body as { items: { deviceCode: string }[] };
  assert.deepEqual(
    response.items.map(item => item.deviceCode),
    ["i"],
  );
  assert.equal((await call("/a/installations/i/applications/retry", "POST", { expectedSelectionId: desired.selectionId }))?.status, 202);
});
