/** Print request protocol 1: the caller owns the text, time and request identity.
 * Local and cloud carry the identical intent; cloud never hydrates/rewrites it
 * from a later catalog. Authorization binds device/tenant before receipt access.
 * Fingerprints use two IEEE754 little-endian doubles followed by UTF-8 layout
 * bytes, matching LabelPrinter.Core.Labels.SharedPrintRequest.Fingerprint.
 */
import { createHash } from "node:crypto";

export class PrintRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export interface SharedPrintRequest {
  protocolVersion: 1;
  printRequestId: string;
  deviceCode: string;
  templateCode: string;
  templateFingerprint: string;
  printerName: string;
  quantity: number;
  fields: Record<string, string | null>;
  expiresAtUtc: string | null;
}
const invalid = (): never => {
  throw new PrintRequestError(400, "print_request_invalid");
};
function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && value === value.trim() && !/\p{Cc}/u.test(value);
}
export function parseSharedPrintRequest(value: unknown): SharedPrintRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const v = value as Record<string, unknown>;
  const keys = [
    "protocolVersion",
    "printRequestId",
    "deviceCode",
    "templateCode",
    "templateFingerprint",
    "printerName",
    "quantity",
    "fields",
    "expiresAtUtc",
  ];
  if (
    Object.keys(v).some(key => !keys.includes(key)) ||
    v.protocolVersion !== 1 ||
    !text(v.printRequestId, 128) ||
    /[^A-Za-z0-9_.:-]/u.test(v.printRequestId) ||
    !text(v.deviceCode, 255) ||
    !text(v.templateCode, 100) ||
    !text(v.printerName, 255) ||
    !text(v.templateFingerprint, 71) ||
    !/^sha256:[a-f0-9]{64}$/u.test(v.templateFingerprint)
  )
    return invalid();
  const quantity = v.quantity === undefined ? 1 : v.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) return invalid();
  const input = v.fields === undefined ? {} : v.fields;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 64) return invalid();
  const fields: Record<string, string | null> = {};
  for (const [key, item] of Object.entries(input)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,99}$/u.test(key) ||
      /[\r\n]/u.test(key) ||
      Object.hasOwn(fields, key.toLowerCase()) ||
      (item !== null && (typeof item !== "string" || item.length > 4096))
    )
      return invalid();
    fields[key.toLowerCase()] = item as string | null;
  }
  const expires = v.expiresAtUtc ?? null;
  if (
    expires !== null &&
    (typeof expires !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(expires) ||
      expires.startsWith("0000") ||
      !Number.isFinite(Date.parse(expires)) ||
      new Date(expires).toISOString().replace(".000Z", "Z") !== expires)
  )
    return invalid();
  const normalized: SharedPrintRequest = {
    protocolVersion: 1,
    printRequestId: v.printRequestId,
    deviceCode: v.deviceCode,
    templateCode: v.templateCode.replace(/[a-z]/g, c => c.toUpperCase()),
    templateFingerprint: v.templateFingerprint,
    printerName: v.printerName,
    quantity,
    fields,
    expiresAtUtc: expires as string | null,
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > 256 * 1024) return invalid();
  return normalized;
}
export function canonical(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(k => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function printIntentFingerprint(value: SharedPrintRequest): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function templateFingerprint(width: number, height: number, layout: string): string {
  const dimensions = Buffer.alloc(16);
  dimensions.writeDoubleLE(width, 0);
  dimensions.writeDoubleLE(height, 8);
  return "sha256:" + createHash("sha256").update(dimensions).update(layout, "utf8").digest("hex");
}
