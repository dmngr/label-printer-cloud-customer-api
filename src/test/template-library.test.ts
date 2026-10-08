import assert from "node:assert/strict";
import test from "node:test";
import { LibraryError, TemplateLibrary, type LibraryRow, type LibraryTable, type LibraryGuard } from "../lib/template-library";
import { libraryRoute } from "../lib/library-routes";
import type { DeviceRecord } from "../types";

class MemoryTable implements LibraryTable {
  rows = new Map<string, LibraryRow>();
  calls: string[] = [];
  async get(group: string, key: string): Promise<LibraryRow | null> {
    this.calls.push(group);
    return structuredClone(this.rows.get(group + "/" + key) ?? null);
  }
  async list(group: string, prefix: string): Promise<LibraryRow[]> {
    this.calls.push(group);
    return [...this.rows.entries()].filter(([key]) => key.startsWith(group + "/" + prefix)).map(([, row]) => structuredClone(row));
  }
  async write(group: string, row: LibraryRow, expected: number, immutable?: LibraryRow, guards: LibraryGuard[] = []): Promise<void> {
    for (const guard of guards) {
      if ((this.rows.get(group + "/" + guard.key)?.version ?? 0) !== guard.version) throw new LibraryError(409, "library_revision_conflict");
    }
    const key = group + "/" + row.key;
    if ((this.rows.get(key)?.version ?? 0) !== expected || (immutable && this.rows.has(group + "/" + immutable.key)))
      throw new LibraryError(409, "library_revision_conflict");
    this.rows.set(key, structuredClone(row));
    if (immutable) this.rows.set(group + "/" + immutable.key, structuredClone(immutable));
  }
}
const id = "00000000-0000-4000-8000-000000000001";
const input = { name: "Dispatch", width: 57, height: 40, layoutJson: '{"inputs":[]}' };
const device = (deviceCode: string, group: string, storeCode: string): DeviceRecord => ({
  deviceCode,
  storeId: group,
  storeCode,
  deviceName: deviceCode,
  appVersion: "1.0.100",
  lastSeenAtUtc: new Date().toISOString(),
  pendingCommands: 0,
  failedJobs: 0,
  installationId: null,
  hostName: null,
  printers: null,
  printersReportedAtUtc: null,
});

test("immutable versions reject concurrent edits and preserve pinned assignments", async () => {
  const table = new MemoryTable();
  const library = new TemplateLibrary(table);
  await library.save("a", id, 0, input);
  await library.saveAssignment("a", "store", "store-1", { expectedRevision: 0, inherit: false, entries: [{ templateId: id, version: 1 }] });
  const outcomes = await Promise.allSettled([
    library.save("a", id, 1, { ...input, name: "Second" }),
    library.save("a", id, 1, { ...input, name: "Lost edit" }),
  ]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await library.get("a", id, 1)).name, "Dispatch");
  assert.equal((await library.resolve("a", "store-1", "new-installation")).templates[0].version, 1);
  assert.equal((await library.get("a", id)).version, 2);
  await assert.rejects(library.get("b", id), error => error instanceof LibraryError && error.status === 404);
});

test("store inheritance, explicit empty override, restoration, and cross-group references", async () => {
  const table = new MemoryTable();
  const library = new TemplateLibrary(table);
  await library.save("a", id, 0, input);
  await library.saveAssignment("a", "store", "s", { expectedRevision: 0, inherit: false, entries: [{ templateId: id, version: 1 }] });
  await library.saveAssignment("a", "installation", "i", { expectedRevision: 0, inherit: false, entries: [] });
  assert.equal((await library.resolve("a", "s", "i")).templates.length, 0);
  assert.equal((await library.resolve("a", "s", "future-i")).templates.length, 1);
  await library.saveAssignment("a", "installation", "i", { expectedRevision: 1, inherit: true, entries: [] });
  assert.equal((await library.resolve("a", "s", "i")).templates.length, 1);
  await assert.rejects(library.saveAssignment("b", "store", "s", { expectedRevision: 0, inherit: false, entries: [{ templateId: id, version: 1 }] }));
  assert.equal((await library.getAssignment("b", "store", "s")).revision, 0);
  await assert.rejects(
    library.saveAssignment("a", "store", "s", { expectedRevision: 0, inherit: false, entries: [] }),
    error => error instanceof LibraryError && error.status === 409,
  );
});

test("HTTP authority comes from token groups and device records, before all library reads/writes", async () => {
  const table = new MemoryTable();
  const library = new TemplateLibrary(table);
  const records = [device("mine", "a", "real-store"), device("other", "b", "real-store")];
  const store = {
    getDevice: async (code: string) => records.find(d => d.deviceCode === code) ?? null,
    scanDevicesByStoreIds: async (groups: ReadonlyArray<string>) => records.filter(d => groups.includes(d.storeId)),
  };
  const call = (path: string, method = "GET", body?: object) =>
    libraryRoute(method, "/api/v1/me/groups" + path, ["a"], body ? JSON.stringify(body) : undefined, undefined, store, library);
  await assert.rejects(call("/b/templates"), error => error instanceof LibraryError && error.status === 403);
  await assert.rejects(
    call("/a/installations/other/assignment", "POST", { expectedRevision: 0, inherit: false, entries: [] }),
    error => error instanceof LibraryError && error.status === 404,
  );
  await assert.rejects(call("/a/stores/guessed/assignment"), error => error instanceof LibraryError && error.status === 404);
  await assert.rejects(
    call("/a/templates/" + id, "POST", { ...input, groupId: "b", expectedVersion: 0 }),
    error => error instanceof LibraryError && error.status === 403,
  );
  assert.equal(table.calls.length, 0);
  assert.equal(table.rows.size, 0);
  assert.equal((await call("/a/templates/" + id, "POST", { ...input, expectedVersion: 0 }))?.status, 201);
  assert.equal(
    (await call("/a/stores/real-store/assignment", "POST", { expectedRevision: 0, inherit: false, entries: [{ templateId: id, version: 1 }] }))
      ?.status,
    200,
  );
  const hierarchy = (await call(""))?.body as { groups: { groupId: string; stores: { storeCode: string; installations: DeviceRecord[] }[] }[] };
  assert.equal(hierarchy.groups[0].stores[0].storeCode, "real-store");
  assert.deepEqual(
    hierarchy.groups[0].stores[0].installations.map(d => d.deviceCode),
    ["mine"],
  );
});

test("storage failure does not resolve to an empty selection", async () => {
  const table = new MemoryTable();
  table.get = async () => {
    throw new Error("network unavailable");
  };
  await assert.rejects(new TemplateLibrary(table).resolve("a", "s", "i"), /network unavailable/);
});
