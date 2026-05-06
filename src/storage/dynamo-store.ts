/**
 * DynamoDB store for the customer-api Lambda.
 *
 * Uses the low-level `@aws-sdk/client-dynamodb` (AttributeValue shapes) so the
 * port stays line-for-line equivalent to the customer-pairing repo it's a
 * sibling of, including the `ProjectionExpression "#g"` workaround for the
 * reserved word `Group` and the SET LastUsedAtUtc UpdateExpression on the
 * customer-tokens table.
 *
 * Note (Phase 4 AWS SDK hygiene): on Node 18+ managed runtimes, `@aws-sdk/*`
 * packages are runtime-included. We therefore intentionally do **not** pin
 * them in `package.json` (no `dependencies` block in this repo), and we
 * import them at runtime only.
 */

import type { CustomerApiOptions } from "../config";
import type { CustomerTokenRecord, DeviceRecord } from "../types";

// AWS SDK v3 is runtime-included on Node 18+ Lambda runtimes (Phase 4 hygiene:
// nothing pinned in `package.json`). We require it at runtime and declare just
// enough of the surface area to keep the rest of this file strictly typed.

interface AttributeValue {
  S?: string;
  N?: string;
  SS?: string[];
}

interface GetItemInput {
  TableName: string;
  Key: Record<string, AttributeValue>;
  ProjectionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
}

interface GetItemOutput {
  Item?: Record<string, AttributeValue>;
}

interface UpdateItemInput {
  TableName: string;
  Key: Record<string, AttributeValue>;
  UpdateExpression: string;
  ExpressionAttributeValues: Record<string, AttributeValue>;
  ReturnValues?: "ALL_NEW" | "NONE";
}

interface UpdateItemOutput {
  Attributes?: Record<string, AttributeValue>;
}

interface ScanInput {
  TableName: string;
  ProjectionExpression?: string;
  FilterExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  ExclusiveStartKey?: Record<string, AttributeValue>;
}

interface ScanOutput {
  Items?: Record<string, AttributeValue>[];
  LastEvaluatedKey?: Record<string, AttributeValue>;
}

interface DynamoCommand<TInput, TOutput> {
  readonly input: TInput;
  readonly __out__?: TOutput;
}

interface DynamoCommandCtor<TInput, TOutput> {
  new (input: TInput): DynamoCommand<TInput, TOutput>;
}

interface DynamoClient {
  send<TInput, TOutput>(command: DynamoCommand<TInput, TOutput>): Promise<TOutput>;
}

