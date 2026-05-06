/**
 * `customerApi` Lambda handler — read-only customer-facing API.
 *
 * Single Function URL Lambda that routes internally between three GET paths:
 *
 *   GET /api/v1/me/stores                  -> stores summary (device counts + online counts)
 *   GET /api/v1/me/devices                 -> flat list of devices, grouped by storeId
 *   GET /api/v1/me/devices/{deviceCode}    -> single-device detail
 *
 * Auth is strict: every non-OPTIONS request MUST present a customer bearer
 * (`Authorization: Bearer <token>`) that resolves to a row in the
 * `DMLabelPrinterCloudCustomerTokens` table by sha256 hex of the bearer.
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
  DeviceDetail,
  DeviceRecord,
  DeviceSummary,
  DevicesResponse,
  StoreDevicesGroup,
  StoreSummary,
  StoresResponse
} from "../types";

const STORES_PATH = "/api/v1/me/stores";
const DEVICES_PATH = "/api/v1/me/devices";
const DEVICE_DETAIL_PREFIX = "/api/v1/me/devices/";

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

    const deviceCode = tryParseDeviceDetailPath(rawPath);
    if (deviceCode !== null) {
      if (deviceCode.length === 0) {
        return textResponse(404, "Not found");
      }

      const record = await store.getDevice(deviceCode);
      if (record === null) {
        const errorCode = "customer_api_device_not_found";
        logHandledErrorAction(errorCode, shouldSuppress(errorCode));
        return textResponse(404, "Device not found");
      }

      const deviceStoreId = record.storeId.trim();
      if (deviceStoreId.length === 0 || !auth.caller.storeIds.includes(deviceStoreId)) {
        const errorCode = "customer_api_forbidden_store";
        logHandledErrorAction(errorCode, shouldSuppress(errorCode));
        return textResponse(403, "Forbidden");
      }

      const summary = toDeviceSummary(record, options, nowMs);
      const detail: DeviceDetail = {
        ...summary,
        storeId: deviceStoreId
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
