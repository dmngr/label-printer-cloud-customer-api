/** Authenticated customer library routes. Legacy token StoreIds contain GROUP
 * grants, not physical store codes. Validate that grant first, then derive each
 * target store/installation from the authorized device records. Body group ids
 * cannot select a different partition. Existing /stores clients stay compatible.
 */
import { definition, LibraryError, object, revision, TemplateLibrary } from "./template-library";
import { readTemplateInputs } from "./template-inputs";
import type { DeviceRecord } from "../types";
import type { LibraryApplications } from "./library-application";
export interface LibraryRouteStore {
  scanDevicesByStoreIds(groups: ReadonlyArray<string>): Promise<DeviceRecord[]>;
  getDevice(deviceCode: string): Promise<DeviceRecord | null>;
}
export async function libraryRoute(
  method: string,
  path: string,
  groups: string[],
  rawBody: string | undefined,
  query: Record<string, string | undefined> | undefined,
  store: LibraryRouteStore,
  library: TemplateLibrary,
  applications?: LibraryApplications,
): Promise<{ status: number; body: unknown } | null> {
  if (path === "/api/v1/me/groups" && method === "GET") {
    const records = await store.scanDevicesByStoreIds(groups);
    return {
      status: 200,
      body: {
        groups: groups.map(group => ({
          groupId: group,
          stores: [...new Set(records.filter(d => d.storeId === group).map(d => d.storeCode))].sort().map(storeCode => ({
            storeCode,
            installations: records
              .filter(d => d.storeId === group && d.storeCode === storeCode)
              .map(d => ({
                ...d,
                groupId: group,
                isOnline: Date.now() - Date.parse(d.lastSeenAtUtc) < 300000,
                isActive: Date.now() - Date.parse(d.lastSeenAtUtc) < 3600000,
              })),
          })),
        })),
      },
    };
  }
  if (!path.startsWith("/api/v1/me/groups/")) return null;
  let parts: string[];
  try {
    parts = path.slice("/api/v1/me/groups/".length).split("/").map(decodeURIComponent);
  } catch {
    throw new LibraryError(400, "library_invalid_path");
  }
  const asserted = parts[0];
  const group = groups.find(allowed => allowed === asserted);
  if (!group) throw new LibraryError(403, "library_forbidden_group");
  const body = (): Record<string, unknown> => {
    let parsed: Record<string, unknown>;
    try {
      parsed = object(JSON.parse(rawBody ?? ""));
    } catch {
      throw new LibraryError(400, "library_invalid_body");
    }
    if ((parsed.groupId !== undefined && parsed.groupId !== group) || (parsed.group !== undefined && parsed.group !== group))
      throw new LibraryError(403, "library_forbidden_group");
    return parsed;
  };
  if (parts[1] === "templates") {
    if (parts.length === 2 && method === "GET") return { status: 200, body: { items: await library.list(group) } };
    if (parts.length === 3 && method === "GET")
      return { status: 200, body: await library.get(group, parts[2], query?.version === undefined ? undefined : Number(query.version)) };
    if (parts.length === 3 && method === "POST") {
      const input = body();
      const template = definition(input);
      try {
        readTemplateInputs(template.layoutJson);
      } catch {
        throw new LibraryError(400, "library_invalid_inputs");
      }
      return { status: 201, body: await library.save(group, parts[2], revision(input.expectedVersion), template) };
    }
  }
  if ((parts[1] === "stores" || parts[1] === "installations") && parts.length === 4 && parts[3] === "assignment") {
    const target = parts[2];
    const kind = parts[1] === "stores" ? "store" : "installation";
    if (kind === "installation") {
      const device = await store.getDevice(target);
      if (!device || device.storeId !== group) throw new LibraryError(404, "library_target_not_found");
    } else {
      const devices = await store.scanDevicesByStoreIds([group]);
      if (!target || !devices.some(device => device.storeId === group && device.storeCode === target))
        throw new LibraryError(404, "library_target_not_found");
    }
    if (method === "GET") return { status: 200, body: await library.getAssignment(group, kind, target) };
    if (method === "POST") return { status: 200, body: await library.saveAssignment(group, kind, target, body()) };
  }
  if ((parts[1] === "stores" || parts[1] === "installations") && parts.length === 4 && parts[3] === "applications" && method === "GET") {
    const target = parts[2];
    const devices =
      parts[1] === "installations"
        ? [await store.getDevice(target)].filter((device): device is DeviceRecord => device !== null && device.storeId === group)
        : (await store.scanDevicesByStoreIds([group])).filter(device => device.storeId === group && device.storeCode === target);
    if (!target || !devices.length) throw new LibraryError(404, "library_target_not_found");
    if (!applications) throw new Error("Library application service is not configured");
    const items = [];
    // Bound backend concurrency even for stores with many installations.
    for (const device of devices) items.push(await applications.status(group, device.storeCode, device));
    return { status: 200, body: { items } };
  }
  if (parts[1] === "installations" && parts.length === 5 && parts[3] === "applications" && parts[4] === "retry" && method === "POST") {
    const device = await store.getDevice(parts[2]);
    if (!device || device.storeId !== group) throw new LibraryError(404, "library_target_not_found");
    const input = body();
    if (!applications) throw new Error("Library application service is not configured");
    const assignment = await applications.retry(group, device.storeCode, device.deviceCode, input.expectedSelectionId);
    return { status: 202, body: { accepted: true, assignmentRevision: assignment.revision, previousAssignmentRevision: assignment.revision - 1 } };
  }
  throw new LibraryError(404, "library_route_not_found");
}