interface DynamoSdkModule {
  DynamoDBClient: new (cfg: Record<string, unknown>) => DynamoClient;
  GetItemCommand: DynamoCommandCtor<GetItemInput, GetItemOutput>;
  UpdateItemCommand: DynamoCommandCtor<UpdateItemInput, UpdateItemOutput>;
  ScanCommand: DynamoCommandCtor<ScanInput, ScanOutput>;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk: DynamoSdkModule = require("@aws-sdk/client-dynamodb") as DynamoSdkModule;
const { DynamoDBClient, GetItemCommand, UpdateItemCommand, ScanCommand } = sdk;

/**
 * Module-scoped client so successive invocations on a warm container reuse
 * the underlying connection pool. Constructor reads region from env
 * (`AWS_REGION` is set automatically by Lambda).
 */
const dynamoClient = new DynamoDBClient({});

function s(value: string | null | undefined): AttributeValue {
  return { S: typeof value === "string" ? value : "" };
}

function readString(item: Record<string, AttributeValue> | undefined, key: string): string {
  if (!item) return "";
  const attr = item[key];
  return attr && typeof attr.S === "string" ? attr.S : "";
}

function readNumber(item: Record<string, AttributeValue> | undefined, key: string): number {
  if (!item) return 0;
  const attr = item[key];
  if (!attr || typeof attr.N !== "string") return 0;
  const parsed = Number.parseInt(attr.N, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class DynamoCustomerApiStore {
  constructor(private readonly options: CustomerApiOptions) {}

  /**
   * Looks up the customer-token row by its sha256 hash. Returns null if no
   * such row exists.
   */
  async getCustomerToken(tokenHash: string): Promise<CustomerTokenRecord | null> {
    const response = await dynamoClient.send(
      new GetItemCommand({
        TableName: this.options.customerTokensTableName,
        Key: { TokenHash: s(tokenHash) }
      })
    );

    const item = response.Item;
    if (!item || Object.keys(item).length === 0) return null;

    const storeIdsAttr = item["StoreIds"];
    const storeIds =
      storeIdsAttr && Array.isArray(storeIdsAttr.SS) ? [...storeIdsAttr.SS] : [];

    return {
      tokenHash: readString(item, "TokenHash"),
      storeIds,
      lastUsedAtUtc: readString(item, "LastUsedAtUtc")
    };
  }

  /**
   * Best-effort touch of `LastUsedAtUtc` on the customer-token row. Failures
   * are swallowed — we never want a stats update to fail the API call.
   */
  async touchCustomerTokenLastUsed(tokenHash: string, nowIso: string): Promise<void> {
    try {
      await dynamoClient.send(
        new UpdateItemCommand({
          TableName: this.options.customerTokensTableName,
          Key: { TokenHash: s(tokenHash) },
          UpdateExpression: "SET LastUsedAtUtc = :now",
          ExpressionAttributeValues: {
            ":now": s(nowIso)
          },
          ReturnValues: "NONE"
        })
      );
    } catch (err) {
      console.log("touch_last_used_failed", {
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /**
   * Scan the Devices table, filtering on `Group IN (storeIds)`. There is no
   * GSI on `Group` (8 devices in pre-prod, scan is fine). Pages through
   * `LastEvaluatedKey` if necessary.
   */
  async scanDevicesByStoreIds(storeIds: ReadonlyArray<string>): Promise<DeviceRecord[]> {
    if (storeIds.length === 0) return [];

    const expressionAttributeValues: Record<string, AttributeValue> = {};
    const placeholders: string[] = [];
    storeIds.forEach((storeId, index) => {
      const placeholder = `:s${index}`;
      placeholders.push(placeholder);
      expressionAttributeValues[placeholder] = s(storeId);
    });

    const filterExpression = `#g IN (${placeholders.join(", ")})`;

    const collected: DeviceRecord[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;

    do {
      const input: ScanInput = {
        TableName: this.options.devicesTableName,
        FilterExpression: filterExpression,
        ExpressionAttributeNames: { "#g": "Group" },
        ExpressionAttributeValues: expressionAttributeValues
      };
      if (exclusiveStartKey !== undefined) {
        input.ExclusiveStartKey = exclusiveStartKey;
      }

      const response = await dynamoClient.send(new ScanCommand(input));
      const items = response.Items ?? [];
      for (const item of items) {
        collected.push(this.toDeviceRecord(item));
      }
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);

    return collected;
  }

  /**
   * GetItem on the Devices table for a single deviceCode. Returns null when
   * the device row is missing entirely. Includes the `Group` attribute via
   * `ProjectionExpression "#g"` (reserved word).
   */
  async getDevice(deviceCode: string): Promise<DeviceRecord | null> {
    const response = await dynamoClient.send(
      new GetItemCommand({
        TableName: this.options.devicesTableName,
        Key: { DeviceCode: s(deviceCode) },
        // Project the key plus the surfaced response fields. `#g` aliases the
        // reserved word `Group`. Including DeviceCode (the partition key) on
        // the projection ensures we get a non-empty Item back even if the
        // row exists but has no Group / no metadata yet.
        ProjectionExpression:
          "DeviceCode, #g, DeviceName, AppVersion, LastSeenAtUtc, PendingCommands, FailedJobs",
        ExpressionAttributeNames: { "#g": "Group" }
      })
    );

    const item = response.Item;
    if (!item || Object.keys(item).length === 0) return null;
    return this.toDeviceRecord(item);
  }

  private toDeviceRecord(item: Record<string, AttributeValue>): DeviceRecord {
    return {
      deviceCode: readString(item, "DeviceCode"),
      storeId: readString(item, "Group"),
      deviceName: readString(item, "DeviceName"),
      appVersion: readString(item, "AppVersion"),
      lastSeenAtUtc: readString(item, "LastSeenAtUtc"),
      pendingCommands: readNumber(item, "PendingCommands"),
      failedJobs: readNumber(item, "FailedJobs")
    };
  }
}
