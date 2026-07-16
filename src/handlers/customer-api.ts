/**
 * `customerApi` Lambda handler — read-only customer-facing API.
 *
 * Single Function URL Lambda that routes internally between these GET paths:
 *
 *   GET /api/v1/me/stores                              -> stores summary (device counts + online counts)
 *   GET /api/v1/me/devices                             -> flat list of devices, grouped by storeId
 *   GET /api/v1/me/devices/{deviceCode}                -> single-device detail
 *   GET /api/v1/me/devices/{deviceCode}/products       -> catalog products mirror
 *   GET /api/v1/me/devices/{deviceCode}/templates      -> catalog templates mirror
 *   GET /api/v1/me/devices/{deviceCode}/jobs?limit=&cursor=  -> recent print jobs (descending)
 *
 * Phase 2 added the read/write `commands` surface (control-plane writes only,
 * status reads only — the device-side `CloudRemoteCommandService` still owns
 * the lifecycle from claim onwards):
 *
 *   POST /api/v1/me/devices/{deviceCode}/commands           -> queue print-label command
 *   GET  /api/v1/me/devices/{deviceCode}/commands/{id}      -> command status detail
 *
 * Auth is strict: every non-OPTIONS request MUST present a customer bearer
 * (`Authorization: Bearer <token>`) that resolves to a row in the
 * `DMLabelPrinterCloudCustomerTokens` table by sha256 hex of the bearer.
 * The `/devices/{code}` subroutes additionally verify the device's `Group`
 * is in the caller's authorized stores list — same enforcement the existing
 * device-detail route applies (404 device_not_found / 403 forbidden_store).
 */

// Module-level idempotent BigInt.prototype.toJSON shim — mandatory per
// dmngr/lambda-policies harden phase. DynamoDB N attributes can come back as
// BigInt via unmarshall(...) and would otherwise crash JSON.stringify(...).
if (typeof BigInt === "function" && !BigInt.prototype.toJSON) {
  Object.defineProperty(BigInt.prototype, "toJSON", {
    value: function () {
      return this.toString();
    },
    configurable: true,
    writable: true,
  });
}

import type { APIGatewayProxyHandlerV2, LambdaFunctionURLEvent } from "aws-lambda";

import { loadOptions, type CustomerApiOptions } from "../config";
import { extractBearer, sha256Hex } from "../lib/bearer-authorizer";
import {
  jsonResponse,
  noContentResponse,
  textResponse,
  type LambdaResponse
} from "../lib/http-results";
import {
  CustomError,
  logHandledErrorAction,
  redactDeep,
  shouldSuppress
} from "../lib/handled-errors";
import { DynamoCustomerApiStore } from "../storage/dynamo-store";
import type {
  CatalogProductsResponse,
  CatalogTemplatesResponse,
  CommandDetailResponse,
  CreateCommandRequestBody,
  CreateCommandResponse,
  DeviceDetail,
  DeviceRecord,
  DeviceSummary,
  DevicesResponse,
  PrintJobsResponse,
  StoreDevicesGroup,
  StoreSummary,
  StoresResponse
} from "../types";

const STORES_PATH = "/api/v1/me/stores";
const DEVICES_PATH = "/api/v1/me/devices";
const DEVICE_DETAIL_PREFIX = "/api/v1/me/devices/";
const DEVICE_PRODUCTS_SUFFIX = "/products";
const DEVICE_TEMPLATES_SUFFIX = "/templates";
const DEVICE_JOBS_SUFFIX = "/jobs";
const DEVICE_COMMANDS_SUFFIX = "/commands";

const DEFAULT_JOBS_LIMIT = 50;
const MAX_JOBS_LIMIT = 200;

const COMMAND_TYPE_PRINT_LABEL = "print-label";
const COMMAND_TYPE_UPSERT_PRODUCT = "upsert-product";
const COMMAND_TYPE_DELETE_PRODUCT = "delete-product";
const COMMAND_TYPE_UPSERT_TEMPLATE = "upsert-template";
const COMMAND_TYPE_DELETE_TEMPLATE = "delete-template";

const SUPPORTED_COMMAND_TYPES: ReadonlySet<string> = new Set([
  COMMAND_TYPE_PRINT_LABEL,
  COMMAND_TYPE_UPSERT_PRODUCT,
  COMMAND_TYPE_DELETE_PRODUCT,
  COMMAND_TYPE_UPSERT_TEMPLATE,
  COMMAND_TYPE_DELETE_TEMPLATE
]);

const DEFAULT_COMMAND_QUANTITY = 1;
const MAX_COMMAND_QUANTITY = 999;
// Upper bound on `Number.MAX_SAFE_INTEGER` ids supplied by the caller for
// upsert / delete payloads — anything bigger can't be represented as a JS
// `number` losslessly. The wire schema (.NET long) goes higher, but we never
// mint our own ids in this range from the customer-api; ids that big can only
// come from the caller pasting in a long value, and we reject those rather
// than silently rounding.
const MAX_SAFE_LONG_ID = Number.MAX_SAFE_INTEGER;
// Truncate the bearer's sha256 hash to 16 hex chars when writing `RequestedBy`
// — enough to correlate audits to a token row, without surfacing the full
// hash anywhere a customer can read it back.
const REQUESTED_BY_TOKEN_HASH_PREFIX_LENGTH = 16;

function getMethod(event: LambdaFunctionURLEvent): string {
  return event.requestContext?.http?.method ?? "";
}

function isOptions(event: LambdaFunctionURLEvent): boolean {
  return getMethod(event).toUpperCase() === "OPTIONS";
}

function normalizePath(rawPath: string | null | undefined): string {
  if (!rawPath || rawPath.trim().length === 0) return "/";
  return rawPath.trim();
}

