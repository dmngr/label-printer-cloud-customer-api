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
import type {
  CatalogProductItem,
  CatalogTemplateItem,
  CustomerTokenRecord,
  DeviceRecord,
  PrintJobItem
} from "../types";

/**
 * Hard upper bound for the transparent paging loop on products / templates.
 * Catalogs are small (typical device < 200 items); we follow LastEvaluatedKey
 * up to this many items to keep behaviour predictable for outliers.
 */
const CATALOG_PAGE_LIMIT = 1000;

// AWS SDK v3 is runtime-included on Node 18+ Lambda runtimes (Phase 4 hygiene:
// nothing pinned in `package.json`). We require it at runtime and declare just
// enough of the surface area to keep the rest of this file strictly typed.

interface AttributeValue {
  S?: string;
  N?: string;
  SS?: string[];
  BOOL?: boolean;
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

interface QueryInput {
  TableName: string;
  IndexName?: string;
  KeyConditionExpression: string;
  ProjectionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues: Record<string, AttributeValue>;
  ScanIndexForward?: boolean;
  Limit?: number;
  ExclusiveStartKey?: Record<string, AttributeValue>;
}

interface QueryOutput {
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
  QueryCommand: DynamoCommandCtor<QueryInput, QueryOutput>;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk: DynamoSdkModule = require("@aws-sdk/client-dynamodb") as DynamoSdkModule;
const { DynamoDBClient, GetItemCommand, UpdateItemCommand, ScanCommand, QueryCommand } = sdk;

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

/**
 * Read a present-only string from an Item, returning `undefined` when the
 * attribute is missing or empty (so callers can omit the field from the
 * response payload per the wire spec).
 */
function readOptionalString(
  item: Record<string, AttributeValue> | undefined,
  key: string
): string | undefined {
  if (!item) return undefined;
  const attr = item[key];
  if (!attr || typeof attr.S !== "string" || attr.S.length === 0) return undefined;
  return attr.S;
}

/**
 * Read a present-only string, returning `null` when the attribute is missing
 * or blank. Used for fields where the wire schema explicitly allows `null`.
 */
function readNullableString(
  item: Record<string, AttributeValue> | undefined,
  key: string
): string | null {
  if (!item) return null;
  const attr = item[key];
  if (!attr || typeof attr.S !== "string" || attr.S.length === 0) return null;
  return attr.S;
}

/**
 * Read a decimal-N attribute and convert to integer cents. Returns `undefined`
 * when the attribute is missing or unparseable. We don't use floating-point
 * multiplication — the attribute string is parsed manually so values like
 * "2.5" round to 250 deterministically.
 */
function readPriceAsCents(
  item: Record<string, AttributeValue> | undefined,
  key: string
): number | undefined {
  if (!item) return undefined;
  const attr = item[key];
  if (!attr || typeof attr.N !== "string" || attr.N.length === 0) return undefined;
  const trimmed = attr.N.trim();
  if (trimmed.length === 0) return undefined;
  // Treat negative prices and NaN as missing — a malformed entry is safer to
  // omit than to surface as a confusing negative value to the web app.
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed * 100);
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

  /**
   * Query the catalog-products GSI by `DeviceCode`, transparently following
   * `LastEvaluatedKey` up to `CATALOG_PAGE_LIMIT` items total. Catalogs are
   * small in Phase 1 — the spec does not surface pagination here.
   */
  async queryProductsByDeviceCode(deviceCode: string): Promise<CatalogProductItem[]> {
    return this.queryCatalogByDeviceCode(
      this.options.catalogProductsTableName,
      deviceCode,
      toProductItem
    );
  }

  /**
   * Query the catalog-templates GSI by `DeviceCode`, transparently following
   * `LastEvaluatedKey` up to `CATALOG_PAGE_LIMIT` items total.
   */
  async queryTemplatesByDeviceCode(deviceCode: string): Promise<CatalogTemplateItem[]> {
    return this.queryCatalogByDeviceCode(
      this.options.catalogTemplatesTableName,
      deviceCode,
      toTemplateItem
    );
  }

