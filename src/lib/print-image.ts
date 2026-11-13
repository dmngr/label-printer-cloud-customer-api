/** PNG history v1. Canonical owner: printjob-sync; copy byte-for-byte to customer-api.
 * No print command is created by this contract. Scope always comes from verified
 * device credentials or the authorized device record, never from object keys.
 */
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export const MAX_PNG_BYTES = 1024 * 1024;
export interface ImageScope {
  group: string;
  storeCode: string;
  installationId: string;
  deviceCode: string;
}
export interface PrintImageManifest {
  version: 1;
  artifactId: string;
  localJobId: number;
  jobCreatedAtUtc: string;
  attempt: number;
  copyIndex: number;
  copyCount: number;
  reprintOfJobId: number | null;
  capturedAtUtc: string;
  widthMm: number;
  heightMm: number;
  dpiX: number;
  dpiY: number;
  pixelWidth: number;
  pixelHeight: number;
  templateCode: string;
  templateSha256: string;
  renderer: "gdi-raster-v1";
  hardMarginX: number;
  hardMarginY: number;
  sha256: string;
  byteLength: number;
}
export class PrintImageError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}
const invalid = (): never => {
  throw new PrintImageError("print_image_invalid", 400);
};
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const decimal = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const utc = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const keys =
  "version artifactId localJobId jobCreatedAtUtc attempt copyIndex copyCount reprintOfJobId capturedAtUtc widthMm heightMm dpiX dpiY pixelWidth pixelHeight templateCode templateSha256 renderer hardMarginX hardMarginY sha256 byteLength"
    .split(" ")
    .sort()
    .join(",");

export function parseImageManifest(value: unknown): PrintImageManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== keys ||
    v.version !== 1 ||
    !hex(v.artifactId) ||
    !hex(v.sha256) ||
    !hex(v.templateSha256) ||
    !integer(v.localJobId, 1, 2147483647) ||
    !integer(v.attempt, 1, 2147483647) ||
    !integer(v.copyIndex, 1, 10000) ||
    !integer(v.copyCount, v.copyIndex as number, 10000) ||
    (v.reprintOfJobId !== null && !integer(v.reprintOfJobId, 1, 2147483647)) ||
    !utc(v.jobCreatedAtUtc) ||
    !utc(v.capturedAtUtc) ||
    !decimal(v.widthMm, 1, 500) ||
    !decimal(v.heightMm, 1, 500) ||
    !decimal(v.dpiX, 72, 1200) ||
    !decimal(v.dpiY, 72, 1200) ||
    !integer(v.pixelWidth, 1, 4096) ||
    !integer(v.pixelHeight, 1, 4096) ||
    v.pixelWidth * v.pixelHeight > 4_000_000 ||
    !decimal(v.hardMarginX, 0, 5000) ||
    !decimal(v.hardMarginY, 0, 5000) ||
    typeof v.templateCode !== "string" ||
    v.templateCode.length > 128 ||
    v.renderer !== "gdi-raster-v1" ||
    !integer(v.byteLength, 1, MAX_PNG_BYTES)
  )
    return invalid();
  if (Math.abs(v.pixelWidth - (v.widthMm * v.dpiX) / 25.4) > 3 || Math.abs(v.pixelHeight - (v.heightMm * v.dpiY) / 25.4) > 3) return invalid();
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map(key => [key, v[key]]),
  ) as unknown as PrintImageManifest;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function validatePng(bytes: Buffer, manifest: PrintImageManifest): void {
  if (
    bytes.length !== manifest.byteLength ||
    bytes.length > MAX_PNG_BYTES ||
    hash(bytes) !== manifest.sha256 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return invalid();
  let offset = 8,
    chunks = 0,
    channels = 0,
    ended = false,
    idatEnded = false;
  const data: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12 || ++chunks > 10000) return invalid();
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length))
      return invalid();
    if (chunks === 1) {
      if (
        type !== "IHDR" ||
        length !== 13 ||
        body.readUInt32BE(0) !== manifest.pixelWidth ||
        body.readUInt32BE(4) !== manifest.pixelHeight ||
        body[8] !== 8 ||
        ![0, 2, 4, 6].includes(body[9]) ||
        body[10] !== 0 ||
        body[11] !== 0 ||
        body[12] !== 0
      )
        return invalid();
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[body[9]];
    } else if (type === "IHDR" || type === "acTL" || type === "fcTL" || type === "fdAT") return invalid();
    else if (type === "IDAT") {
      if (idatEnded) return invalid();
      data.push(body);
    } else if (type === "IEND") {
      if (length !== 0) return invalid();
      ended = true;
    } else if (type !== "PLTE" && type[0] === type[0].toUpperCase()) return invalid();
    if (data.length && type !== "IDAT") idatEnded = true;
    offset += 12 + length;
    if (ended) break;
  }
  if (!ended || offset !== bytes.length || data.length === 0) return invalid();
  const stride = manifest.pixelWidth * channels + 1;
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(data), { maxOutputLength: stride * manifest.pixelHeight });
  } catch {
    return invalid();
  }
  if (inflated.length !== stride * manifest.pixelHeight) return invalid();
  for (let row = 0; row < manifest.pixelHeight; row++) if (inflated[row * stride] > 4) return invalid();
}

export function decodeImage(value: unknown, manifest: PrintImageManifest): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return invalid();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return invalid();
  validatePng(bytes, manifest);
  return bytes;
}

export function imagePrefix(scope: ImageScope, localJobId: number, createdAtUtc: string): string {
  if (
    ![scope.group, scope.storeCode, scope.installationId, scope.deviceCode].every(
      value => typeof value === "string" && value.length > 0 && value.length <= 128,
    ) ||
    !utc(createdAtUtc) ||
    !integer(localJobId, 1, 2147483647)
  )
    return invalid();
  return (
    "label-images/v1/" +
    hash(JSON.stringify([scope.group, scope.storeCode, scope.installationId, scope.deviceCode])) +
    "/" +
    hash(JSON.stringify([localJobId, new Date(createdAtUtc).toISOString()])) +
    "/"
  );
}
export function imageKey(scope: ImageScope, manifest: PrintImageManifest): string {
  return imagePrefix(scope, manifest.localJobId, manifest.jobCreatedAtUtc) + manifest.artifactId + ".png";
}

export function imageMetadata(manifest: PrintImageManifest): Record<string, string> {
  const encoded = Buffer.from(JSON.stringify(manifest)).toString("base64url");
  if (encoded.length + manifest.sha256.length + 32 > 2000) return invalid();
  return { "ln-manifest": encoded, sha256: manifest.sha256 };
}
export function readImageMetadata(metadata: Record<string, string> | undefined): PrintImageManifest {
  try {
    const value = metadata?.["ln-manifest"];
    if (!value || value.length > 1900) return invalid();
    const manifest = parseImageManifest(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (metadata?.sha256 !== manifest.sha256) return invalid();
    return manifest;
  } catch {
    return invalid();
  }
}