function nowIsoSeconds(): string {
  // YYYY-MM-DDTHH:MM:SSZ — matches the customer-pairing repo's timestamp shape.
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Format `now` as a 7-digit-fractional ISO string ending in `Z`, matching
 * the .NET `DateTime.ToString("O")` shape the existing device-command-write
 * Lambda writes. We can't generate sub-millisecond precision from
 * `Date.now()`, so the trailing 4 fractional digits are deterministic
 * zero-padding — enough to satisfy a `begins_with` GSI sort-key parser that
 * expects exactly 7 fractional digits.
 *
 *   2026-05-02T07:23:45.123Z   ->  2026-05-02T07:23:45.1230000Z
 */
function nowIsoNanos(): string {
  const iso = new Date().toISOString();
  // Replace `.NNN Z` with `.NNN0000Z`. If the runtime ever returns
  // sub-second-less ISO (no `.`), pad with `.0000000Z`.
  if (iso.endsWith("Z")) {
    if (iso.includes(".")) {
      return iso.replace(/\.(\d{3})Z$/, ".$10000Z");
    }
    return iso.replace(/Z$/, ".0000000Z");
  }
  // toISOString always ends in Z — fall through is paranoia.
  return `${iso}.0000000Z`;
}

function epochSecondsFromIso(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return Math.floor(Date.now() / 1000);
  return Math.floor(ms / 1000);
}

function corsAllowsOrigin(): true {
  // Mirrors the customer-pairing repo: `*` for the customer-facing surface.
  return true;
}

interface AuthorizedCaller {
  tokenHash: string;
  storeIds: string[];
}

interface AuthFailure {
  response: LambdaResponse;
  errorCode: string;
}

type AuthOutcome = { kind: "ok"; caller: AuthorizedCaller } | { kind: "fail"; failure: AuthFailure };

type EnsureDeviceOutcome =
  | { kind: "ok"; record: DeviceRecord }
  | { kind: "fail"; response: LambdaResponse; errorCode: string };

/**
 * Resolve a device by code and verify its `Group` is in the caller's
 * authorized stores list. Mirrors the logic the original device-detail route
 * already had inline (404 → device_not_found, 403 → forbidden_store) so the
 * three new subroutes share the exact same auth surface.
 */
async function ensureAuthorizedDevice(
  store: DynamoCustomerApiStore,
  storeIds: ReadonlyArray<string>,
  deviceCode: string
): Promise<EnsureDeviceOutcome> {
  if (deviceCode.length === 0) {
    return {
      kind: "fail",
      response: textResponse(404, "Not found"),
      errorCode: "customer_api_device_not_found"
    };
  }

  const record = await store.getDevice(deviceCode);
  if (record === null) {
    return {
      kind: "fail",
      response: textResponse(404, "Device not found"),
      errorCode: "customer_api_device_not_found"
    };
  }

  const deviceStoreId = record.storeId.trim();
  if (deviceStoreId.length === 0 || !storeIds.includes(deviceStoreId)) {
    return {
      kind: "fail",
      response: textResponse(403, "Forbidden"),
      errorCode: "customer_api_forbidden_store"
    };
  }

  return { kind: "ok", record };
}

async function authorizeRequest(
  event: LambdaFunctionURLEvent,
  store: DynamoCustomerApiStore
): Promise<AuthOutcome> {
  const extracted = extractBearer(event);
  if (extracted.kind === "missing") {
    return {
      kind: "fail",
      failure: {
        response: textResponse(401, "Missing Authorization header"),
        errorCode: "customer_api_unauthorized"
      }
    };
  }
  if (extracted.kind === "invalid") {
    return {
      kind: "fail",
      failure: {
        response: textResponse(401, "Invalid Authorization header"),
        errorCode: "customer_api_invalid_token"
      }
    };
  }

  const tokenHash = sha256Hex(extracted.bearer);
  const tokenRow = await store.getCustomerToken(tokenHash);
  if (tokenRow === null) {
    return {
      kind: "fail",
      failure: {
        response: textResponse(401, "Invalid bearer token"),
        errorCode: "customer_api_token_not_found"
      }
    };
  }

  const storeIds = tokenRow.storeIds.filter((s) => typeof s === "string" && s.trim().length > 0);
  if (storeIds.length === 0) {
    return {
      kind: "fail",
      failure: {
        response: textResponse(409, "Token has no authorized stores"),
        errorCode: "customer_api_token_no_stores"
      }
    };
  }

  return { kind: "ok", caller: { tokenHash, storeIds } };
}

function isOnline(record: DeviceRecord, options: CustomerApiOptions, nowMs: number): boolean {
  return isWithinMinutes(record.lastSeenAtUtc, options.onlineWindowMinutes, nowMs);
}

function isActive(record: DeviceRecord, options: CustomerApiOptions, nowMs: number): boolean {
  return isWithinMinutes(record.lastSeenAtUtc, options.activeWindowMinutes, nowMs);
}

function isWithinMinutes(timestampIso: string, minutes: number, nowMs: number): boolean {
  if (typeof timestampIso !== "string" || timestampIso.length === 0) return false;
  const parsedMs = Date.parse(timestampIso);
  if (!Number.isFinite(parsedMs)) return false;
  const diffMs = nowMs - parsedMs;
  if (diffMs < 0) return true; // future-dated last-seen treated as fresh
  return diffMs <= minutes * 60_000;
}

function toDeviceSummary(
  record: DeviceRecord,
  options: CustomerApiOptions,
  nowMs: number
): DeviceSummary {
  const deviceName = record.deviceName.trim().length > 0 ? record.deviceName : record.deviceCode;
  return {
    deviceCode: record.deviceCode,
    deviceName,
    appVersion: record.appVersion,
    lastSeenAtUtc: record.lastSeenAtUtc,
    isActive: isActive(record, options, nowMs),
    isOnline: isOnline(record, options, nowMs),
    pendingCommands: record.pendingCommands,
    failedJobs: record.failedJobs
  };
}

function buildStoresResponse(
  storeIds: ReadonlyArray<string>,
  records: ReadonlyArray<DeviceRecord>,
  options: CustomerApiOptions,
  nowMs: number
): StoresResponse {
  const byStore = new Map<string, DeviceRecord[]>();
  for (const storeId of storeIds) {
    byStore.set(storeId, []);
  }
  for (const record of records) {
    const bucket = byStore.get(record.storeId);
    if (bucket !== undefined) bucket.push(record);
  }

  const stores: StoreSummary[] = [];
  for (const storeId of storeIds) {
    const bucket = byStore.get(storeId) ?? [];
    let onlineCount = 0;
    for (const record of bucket) {
      if (isOnline(record, options, nowMs)) onlineCount++;
    }
    stores.push({
      storeId,
      deviceCount: bucket.length,
      onlineCount
    });
  }
  return { stores };
}

function buildDevicesResponse(
  storeIds: ReadonlyArray<string>,
  records: ReadonlyArray<DeviceRecord>,
  options: CustomerApiOptions,
  nowMs: number
): DevicesResponse {
  const byStore = new Map<string, DeviceSummary[]>();
  for (const storeId of storeIds) {
    byStore.set(storeId, []);
  }
  for (const record of records) {
    const bucket = byStore.get(record.storeId);
    if (bucket !== undefined) bucket.push(toDeviceSummary(record, options, nowMs));
  }

  const groups: StoreDevicesGroup[] = [];
  for (const storeId of storeIds) {
    groups.push({
      storeId,
      devices: byStore.get(storeId) ?? []
    });
  }
  return { stores: groups };
}

function tryParseDeviceDetailPath(rawPath: string): string | null {
  const normalized = normalizePath(rawPath);
  if (!normalized.toLowerCase().startsWith(DEVICE_DETAIL_PREFIX.toLowerCase())) return null;
  const remainder = normalized.slice(DEVICE_DETAIL_PREFIX.length);
  if (remainder.length === 0) return null;
  if (remainder.includes("/")) return null;
  // Function URL events arrive URL-decoded already (rawPath is decoded), but
  // be defensive in case a future runtime change leaves percent-encodings in.
  try {
    return decodeURIComponent(remainder).trim();
  } catch {
    return remainder.trim();
  }
}

type DeviceSubrouteKind = "products" | "templates" | "jobs" | "commands";

interface DeviceSubrouteMatch {
  kind: DeviceSubrouteKind;
  deviceCode: string;
}

interface DeviceCommandDetailMatch {
  deviceCode: string;
  commandId: number;
}

/**
 * Parses `/api/v1/me/devices/{deviceCode}/{products|templates|jobs|commands}`.
 * Returns `null` for any other shape (the caller falls back to the
 * single-device detail route, the command-detail route, or a 404).
 * DeviceCode is URL-decoded with the same defensive try/catch as the
 * detail-route parser.
 */
function tryParseDeviceSubroutePath(rawPath: string): DeviceSubrouteMatch | null {
  const normalized = normalizePath(rawPath);
  if (!normalized.toLowerCase().startsWith(DEVICE_DETAIL_PREFIX.toLowerCase())) return null;
  const remainder = normalized.slice(DEVICE_DETAIL_PREFIX.length);
  if (remainder.length === 0) return null;

  const slashIdx = remainder.indexOf("/");
  if (slashIdx <= 0) return null;

  const rawDeviceCode = remainder.slice(0, slashIdx);
  const rest = remainder.slice(slashIdx); // includes leading "/"

  let kind: DeviceSubrouteKind | null = null;
  const lower = rest.toLowerCase();
  if (lower === DEVICE_PRODUCTS_SUFFIX) kind = "products";
  else if (lower === DEVICE_TEMPLATES_SUFFIX) kind = "templates";
  else if (lower === DEVICE_JOBS_SUFFIX) kind = "jobs";
  else if (lower === DEVICE_COMMANDS_SUFFIX) kind = "commands";
  if (kind === null) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawDeviceCode).trim();
  } catch {
    decoded = rawDeviceCode.trim();
  }
  if (decoded.length === 0) return null;

  return { kind, deviceCode: decoded };
}

