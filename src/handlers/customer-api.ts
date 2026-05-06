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

const DEFAULT_JOBS_LIMIT = 50;
const MAX_JOBS_LIMIT = 200;

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

type DeviceSubrouteKind = "products" | "templates" | "jobs";

interface DeviceSubrouteMatch {
  kind: DeviceSubrouteKind;
  deviceCode: string;
}

/**
 * Parses `/api/v1/me/devices/{deviceCode}/{products|templates|jobs}`. Returns
 * `null` for any other shape (the caller falls back to the single-device
 * detail route or a 404). DeviceCode is URL-decoded with the same defensive
 * try/catch as the detail-route parser.
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

export const handler: APIGatewayProxyHandlerV2 = async (event, context) => {
  const fnEvent = event as LambdaFunctionURLEvent;
  const awsRequestId = context?.awsRequestId;
  console.log("ctx", { handler: "customerApi", awsRequestId });
  // CORS allow-origin is a constant `*` by design — touch corsAllowsOrigin
  // to keep the symbol referenced under noUnusedLocals.
  void corsAllowsOrigin();

  try {
    const options = loadOptions();

    if (isOptions(fnEvent)) {
      console.log("RequestId SUCCESS");
      return noContentResponse();
    }

    if (getMethod(fnEvent).toUpperCase() !== "GET") {
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
    console.log("unhandled_error", {
      awsRequestId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    console.log("RequestId FAILED");

    const fallback: LambdaResponse = textResponse(500, "Internal Server Error");
    return fallback;
  }
};
