/**
 * Group template library v1. Canonical: customer-api; catalog-sync consumes an
 * identical copy. The authenticated caller supplies the allowed group context;
 * HTTP path/body values alone never authorize a partition. Versions are immutable
 * and assignments pin them. Installation overrides replace a store selection;
 * inherit=true restores it, while an explicit empty selection disables all.
 * Reads fail loudly: a failed lookup must never become an empty assignment.
 */
import { createHash } from "node:crypto";

export class LibraryError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
export interface TemplateDefinition {
  name: string;
  width: number;
  height: number;
  layoutJson: string;
}
export interface LibraryTemplate extends TemplateDefinition {
  id: string;
  version: number;
  updatedAtUtc: string;
}
export type TemplateHead = Omit<LibraryTemplate, "layoutJson">;
export interface AssignmentEntry {
  templateId: string;
  version: number;
  printerName?: string;
}
export interface TemplateAssignment {
  revision: number;
  inherit: boolean;
  entries: AssignmentEntry[];
}
export interface ResolvedLibrary {
  group: string;
  source: "installation" | "store";
  revision: number;
  templates: (LibraryTemplate & { printerName?: string })[];
}
export interface LibraryRow {
  key: string;
  version: number;
  payload: unknown;
}
export interface LibraryTable {
  get(group: string, key: string): Promise<LibraryRow | null>;
  list(group: string, prefix: string): Promise<LibraryRow[]>;
  write(group: string, row: LibraryRow, expectedVersion: number, immutable?: LibraryRow): Promise<void>;
}
export const MAX_ASSIGNMENTS = 32;
export function libraryId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new LibraryError(400, "library_invalid_id");
  return value.toLowerCase();
}
export function localTemplateCode(group: string, id: string): string {
  return "CLOUD_" + createHash("sha256").update(group).digest("hex").slice(0, 12).toUpperCase() + "_" + libraryId(id).replace(/-/g, "");
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LibraryError(400, "library_invalid_body");
  return value as Record<string, unknown>;
}
export function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= 1000000000)
    throw new LibraryError(400, "library_invalid_revision");
  return value;
}
export function definition(value: unknown): TemplateDefinition {
  const body = object(value);
  if (
    typeof body.name !== "string" ||
    !body.name.trim() ||
    body.name.length > 200 ||
    typeof body.width !== "number" ||
    !Number.isFinite(body.width) ||
    body.width <= 0 ||
    body.width > 1000 ||
    typeof body.height !== "number" ||
    !Number.isFinite(body.height) ||
    body.height <= 0 ||
    body.height > 1000 ||
    typeof body.layoutJson !== "string" ||
    Buffer.byteLength(body.layoutJson, "utf8") > 32768
  )
    throw new LibraryError(400, "library_invalid_template");
  let layout: Record<string, unknown>;
  try {
    layout = object(JSON.parse(body.layoutJson));
  } catch {
    throw new LibraryError(400, "library_invalid_layout");
  }
  // The Windows renderer owns layout interpretation. Check object/array shape
  // here; the shared input validator additionally validates explicit schemas.
  if (layout.elements !== undefined && !Array.isArray(layout.elements)) throw new LibraryError(400, "library_invalid_layout");
  return { name: body.name.trim(), width: body.width, height: body.height, layoutJson: body.layoutJson };
}
export function assignment(value: unknown): { expectedRevision: number; inherit: boolean; entries: AssignmentEntry[] } {
  const body = object(value);
  const expectedRevision = revision(body.expectedRevision);
  if (
    typeof body.inherit !== "boolean" ||
    !Array.isArray(body.entries) ||
    body.entries.length > MAX_ASSIGNMENTS ||
    (body.inherit && body.entries.length)
  )
    throw new LibraryError(400, "library_invalid_assignment");
  const seen = new Set<string>();
  const entries = body.entries.map(raw => {
    const entry = object(raw);
    if (typeof entry.templateId !== "string") throw new LibraryError(400, "library_invalid_id");
    const templateId = libraryId(entry.templateId);
    const version = revision(entry.version);
    if (version === 0 || seen.has(templateId)) throw new LibraryError(400, "library_invalid_assignment");
    seen.add(templateId);
    if (entry.printerName !== undefined && (typeof entry.printerName !== "string" || !entry.printerName.trim() || entry.printerName.length > 255))
      throw new LibraryError(400, "library_invalid_printer");
    return { templateId, version, ...(typeof entry.printerName === "string" ? { printerName: entry.printerName.trim() } : {}) };
  });
  return { expectedRevision, inherit: body.inherit, entries };
}
export function assignmentKey(kind: "store" | "installation", target: string): string {
  if (!target || target.length > 255) throw new LibraryError(400, "library_invalid_target");
  return `A#${kind}#${Buffer.from(target).toString("base64url")}`;
}
const versionKey = (id: string, version: number): string => `V#${libraryId(id)}#${String(version).padStart(10, "0")}`;