/**
 * Parses `/api/v1/me/devices/{deviceCode}/commands/{id}` where `{id}` is a
 * positive integer. Returns `null` on any other shape (the caller falls
 * through to a 404). The `id` is parsed strictly — only `^\d+$` accepted,
 * with a positive non-zero numeric range.
 */
function tryParseCommandDetailPath(rawPath: string): DeviceCommandDetailMatch | null {
  const normalized = normalizePath(rawPath);
  if (!normalized.toLowerCase().startsWith(DEVICE_DETAIL_PREFIX.toLowerCase())) return null;
  const remainder = normalized.slice(DEVICE_DETAIL_PREFIX.length);
  if (remainder.length === 0) return null;

  const slashIdx = remainder.indexOf("/");
  if (slashIdx <= 0) return null;

  const rawDeviceCode = remainder.slice(0, slashIdx);
  const rest = remainder.slice(slashIdx); // includes leading "/"
  const lowerRest = rest.toLowerCase();
  const commandsPrefix = `${DEVICE_COMMANDS_SUFFIX}/`;
  if (!lowerRest.startsWith(commandsPrefix)) return null;

  const idPart = rest.slice(commandsPrefix.length);
  if (idPart.length === 0 || idPart.includes("/")) return null;
  if (!/^\d+$/.test(idPart)) return null;
  const parsedId = Number.parseInt(idPart, 10);
  if (!Number.isFinite(parsedId) || parsedId <= 0) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawDeviceCode).trim();
  } catch {
    decoded = rawDeviceCode.trim();
  }
  if (decoded.length === 0) return null;

  return { deviceCode: decoded, commandId: parsedId };
}

