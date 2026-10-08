/** Per-installation application receipts. Canonical copy: customer-api, copied
 * byte-for-byte to catalog-sync. R# rows contain only bounded receipt metadata;
 * they never replace library definitions, assignments, devices or sessions.
 * Only the privileged agent path records receipts. Customer routes derive the
 * group and installation from authorized device records before reading/retrying.
 */
import { LibraryError, type LibraryTable, type ResolvedLibrary, TemplateLibrary, object, revision } from "./template-library";

export const APPLICATION_REASONS = ["printing_busy", "local_template_modified", "local_code_collision", "invalid_selection", "apply_failed"] as const;
export type ApplicationReason = (typeof APPLICATION_REASONS)[number];
export interface ApplicationReport {
  selectionId: string;
  sequence: number;
  status: "applied" | "pending" | "failed";
  reasonCode: ApplicationReason | null;
  appliedAtUtc: string | null;
}
export interface AppliedSelection {
  selectionId: string;
  source: "store" | "installation";
  revision: number;
  templates: { id: string; name: string; version: number }[];
  appliedAtUtc: string;
  confirmedAtUtc: string;
}
interface ApplicationRecord {
  capabilityVersion: 1;
  report: ApplicationReport | null;
  lastApplied: AppliedSelection | null;
  reportedAtUtc: string;
}
export function parseApplicationReport(value: unknown): ApplicationReport | null {
  if (value === undefined || value === null) return null;
  const input = object(value);
  if (
    typeof input.selectionId !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.selectionId) ||
    typeof input.sequence !== "number" ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    !["applied", "pending", "failed"].includes(String(input.status))
  )
    throw new LibraryError(400, "library_invalid_report");
  const status = input.status as ApplicationReport["status"];
  const reason = input.reasonCode ?? null;
  if (
    (status === "applied" && reason !== null) ||
    (status === "pending" && reason !== "printing_busy") ||
    (status === "failed" && (typeof reason !== "string" || reason === "printing_busy" || !APPLICATION_REASONS.includes(reason as ApplicationReason)))
  )
    throw new LibraryError(400, "library_invalid_report");
  const appliedAtUtc = input.appliedAtUtc ?? null;
  if (
    (status === "applied" &&
      (typeof appliedAtUtc !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(appliedAtUtc) ||
        !Number.isFinite(Date.parse(appliedAtUtc)))) ||
    (status !== "applied" && appliedAtUtc !== null)
  )
    throw new LibraryError(400, "library_invalid_report");
  return {
    selectionId: input.selectionId,
    sequence: input.sequence,
    status,
    reasonCode: reason as ApplicationReason | null,
    appliedAtUtc: appliedAtUtc as string | null,
  };
}
export function applicationKey(deviceCode: string): string {
  if (!deviceCode || deviceCode.length > 255) throw new LibraryError(400, "library_invalid_target");
  return "R#" + Buffer.from(deviceCode).toString("base64url");
}
const brief = (desired: ResolvedLibrary) => ({
  selectionId: desired.selectionId!,
  source: desired.source,
  revision: desired.revision,
  templates: desired.templates.map(({ id, name, version }) => ({ id, name, version })),
});
export class LibraryApplications {
  constructor(
    private readonly table: LibraryTable,
    private readonly library: TemplateLibrary,
  ) {}

  async record(group: string, deviceCode: string, desired: ResolvedLibrary, report: ApplicationReport | null): Promise<void> {
    if (desired.group !== group || !desired.selectionId) throw new Error("Application receipt has no trusted selection");
    // Delayed reports acknowledge an old request, not the current desired state.
    if (report && report.selectionId !== desired.selectionId) return;
    const key = applicationKey(deviceCode);
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.table.get(group, key);
      const previous = row?.payload as ApplicationRecord | undefined;
      // The sequence is installation-wide, including across selection changes.
      // A slow request for A must not overwrite a newer confirmation for B.
      if (previous && (!report || (previous.report && previous.report.sequence >= report.sequence))) return;
      const now = new Date().toISOString();
      const value: ApplicationRecord = {
        capabilityVersion: 1,
        report,
        lastApplied:
          report?.status === "applied"
            ? { ...brief(desired), appliedAtUtc: report.appliedAtUtc!, confirmedAtUtc: now }
            : (previous?.lastApplied ?? null),
        reportedAtUtc: now,
      };
      try {
        await this.table.write(group, { key, version: (row?.version ?? 0) + 1, payload: value }, row?.version ?? 0);
        return;
      } catch (error) {
        if (!(error instanceof LibraryError) || error.status !== 409 || attempt === 2) throw error;
      }
    }
  }

  async status(group: string, storeCode: string, device: { deviceCode: string; deviceName: string; appVersion: string; lastSeenAtUtc: string }) {
    const desired = await this.library.resolve(group, storeCode, device.deviceCode);
    const record = (await this.table.get(group, applicationKey(device.deviceCode)))?.payload as ApplicationRecord | undefined;
    const online = Date.now() - Date.parse(device.lastSeenAtUtc) < 300000;
    const report = record?.report && record.report.selectionId === desired.selectionId ? record.report : null;
    const version = /^(\d+)\.(\d+)\.(\d+)(?:\.|$)/.exec(device.appVersion);
    const legacy = !record && version && Number(version[1]) === 1 && Number(version[2]) === 0 && Number(version[3]) < 106;
    const state = report?.status === "applied" ? "applied" : !online ? "offline" : legacy ? "unsupported" : (report?.status ?? "waiting");
    return {
      deviceCode: device.deviceCode,
      deviceName: device.deviceName,
      isOnline: online,
      state,
      reasonCode: report?.reasonCode ?? null,
      capabilityVersion: record?.capabilityVersion ?? null,
      desired: brief(desired),
      lastApplied: record?.lastApplied ?? null,
      reportedAtUtc: record?.reportedAtUtc ?? null,
    };
  }

  async retry(group: string, storeCode: string, deviceCode: string, expectedSelectionId: unknown) {
    const assignment = await this.library.getAssignment(group, "installation", deviceCode);
    const desired = await this.library.resolve(group, storeCode, deviceCode);
    if (expectedSelectionId !== desired.selectionId) throw new LibraryError(409, "library_revision_conflict");
    // Bump only this installation's revision. Inheritance and every pinned
    // choice stay unchanged; the normal agent poll retries when it is safe.
    return this.library.saveAssignment(group, "installation", deviceCode, {
      expectedRevision: revision(assignment.revision),
      inherit: assignment.inherit,
      entries: assignment.entries,
    });
  }
}