  private async queryCatalogByDeviceCode<T>(
    tableName: string,
    deviceCode: string,
    parse: (item: Record<string, AttributeValue>) => T
  ): Promise<T[]> {
    const collected: T[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;

    do {
      const input: QueryInput = {
        TableName: tableName,
        IndexName: this.options.catalogDeviceCodeIndexName,
        KeyConditionExpression: "DeviceCode = :dc",
        ExpressionAttributeValues: { ":dc": s(deviceCode) }
      };
      if (exclusiveStartKey !== undefined) {
        input.ExclusiveStartKey = exclusiveStartKey;
      }

      const response = await dynamoClient.send(new QueryCommand(input));
      const items = response.Items ?? [];
      for (const item of items) {
        if (collected.length >= CATALOG_PAGE_LIMIT) {
          // Hard stop — see CATALOG_PAGE_LIMIT comment.
          return collected;
        }
        collected.push(parse(item));
      }
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined && collected.length < CATALOG_PAGE_LIMIT);

    return collected;
  }

  /**
   * Query the print-jobs `DeviceCreatedIndex` GSI by `DeviceCode`, ordered
   * descending by `CreatedSortKey`. Honors the caller-supplied `limit` and
   * `cursor`; returns `nextCursor` when more pages exist on the GSI.
   */
  async queryPrintJobsByDevice(
    deviceCode: string,
    limit: number,
    cursor: Record<string, AttributeValue> | undefined
  ): Promise<{ items: PrintJobItem[]; nextCursor: Record<string, AttributeValue> | undefined }> {
    const input: QueryInput = {
      TableName: this.options.printJobsTableName,
      IndexName: this.options.printJobsDeviceCreatedIndexName,
      KeyConditionExpression: "DeviceCode = :dc",
      ExpressionAttributeValues: { ":dc": s(deviceCode) },
      ScanIndexForward: false,
      Limit: limit
    };
    if (cursor !== undefined) {
      input.ExclusiveStartKey = cursor;
    }

    const response = await dynamoClient.send(new QueryCommand(input));
    const items = (response.Items ?? []).map(toPrintJobItem);
    return {
      items,
      nextCursor: response.LastEvaluatedKey
    };
  }
}

function toProductItem(item: Record<string, AttributeValue>): CatalogProductItem {
  const result: CatalogProductItem = {
    id: readNumber(item, "Id"),
    code: readString(item, "Code"),
    name: readString(item, "Name")
  };
  const categoryName = readOptionalString(item, "CategoryName");
  if (categoryName !== undefined) result.categoryName = categoryName;
  const priceCents = readPriceAsCents(item, "Price");
  if (priceCents !== undefined) result.priceCents = priceCents;
  // The cloud writer uses `LocalLastModifiedUtc` for the row's "updated at"
  // — mirror that as `updatedAtUtc` on the wire.
  const updatedAtUtc = readOptionalString(item, "LocalLastModifiedUtc");
  if (updatedAtUtc !== undefined) result.updatedAtUtc = updatedAtUtc;
  return result;
}

function toTemplateItem(item: Record<string, AttributeValue>): CatalogTemplateItem {
  const result: CatalogTemplateItem = {
    id: readNumber(item, "Id"),
    code: readString(item, "Code"),
    name: readString(item, "Name")
  };
  const updatedAtUtc = readOptionalString(item, "LocalLastModifiedUtc");
  if (updatedAtUtc !== undefined) result.updatedAtUtc = updatedAtUtc;
  return result;
}

function toPrintJobItem(item: Record<string, AttributeValue>): PrintJobItem {
  const quantity = readNumber(item, "Quantity");
  const result: PrintJobItem = {
    id: readNumber(item, "Id"),
    createdAtUtc: readString(item, "LocalCreatedAtUtc"),
    completedAtUtc: readNullableString(item, "LocalPrintedAtUtc"),
    status: readString(item, "Status"),
    errorMessage: readNullableString(item, "ErrorMessage"),
    // labelCount = Quantity — print jobs are written with Quantity defaulted
    // to 1, so 0 (missing) is treated as 1 to keep the wire schema honest.
    labelCount: quantity > 0 ? quantity : 1
  };
  const templateCode = readOptionalString(item, "TemplateCode");
  if (templateCode !== undefined) result.templateCode = templateCode;
  return result;
}