interface ParsedJobsQuery {
  limit: number;
  cursor: Record<string, unknown> | undefined;
}

/**
 * Parse `?limit=N&cursor=...` for `/jobs`. Returns a `CustomError` with code
 * `customer_api_invalid_query_param` for any unparseable / out-of-range value
 * — the caller turns that into a 400 with the policy-tracked code.
 */
function parseJobsQuery(rawQuery: Record<string, string | undefined> | undefined): ParsedJobsQuery {
  const params = rawQuery ?? {};

  let limit = DEFAULT_JOBS_LIMIT;
  const limitRaw = params["limit"];
  if (typeof limitRaw === "string" && limitRaw.trim().length > 0) {
    if (!/^\d+$/.test(limitRaw.trim())) {
      throw new CustomError("customer_api_invalid_query_param");
    }
    const parsed = Number.parseInt(limitRaw.trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_JOBS_LIMIT) {
      throw new CustomError("customer_api_invalid_query_param");
    }
    limit = parsed;
  }

  let cursor: Record<string, unknown> | undefined;
  const cursorRaw = params["cursor"];
  if (typeof cursorRaw === "string" && cursorRaw.trim().length > 0) {
    try {
      const decoded = decodeCursor(cursorRaw.trim());
      cursor = decoded;
    } catch {
      throw new CustomError("customer_api_invalid_query_param");
    }
  }

  return { limit, cursor };
}

interface ParsedPrintLabelBody {
  commandType: typeof COMMAND_TYPE_PRINT_LABEL;
  productCode: string;
  templateCode: string | null;
  quantity: number;
}

interface ParsedUpsertProductBody {
  commandType: typeof COMMAND_TYPE_UPSERT_PRODUCT;
  product: {
    id: number | null;
    code: string;
    name: string;
    categoryName: string | null;
    priceCents: number;
  };
}

interface ParsedDeleteProductBody {
  commandType: typeof COMMAND_TYPE_DELETE_PRODUCT;
  productId: number;
}

interface ParsedUpsertTemplateBody {
  commandType: typeof COMMAND_TYPE_UPSERT_TEMPLATE;
  template: {
    id: number | null;
    code: string;
    name: string;
    body: string;
  };
}

interface ParsedDeleteTemplateBody {
  commandType: typeof COMMAND_TYPE_DELETE_TEMPLATE;
  templateId: number;
}

type ParsedCreateCommandBody =
  | ParsedPrintLabelBody
  | ParsedUpsertProductBody
  | ParsedDeleteProductBody
  | ParsedUpsertTemplateBody
  | ParsedDeleteTemplateBody;

/**
 * Strict validation of the `POST /commands` request body. Throws a
 * `CustomError` with a policy-tracked code on every rejection — the handler
 * turns that into a 400 with the matching code.
 *
 * Validation rules (Phase 3):
 *  - body must be valid JSON, an object (not an array, not a primitive)
 *  - `commandType` must be a non-empty string in the supported set
 *    (`print-label`, `upsert-product`, `delete-product`, `upsert-template`,
 *    `delete-template`).
 *  - `print-label`: same rules as Phase 2 — `productCode` non-empty string,
 *    `templateCode` optional non-empty string, `quantity` optional integer
 *    in [1, 999].
 *  - `upsert-product`: `product.code` and `product.name` must be non-empty
 *    strings; `product.id` (if present) must be a positive safe-integer;
 *    `product.priceCents` must be a non-negative integer (defaults to 0
 *    when missing — the device handler treats Price = 0 as "not priced");
 *    `product.categoryName` is optional, when present must be a non-empty
 *    string.
 *  - `delete-product` / `delete-template`: id must be a positive
 *    safe-integer.
 *  - `upsert-template`: `template.code` and `template.name` must be
 *    non-empty strings; `template.id` (if present) must be a positive
 *    safe-integer; `template.body` is optional, defaults to "".
 */
function parseCreateCommandBody(rawBody: string | undefined): ParsedCreateCommandBody {
  if (typeof rawBody !== "string" || rawBody.trim().length === 0) {
    throw new CustomError("customer_api_command_invalid_body");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new CustomError("customer_api_command_invalid_body");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CustomError("customer_api_command_invalid_body");
  }

  const body = parsed as CreateCommandRequestBody;

  if (typeof body.commandType !== "string" || body.commandType.trim().length === 0) {
    throw new CustomError("customer_api_command_invalid_body");
  }
  const commandType = body.commandType.trim();
  if (!SUPPORTED_COMMAND_TYPES.has(commandType)) {
    throw new CustomError("customer_api_command_unsupported_type");
  }

  switch (commandType) {
    case COMMAND_TYPE_PRINT_LABEL:
      return parsePrintLabelBody(body);
    case COMMAND_TYPE_UPSERT_PRODUCT:
      return parseUpsertProductBody(body);
    case COMMAND_TYPE_DELETE_PRODUCT:
      return parseDeleteProductBody(body);
    case COMMAND_TYPE_UPSERT_TEMPLATE:
      return parseUpsertTemplateBody(body);
    case COMMAND_TYPE_DELETE_TEMPLATE:
      return parseDeleteTemplateBody(body);
    default:
      // Unreachable — already gated by SUPPORTED_COMMAND_TYPES above.
      throw new CustomError("customer_api_command_unsupported_type");
  }
}