export class TemplateLibrary {
  constructor(private readonly table: LibraryTable) {}

  async list(group: string): Promise<TemplateHead[]> {
    return (await this.table.list(group, "T#"))
      .map(row => row.payload as TemplateHead)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async get(group: string, id: string, version?: number): Promise<LibraryTemplate> {
    id = libraryId(id);
    if (version === undefined) {
      const head = await this.table.get(group, `T#${id}`);
      if (!head) throw new LibraryError(404, "library_template_not_found");
      version = head.version;
    }
    if (revision(version) === 0) throw new LibraryError(400, "library_invalid_revision");
    const row = await this.table.get(group, versionKey(id, version));
    if (!row) throw new LibraryError(404, "library_template_not_found");
    return row.payload as LibraryTemplate;
  }

  async save(group: string, id: string, expectedVersion: number, input: TemplateDefinition): Promise<LibraryTemplate> {
    id = libraryId(id);
    const version = revision(expectedVersion) + 1;
    const template: LibraryTemplate = { ...definition(input), id, version, updatedAtUtc: new Date().toISOString() };
    const { layoutJson: _layout, ...head } = template;
    await this.table.write(group, { key: `T#${id}`, version, payload: head }, expectedVersion, {
      key: versionKey(id, version),
      version,
      payload: template,
    });
    return template;
  }

  async getAssignment(group: string, kind: "store" | "installation", target: string): Promise<TemplateAssignment> {
    const row = await this.table.get(group, assignmentKey(kind, target));
    return row ? (row.payload as TemplateAssignment) : { revision: 0, inherit: kind === "installation", entries: [] };
  }

  async saveAssignment(group: string, kind: "store" | "installation", target: string, value: unknown): Promise<TemplateAssignment> {
    const parsed = assignment(value);
    if (kind === "store" && parsed.inherit) throw new LibraryError(400, "library_invalid_assignment");
    // Resolve every reference before the one conditional write: another group's
    // id or a missing version cannot become an unusable persisted selection.
    await Promise.all(parsed.entries.map(entry => this.get(group, entry.templateId, entry.version)));
    const result = { revision: parsed.expectedRevision + 1, inherit: parsed.inherit, entries: parsed.entries };
    await this.table.write(group, { key: assignmentKey(kind, target), version: result.revision, payload: result }, parsed.expectedRevision);
    return result;
  }

  async resolve(group: string, storeCode: string, deviceCode: string): Promise<ResolvedLibrary> {
    const override = await this.getAssignment(group, "installation", deviceCode);
    const useStore = override.inherit;
    const selected =
      useStore && storeCode
        ? await this.getAssignment(group, "store", storeCode)
        : useStore
          ? { revision: 0, inherit: false, entries: [] }
          : override;
    const templates = await Promise.all(
      selected.entries.map(async entry => ({
        ...(await this.get(group, entry.templateId, entry.version)),
        ...(entry.printerName ? { printerName: entry.printerName } : {}),
      })),
    );
    return { group, source: useStore ? "store" : "installation", revision: selected.revision, templates };
  }
}