function parsePrintLabelBody(body: CreateCommandRequestBody): ParsedPrintLabelBody {
  if (typeof body.productCode !== "string" || body.productCode.trim().length === 0) {
    // Treat a missing productCode as a body validation issue (caller
    // discoverability) — the explicit "product not found" code is reserved
    // for "field present but didn't resolve".
    throw new CustomError("customer_api_command_invalid_body");
  }
  const productCode = body.productCode.trim();

  let templateCode: string | null = null;
  if (body.templateCode !== undefined && body.templateCode !== null) {
    if (typeof body.templateCode !== "string" || body.templateCode.trim().length === 0) {
      throw new CustomError("customer_api_command_invalid_body");
    }
    templateCode = body.templateCode.trim();
  }

  let quantity = DEFAULT_COMMAND_QUANTITY;
  if (body.quantity !== undefined && body.quantity !== null) {
    if (typeof body.quantity !== "number" || !Number.isFinite(body.quantity)) {
      throw new CustomError("customer_api_command_invalid_quantity");
    }
    if (!Number.isInteger(body.quantity)) {
      throw new CustomError("customer_api_command_invalid_quantity");
    }
    if (body.quantity < 1 || body.quantity > MAX_COMMAND_QUANTITY) {
      throw new CustomError("customer_api_command_invalid_quantity");
    }
    quantity = body.quantity;
  }

  return { commandType: COMMAND_TYPE_PRINT_LABEL, productCode, templateCode, quantity };
}

/**
 * Coerce an optional positive long-shaped id from caller input. Returns
 * `null` when absent (so the device handler treats the apply as "match by
 * code, otherwise insert"); throws `customer_api_command_invalid_id` when
 * present but malformed.
 */
function parseOptionalIdField(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new CustomError("customer_api_command_invalid_id");
  }
  if (raw <= 0 || raw > MAX_SAFE_LONG_ID) {
    throw new CustomError("customer_api_command_invalid_id");
  }
  return raw;
}

/**
 * Coerce a required positive long-shaped id from caller input (used by the
 * delete-product / delete-template paths). Throws
 * `customer_api_command_invalid_id` on any rejection.
 */
function parseRequiredIdField(raw: unknown): number {
  if (raw === undefined || raw === null) {
    throw new CustomError("customer_api_command_invalid_id");
  }
  const parsed = parseOptionalIdField(raw);
  if (parsed === null) {
    throw new CustomError("customer_api_command_invalid_id");
  }
  return parsed;
}

function parseUpsertProductBody(body: CreateCommandRequestBody): ParsedUpsertProductBody {
  const product = body.product;
  if (product === null || typeof product !== "object" || Array.isArray(product)) {
    throw new CustomError("customer_api_command_invalid_product");
  }
  const p = product as {
    id?: unknown;
    code?: unknown;
    name?: unknown;
    categoryName?: unknown;
    priceCents?: unknown;
  };

  const id = parseOptionalIdField(p.id);

  if (typeof p.code !== "string" || p.code.trim().length === 0) {
    throw new CustomError("customer_api_command_invalid_product");
  }
  const code = p.code.trim();

  if (typeof p.name !== "string" || p.name.trim().length === 0) {
    throw new CustomError("customer_api_command_invalid_product");
  }
  const name = p.name.trim();

  let categoryName: string | null = null;
  if (p.categoryName !== undefined && p.categoryName !== null) {
    if (typeof p.categoryName !== "string" || p.categoryName.trim().length === 0) {
      throw new CustomError("customer_api_command_invalid_product");
    }
    categoryName = p.categoryName.trim();
  }

  let priceCents = 0;
  if (p.priceCents !== undefined && p.priceCents !== null) {
    if (typeof p.priceCents !== "number" || !Number.isFinite(p.priceCents)) {
      throw new CustomError("customer_api_command_invalid_product");
    }
    if (!Number.isInteger(p.priceCents)) {
      throw new CustomError("customer_api_command_invalid_product");
    }
    if (p.priceCents < 0) {
      throw new CustomError("customer_api_command_invalid_product");
    }
    priceCents = p.priceCents;
  }

  return {
    commandType: COMMAND_TYPE_UPSERT_PRODUCT,
    product: { id, code, name, categoryName, priceCents }
  };
}

function parseDeleteProductBody(body: CreateCommandRequestBody): ParsedDeleteProductBody {
  const productId = parseRequiredIdField(body.productId);
  return { commandType: COMMAND_TYPE_DELETE_PRODUCT, productId };
}

function parseUpsertTemplateBody(body: CreateCommandRequestBody): ParsedUpsertTemplateBody {
  const template = body.template;
  if (template === null || typeof template !== "object" || Array.isArray(template)) {
    throw new CustomError("customer_api_command_invalid_template");
  }
  const t = template as {
    id?: unknown;
    code?: unknown;
    name?: unknown;
    body?: unknown;
  };

  const id = parseOptionalIdField(t.id);

  if (typeof t.code !== "string" || t.code.trim().length === 0) {
    throw new CustomError("customer_api_command_invalid_template");
  }
  const code = t.code.trim();

  if (typeof t.name !== "string" || t.name.trim().length === 0) {
    throw new CustomError("customer_api_command_invalid_template");
  }
  const name = t.name.trim();

  let bodyText = "";
  if (t.body !== undefined && t.body !== null) {
    if (typeof t.body !== "string") {
      throw new CustomError("customer_api_command_invalid_template");
    }
    bodyText = t.body;
  }

  return {
    commandType: COMMAND_TYPE_UPSERT_TEMPLATE,
    template: { id, code, name, body: bodyText }
  };
}

function parseDeleteTemplateBody(body: CreateCommandRequestBody): ParsedDeleteTemplateBody {
  const templateId = parseRequiredIdField(body.templateId);
  return { commandType: COMMAND_TYPE_DELETE_TEMPLATE, templateId };
}

/**
 * Read the request body from a Function URL event, decoding base64 if
 * necessary. API Gateway / Function URL passes binary-shaped payloads as
 * base64-encoded strings with `isBase64Encoded: true`; non-base64 JSON
 * bodies arrive as plain UTF-8.
 */
function readRequestBody(event: LambdaFunctionURLEvent): string | undefined {
  const body = event.body;
  if (typeof body !== "string") return undefined;
  if (event.isBase64Encoded) {
    try {
      return Buffer.from(body, "base64").toString("utf8");
    } catch {
      return undefined;
    }
  }
  return body;
}

/**
 * Build the JSON payload string the device-side `CloudRemoteCommandService`
 * receives via `command.PayloadJson` for a `print-label` command. Mirrors the
 * structure documented in the design doc so existing devices need no code
 * changes:
 *
 *   {"ProductId":<n|null>,"ProductCode":"...","ProductName":"...",
 *    "Quantity":1,
 *    "TemplateId":<n|null>,"TemplateCode":<"...|null>,"TemplateName":<"...|null>}
 *
 * `Id` fields carry device-local catalog ids. They use `null` (not 0) when
 * a local id is missing; the global DynamoDB row key is never a valid fallback.
 * The local print API can then resolve by the stable product/template codes.
 */
function buildPrintLabelPayloadJson(
  product: { id: number; code: string; name: string },
  template: { id: number; code: string; name: string } | null,
  quantity: number
): string {
  const payload: Record<string, unknown> = {
    ProductId: product.id > 0 ? product.id : null,
    ProductCode: product.code,
    ProductName: product.name,
    Quantity: quantity,
    TemplateId: template !== null && template.id > 0 ? template.id : null,
    TemplateCode: template !== null ? template.code : null,
    TemplateName: template !== null ? template.name : null
  };
  return JSON.stringify(payload);
}

/**
 * Build the JSON payload string for an `upsert-product` command. Shape
 * matches the device-side `RemoteCatalogApplier.UpsertProduct` reader (which
 * deserializes with `PropertyNameCaseInsensitive = true`, so PascalCase
 * here mirrors the existing `print-label` payload's casing for consistency).
 *
 *   { "Id": <long|null>, "Code": "...", "Name": "...",
 *     "CategoryName": "...|null", "Price": <decimal> }
 *
 * `Price` is emitted as a JSON number (e.g. `3.50`) — the device parses with
 * `JsonElement.GetDecimal()` which accepts decimal-shaped JSON numbers. We
 * derive it from `priceCents / 100` server-side so the wire shape stays
 * integer-cents (avoids the float-precision footgun on the caller side).
 */
function buildUpsertProductPayloadJson(product: ParsedUpsertProductBody["product"]): string {
  // Format `price` with up to 2 fractional digits, no trailing zeros, but
  // preserve a single trailing `.0` so the .NET decimal parser sees a number
  // with a fractional component (it accepts both — kept simple here).
  const price = product.priceCents / 100;
  const payload: Record<string, unknown> = {
    Id: product.id !== null && product.id > 0 ? product.id : null,
    Code: product.code,
    Name: product.name,
    CategoryName: product.categoryName,
    Price: price
  };
  return JSON.stringify(payload);
}

/**
 * Build the JSON payload string for an `upsert-template` command. Shape
 * matches the device-side `RemoteCatalogApplier.UpsertTemplate` reader.
 *
 *   { "Id": <long|null>, "Code": "...", "Name": "...", "Body": "..." }
 */
function buildUpsertTemplatePayloadJson(
  template: ParsedUpsertTemplateBody["template"]
): string {
  const payload: Record<string, unknown> = {
    Id: template.id !== null && template.id > 0 ? template.id : null,
    Code: template.code,
    Name: template.name,
    Body: template.body
  };
  return JSON.stringify(payload);
}

/**
 * Build the JSON payload string for a `delete-product` / `delete-template`
 * command. Shape matches the device-side `RemoteCatalogApplier.DeletePayload`
 * reader (single `Id` field).
 */
function buildDeleteByIdPayloadJson(id: number): string {
  return JSON.stringify({ Id: id });
}

/**
 * Cursors are base64url-encoded JSON of the DynamoDB `LastEvaluatedKey`
 * (a small AttributeValue map). We deliberately don't hide the structure:
 * the web app treats it as opaque, but this format is forward-compatible if
 * we ever add a server-side HMAC.
 */
function encodeCursor(key: Record<string, unknown>): string {
  const json = JSON.stringify(key);
  return Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeCursor(encoded: string): Record<string, unknown> {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const json = Buffer.from(padded + "=".repeat(padLen), "base64").toString("utf8");
  const parsed = JSON.parse(json) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("cursor is not an object");
  }
  return parsed as Record<string, unknown>;
}

function isStoresPath(rawPath: string): boolean {
  return normalizePath(rawPath).toLowerCase() === STORES_PATH;
}

function isDevicesListPath(rawPath: string): boolean {
  return normalizePath(rawPath).toLowerCase() === DEVICES_PATH;
}

/**
 * Handles `POST /api/v1/me/devices/{deviceCode}/commands` end-to-end.
 *
 * Phase 2 supported only `print-label`, where the handler hydrated the row's
 * `PayloadJson` from the catalog mirror. Phase 3 added four catalog-edit
 * types (`upsert-product`, `delete-product`, `upsert-template`,
 * `delete-template`) where the payload IS the upsert/delete intent — no
 * catalog lookup required. The dispatch below picks the right payload
 * builder, but the row schema (Id, Status=Pending, DeviceStatusRequestedKey,
 * RequestedBy, StoreCode, RequestedAtUtc, RequestedAtEpochSeconds) is shared
 * across all five types so the device-side claim flow needs no per-type
 * branching at the queue layer.
 *
 * The caller is `RequestedBy` = `customer-api:<TokenHash[:16]>` — never the
 * full hash. The device's `StoreCode` is copied from the device row's
 * `Group` attribute (per the schema sample) so the cloud admin tooling that
 * filters by store sees customer-issued commands the same as device-issued.
 */
async function handleCreateCommand(
  store: DynamoCustomerApiStore,
  device: DeviceRecord,
  callerTokenHash: string,
  rawBody: string | undefined
): Promise<LambdaResponse> {
  let parsedBody: ParsedCreateCommandBody;
  try {
    parsedBody = parseCreateCommandBody(rawBody);
  } catch (err) {
    if (err instanceof CustomError) {
      logHandledErrorAction(err.code, shouldSuppress(err.code));
      return textResponse(400, err.code);
    }
    throw err;
  }

  let payloadJson: string;
  let responseProductCode: string | null;

  switch (parsedBody.commandType) {
    case COMMAND_TYPE_PRINT_LABEL: {
      const product = await store.findProductByCode(device.deviceCode, parsedBody.productCode);
      if (product === null) {
        logHandledErrorAction(
          "customer_api_command_product_not_found",
          shouldSuppress("customer_api_command_product_not_found")
        );
        return textResponse(400, "customer_api_command_product_not_found");
      }

      let template: { id: number; code: string; name: string } | null = null;
      if (parsedBody.templateCode !== null) {
        const lookedUp = await store.findTemplateByCode(device.deviceCode, parsedBody.templateCode);
        if (lookedUp === null) {
          logHandledErrorAction(
            "customer_api_command_template_not_found",
            shouldSuppress("customer_api_command_template_not_found")
          );
          return textResponse(400, "customer_api_command_template_not_found");
        }
        template = lookedUp;
      }

      payloadJson = buildPrintLabelPayloadJson(product, template, parsedBody.quantity);
      responseProductCode = product.code;
      break;
    }
    case COMMAND_TYPE_UPSERT_PRODUCT: {
      payloadJson = buildUpsertProductPayloadJson(parsedBody.product);
      responseProductCode = parsedBody.product.code;
      break;
    }
    case COMMAND_TYPE_DELETE_PRODUCT: {
      payloadJson = buildDeleteByIdPayloadJson(parsedBody.productId);
      responseProductCode = null;
      break;
    }
    case COMMAND_TYPE_UPSERT_TEMPLATE: {
      payloadJson = buildUpsertTemplatePayloadJson(parsedBody.template);
      responseProductCode = null;
      break;
    }
    case COMMAND_TYPE_DELETE_TEMPLATE: {
      payloadJson = buildDeleteByIdPayloadJson(parsedBody.templateId);
      responseProductCode = null;
      break;
    }
  }

  const id = await store.getNextDeviceCommandId();
  const requestedAtUtc = nowIsoNanos();
  const requestedAtEpochSeconds = epochSecondsFromIso(requestedAtUtc);

  const tokenPrefix = callerTokenHash.slice(0, REQUESTED_BY_TOKEN_HASH_PREFIX_LENGTH);
  const requestedBy = `customer-api:${tokenPrefix}`;

  await store.putPendingDeviceCommand({
    id,
    deviceCode: device.deviceCode,
    storeCode: device.storeId,
    commandType: parsedBody.commandType,
    payloadJson,
    requestedBy,
    requestedAtUtc,
    requestedAtEpochSeconds
  });

  const responseBody: CreateCommandResponse = {
    id,
    status: "Pending",
    requestedAtUtc,
    commandType: parsedBody.commandType,
    productCode: responseProductCode
  };
  console.log("RequestId SUCCESS");
  return jsonResponse(201, responseBody);
}

/**
 * Handles `GET /api/v1/me/devices/{deviceCode}/commands/{id}`. Returns the
 * row's current status with timestamps + error-message fields nullable,
 * matching the wire schema. 404 with `customer_api_command_not_found` if
 * the row is missing OR if it exists but its `DeviceCode` doesn't match
 * the path-parameter device — this prevents a caller from probing other
 * stores' commands by guessing Ids.
 */
async function handleGetCommandDetail(
  store: DynamoCustomerApiStore,
  device: DeviceRecord,
  commandId: number
): Promise<LambdaResponse> {
  const record = await store.getDeviceCommandById(commandId);
  if (record === null || record.deviceCode !== device.deviceCode) {
    logHandledErrorAction(
      "customer_api_command_not_found",
      shouldSuppress("customer_api_command_not_found")
    );
    return textResponse(404, "Not found");
  }

  const payload: CommandDetailResponse = {
    id: record.id,
    status: record.status,
    commandType: record.commandType,
    requestedAtUtc: record.requestedAtUtc,
    claimedAtUtc: record.claimedAtUtc,
    completedAtUtc: record.completedAtUtc,
    productCode: record.productCode,
    errorMessage: record.errorMessage
  };
  console.log("RequestId SUCCESS");
  return jsonResponse(200, payload);
}

export const handler: APIGatewayProxyHandlerV2 = async (event, context) => {
  const fnEvent = event as LambdaFunctionURLEvent;
  const awsRequestId = context?.awsRequestId;
  const invocationContext = {
    v: 1,
    log_type: "ctx",
    handler: "customerApi",
    awsRequestId
  };
  const serializedContext = JSON.stringify(invocationContext);
  console.log("ctx", serializedContext);
  console.log(
    `ACTION:SLACK_CTX_V1=${Buffer.from(serializedContext, "utf8").toString("base64url")}`
  );
  // CORS allow-origin is a constant `*` by design — touch corsAllowsOrigin
  // to keep the symbol referenced under noUnusedLocals.
  void corsAllowsOrigin();

  try {
    const options = loadOptions();

    if (isOptions(fnEvent)) {
      console.log("RequestId SUCCESS");
      return noContentResponse();
    }

    const method = getMethod(fnEvent).toUpperCase();
    if (method !== "GET" && method !== "POST") {
      return textResponse(405, "Method not allowed");
    }

    const rawPath = fnEvent.rawPath ?? "";
    const store = new DynamoCustomerApiStore(options);

    const auth = await authorizeRequest(fnEvent, store);
    if (auth.kind === "fail") {
      logHandledErrorAction(auth.failure.errorCode, shouldSuppress(auth.failure.errorCode));
      return auth.failure.response;
    }

    // Best-effort touch — don't await; never fail the response on this.
    const nowIso = nowIsoSeconds();
    const nowMs = Date.now();
    void store.touchCustomerTokenLastUsed(auth.caller.tokenHash, nowIso);

    // POST is supported only on the commands subroute. Route POST traffic
    // before the GET-only routes so a POST elsewhere falls through to a 405.
    if (method === "POST") {
      const subroute = tryParseDeviceSubroutePath(rawPath);
      if (subroute !== null && subroute.kind === "commands") {
        const authResult = await ensureAuthorizedDevice(
          store,
          auth.caller.storeIds,
          subroute.deviceCode
        );
        if (authResult.kind === "fail") {
          logHandledErrorAction(authResult.errorCode, shouldSuppress(authResult.errorCode));
          return authResult.response;
        }

        return await handleCreateCommand(
          store,
          authResult.record,
          auth.caller.tokenHash,
          readRequestBody(fnEvent)
        );
      }

      return textResponse(405, "Method not allowed");
    }

    if (isStoresPath(rawPath) || isDevicesListPath(rawPath)) {
      const records = await store.scanDevicesByStoreIds(auth.caller.storeIds);

      if (isStoresPath(rawPath)) {
        const payload = buildStoresResponse(auth.caller.storeIds, records, options, nowMs);
        console.log("RequestId SUCCESS");
        return jsonResponse(200, payload);
      }

      const payload = buildDevicesResponse(auth.caller.storeIds, records, options, nowMs);
      console.log("RequestId SUCCESS");
      return jsonResponse(200, payload);
    }

    const subroute = tryParseDeviceSubroutePath(rawPath);
    if (subroute !== null) {
      const authResult = await ensureAuthorizedDevice(store, auth.caller.storeIds, subroute.deviceCode);
      if (authResult.kind === "fail") {
        logHandledErrorAction(authResult.errorCode, shouldSuppress(authResult.errorCode));
        return authResult.response;
      }

      if (subroute.kind === "products") {
        const items = await store.queryProductsByDeviceCode(subroute.deviceCode);
        const payload: CatalogProductsResponse = { items };
        console.log("RequestId SUCCESS");
        return jsonResponse(200, payload);
      }

      if (subroute.kind === "templates") {
        const items = await store.queryTemplatesByDeviceCode(subroute.deviceCode);
        const payload: CatalogTemplatesResponse = { items };
        console.log("RequestId SUCCESS");
        return jsonResponse(200, payload);
      }

      // jobs
      let parsed: ParsedJobsQuery;
      try {
        parsed = parseJobsQuery(fnEvent.queryStringParameters);
      } catch (err) {
        if (err instanceof CustomError) {
          logHandledErrorAction(err.code, shouldSuppress(err.code));
          return textResponse(400, "Invalid query parameter");
        }
        throw err;
      }

      const result = await store.queryPrintJobsByDevice(
        subroute.deviceCode,
        parsed.limit,
        parsed.cursor as never
      );
      const payload: PrintJobsResponse = {
        items: result.items,
        nextCursor: result.nextCursor !== undefined ? encodeCursor(result.nextCursor) : null
      };
      console.log("RequestId SUCCESS");
      return jsonResponse(200, payload);
    }

    const commandDetail = tryParseCommandDetailPath(rawPath);
    if (commandDetail !== null) {
      const authResult = await ensureAuthorizedDevice(
        store,
        auth.caller.storeIds,
        commandDetail.deviceCode
      );
      if (authResult.kind === "fail") {
        logHandledErrorAction(authResult.errorCode, shouldSuppress(authResult.errorCode));
        return authResult.response;
      }

      return await handleGetCommandDetail(store, authResult.record, commandDetail.commandId);
    }

    const deviceCode = tryParseDeviceDetailPath(rawPath);
    if (deviceCode !== null) {
      const authResult = await ensureAuthorizedDevice(store, auth.caller.storeIds, deviceCode);
      if (authResult.kind === "fail") {
        logHandledErrorAction(authResult.errorCode, shouldSuppress(authResult.errorCode));
        return authResult.response;
      }

      const summary = toDeviceSummary(authResult.record, options, nowMs);
      const detail: DeviceDetail = {
        ...summary,
        storeId: authResult.record.storeId.trim()
      };
      console.log("RequestId SUCCESS");
      return jsonResponse(200, detail);
    }

    return textResponse(404, "Not found");
  } catch (error) {
    // Final generic catch — log redacted event once, structured error summary,
    // and a handled-error marker if it was a CustomError. Never emit
    // RequestId SUCCESS from here.
    console.log("event", JSON.stringify(redactDeep(event)));
    if (error instanceof CustomError) {
      logHandledErrorAction(error.code, shouldSuppress(error.code));
    }
    console.log(
      JSON.stringify({
        log_type: "unhandled_error",
        awsRequestId,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      })
    );
    console.log("RequestId FAILED");

    const fallback: LambdaResponse = textResponse(500, "Internal Server Error");
    return fallback;
  }
};
