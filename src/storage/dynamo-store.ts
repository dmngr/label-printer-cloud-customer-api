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
import { toCatalogProductIdentity, toCatalogTemplateIdentity } from "../lib/catalog-identities";
import type {
  CatalogProductItem,
  CatalogProductLookup,
  CatalogTemplateItem,
  CatalogTemplateLookup,
  CustomerTokenRecord,
  DeviceCommandRecord,
  DeviceRecord,
  PrintJobItem,
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

interface PutItemInput {
  TableName: string;
  Item: Record<string, AttributeValue>;
}

// Empty by design: the write path does not request ReturnValues.
type PutItemOutput = Record<string, never>;

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
  PutItemCommand: DynamoCommandCtor<PutItemInput, PutItemOutput>;
}

// The managed Lambda runtime provides AWS SDK v3; keep it out of the bundle.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sdk: DynamoSdkModule = require("@aws-sdk/client-dynamodb") as DynamoSdkModule;
const { DynamoDBClient, GetItemCommand, UpdateItemCommand, ScanCommand, QueryCommand, PutItemCommand } = sdk;

/**
 * Module-scoped client so successive invocations on a warm container reuse
 * the underlying connection pool. Constructor reads region from env
 * (`AWS_REGION` is set automatically by Lambda).
 */
const dynamoClient = new DynamoDBClient({});

function s(value: string | null | undefined): AttributeValue {
  return { S: typeof value === "string" ? value : "" };
}

function n(value: number): AttributeValue {
  // Dynamo N attributes must be strings on the wire. Mirror the integer-only
  // shape we use elsewhere — the call sites here only pass non-negative
  // integers (id counter, epoch seconds) so a plain `toString()` suffices.
  return { N: String(value) };
}

/**
 * Format the GSI sort key the device-side claim flow expects on
 * `DeviceStatusRequestedKey`. Mirrors the existing device-command-write
 * Lambda (`{Status}#{requestedAtUtc:O}#{Id:D20}`) so a row written here is
 * indistinguishable on the GSI from a row written by the cloud admin tool.
 */
function buildDeviceStatusRequestedKey(status: string, requestedAtUtc: string, id: number): string {
  // 20-digit zero-padded Id keeps GSI lex order monotonic across the
  // counter's full range (long.MaxValue is 19 digits).
  const padded = id.toString().padStart(20, "0");
  return `${status}#${requestedAtUtc}#${padded}`;
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
function readOptionalString(item: Record<string, AttributeValue> | undefined, key: string): string | undefined {
  if (!item) return undefined;
  const attr = item[key];
  if (!attr || typeof attr.S !== "string" || attr.S.length === 0) return undefined;
  return attr.S;
}

/**
 * Read a present-only string, returning `null` when the attribute is missing
 * or blank. Used for fields where the wire schema explicitly allows `null`.
 */
function readNullableString(item: Record<string, AttributeValue> | undefined, key: string): string | null {
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
function readPriceAsCents(item: Record<string, AttributeValue> | undefined, key: string): number | undefined {
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
        Key: { TokenHash: s(tokenHash) },
      }),
    );

    const item = response.Item;
    if (!item || Object.keys(item).length === 0) return null;

    const storeIdsAttr = item["StoreIds"];
    const storeIds = storeIdsAttr && Array.isArray(storeIdsAttr.SS) ? [...storeIdsAttr.SS] : [];

    return {
      tokenHash: readString(item, "TokenHash"),
      storeIds,
      lastUsedAtUtc: readString(item, "LastUsedAtUtc"),
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
            ":now": s(nowIso),
          },
          ReturnValues: "NONE",
        }),
      );
    } catch (err) {
      console.log("touch_last_used_failed", {
        message: err instanceof Error ? err.message : String(err),
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
        ExpressionAttributeValues: expressionAttributeValues,
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
        ProjectionExpression: "DeviceCode, #g, DeviceName, AppVersion, LastSeenAtUtc, PendingCommands, FailedJobs",
        ExpressionAttributeNames: { "#g": "Group" },
      }),
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
      failedJobs: readNumber(item, "FailedJobs"),
    };
  }

  /**
   * Query the catalog-products GSI by `DeviceCode`, transparently following
   * `LastEvaluatedKey` up to `CATALOG_PAGE_LIMIT` items total. Catalogs are
   * small in Phase 1 — the spec does not surface pagination here.
   */
  async queryProductsByDeviceCode(deviceCode: string): Promise<CatalogProductItem[]> {
    return this.queryCatalogByDeviceCode(this.options.catalogProductsTableName, deviceCode, toProductItem);
  }

  /**
   * Query the catalog-templates GSI by `DeviceCode`, transparently following
   * `LastEvaluatedKey` up to `CATALOG_PAGE_LIMIT` items total.
   */
  async queryTemplatesByDeviceCode(deviceCode: string): Promise<CatalogTemplateItem[]> {
    return this.queryCatalogByDeviceCode(this.options.catalogTemplatesTableName, deviceCode, toTemplateItem);
  }

  private async queryCatalogByDeviceCode<T>(tableName: string, deviceCode: string, parse: (item: Record<string, AttributeValue>) => T): Promise<T[]> {
    const collected: T[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;

    do {
      const input: QueryInput = {
        TableName: tableName,
        IndexName: this.options.catalogDeviceCodeIndexName,
        KeyConditionExpression: "DeviceCode = :dc",
        ExpressionAttributeValues: { ":dc": s(deviceCode) },
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
    cursor: Record<string, AttributeValue> | undefined,
  ): Promise<{ items: PrintJobItem[]; nextCursor: Record<string, AttributeValue> | undefined }> {
    const input: QueryInput = {
      TableName: this.options.printJobsTableName,
      IndexName: this.options.printJobsDeviceCreatedIndexName,
      KeyConditionExpression: "DeviceCode = :dc",
      ExpressionAttributeValues: { ":dc": s(deviceCode) },
      ScanIndexForward: false,
      Limit: limit,
    };
    if (cursor !== undefined) {
      input.ExclusiveStartKey = cursor;
    }

    const response = await dynamoClient.send(new QueryCommand(input));
    const items = (response.Items ?? []).map(toPrintJobItem);
    return {
      items,
      nextCursor: response.LastEvaluatedKey,
    };
  }

  /**
   * Look up a single catalog-product row for `deviceCode` whose `Code`
   * matches `productCode` (case-insensitive). Uses the same `DeviceCodeIndex`
   * GSI the catalog-list endpoint uses, narrowed with a `begins_with` on
   * `CodeSortKey` to project just the rows for one product code.
   *
   * The GSI sort key is `{CODE_UPPER}#{LocalProductId:D10}` (writer:
   * `DynamoCloudCatalogStore.CreateCodeSortKey`). A `begins_with(CODE_UPPER#)`
   * narrows the query to one product code without scanning the whole catalog
   * — there can be at most one row per `(deviceCode, code)` since the writer
   * upserts on `LocalProductId` and the local DB has a unique-code constraint.
   *
   * Returns `null` when no row matches; callers turn that into a 400 with
   * `customer_api_command_product_not_found`.
   */
  async findProductByCode(deviceCode: string, productCode: string): Promise<CatalogProductLookup | null> {
    return this.findCatalogRowByCode(this.options.catalogProductsTableName, deviceCode, productCode, toCatalogProductIdentity);
  }

  /**
   * Look up a single catalog-template row for `deviceCode` whose `Code`
   * matches `templateCode` (case-insensitive). Same shape and rationale as
   * `findProductByCode`. Only called when the caller passed a non-empty
   * `templateCode` on the request body.
   */
  async findTemplateByCode(deviceCode: string, templateCode: string): Promise<CatalogTemplateLookup | null> {
    return this.findCatalogRowByCode(this.options.catalogTemplatesTableName, deviceCode, templateCode, toCatalogTemplateIdentity);
  }

  private async findCatalogRowByCode<T>(
    tableName: string,
    deviceCode: string,
    code: string,
    parse: (item: Record<string, AttributeValue>) => T,
  ): Promise<T | null> {
    const trimmed = code.trim();
    if (trimmed.length === 0) return null;
    // CodeSortKey is uppercased on write — match that here so a lowercase
    // `productCode` from the web app still resolves the row.
    const prefix = `${trimmed.toUpperCase()}#`;

    const input: QueryInput = {
      TableName: tableName,
      IndexName: this.options.catalogDeviceCodeIndexName,
      KeyConditionExpression: "DeviceCode = :dc AND begins_with(CodeSortKey, :sk)",
      ExpressionAttributeValues: {
        ":dc": s(deviceCode),
        ":sk": s(prefix),
      },
      Limit: 1,
    };

    const response = await dynamoClient.send(new QueryCommand(input));
    const items = response.Items ?? [];
    if (items.length === 0) return null;
    return parse(items[0]!);
  }

  /**
   * Atomically increment the `DeviceCommands` counter row and return the
   * post-increment value. Lazy-creates the row at value 1 if it doesn't
   * exist yet (Dynamo `ADD` on a missing attribute treats it as 0 + delta).
   *
   * Counter attribute is `NextValue` to match the existing
   * device-command-write Lambda (`label-printer-cloud-device-command-write`).
   * If we ever forked this to use a different attribute name the two would
   * silently mint duplicate Ids — single-source the counter.
   */
  async getNextDeviceCommandId(): Promise<number> {
    const response = await dynamoClient.send(
      new UpdateItemCommand({
        TableName: this.options.countersTableName,
        Key: { CounterName: s("DeviceCommands") },
        UpdateExpression: "ADD NextValue :one",
        ExpressionAttributeValues: { ":one": n(1) },
        ReturnValues: "ALL_NEW",
      }),
    );

    const attrs = response.Attributes;
    const raw = attrs?.["NextValue"]?.N;
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error("counter_update_returned_no_next_value");
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`counter_returned_unparseable_next_value:${raw}`);
    }
    return parsed;
  }

  /**
   * Write a brand-new `Pending` device command row. Mirrors the schema of
   * the existing device-command-write Lambda exactly — same attribute
   * names, same `DeviceStatusRequestedKey` format, same `RequestedAtUtc:O`
   * shape — so the device-side `CloudRemoteCommandService` claim flow picks
   * it up unchanged.
   *
   * Caller is responsible for: minting the Id (via `getNextDeviceCommandId`),
   * hydrating the catalog payload (via `findProductByCode`/`findTemplateByCode`),
   * and supplying a sensible `requestedBy` (we use
   * `customer-api:<TokenHash[:16]>` upstream — never the full token hash).
   */
  async putPendingDeviceCommand(input: {
    id: number;
    deviceCode: string;
    storeCode: string;
    commandType: string;
    payloadJson: string;
    requestedBy: string;
    requestedAtUtc: string;
    requestedAtEpochSeconds: number;
  }): Promise<void> {
    const item: Record<string, AttributeValue> = {
      Id: n(input.id),
      DeviceCode: s(input.deviceCode),
      StoreCode: s(input.storeCode),
      CommandType: s(input.commandType),
      PayloadJson: s(input.payloadJson),
      Status: s("Pending"),
      RequestedBy: s(input.requestedBy),
      RequestedAtUtc: s(input.requestedAtUtc),
      RequestedAtEpochSeconds: n(input.requestedAtEpochSeconds),
      DeviceStatusRequestedKey: s(buildDeviceStatusRequestedKey("Pending", input.requestedAtUtc, input.id)),
    };

    await dynamoClient.send(
      new PutItemCommand({
        TableName: this.options.deviceCommandsTableName,
        Item: item,
      }),
    );
  }

  /**
   * GetItem on the device-commands table for a single Id. Returns null when
   * the row is absent. The handler treats null as 404 with
   * `customer_api_command_not_found`. Authorisation (verifying the row's
   * `DeviceCode` matches the caller's authorised device) happens above.
   */
  async getDeviceCommandById(id: number): Promise<DeviceCommandRecord | null> {
    const response = await dynamoClient.send(
      new GetItemCommand({
        TableName: this.options.deviceCommandsTableName,
        Key: { Id: n(id) },
      }),
    );

    const item = response.Item;
    if (!item || Object.keys(item).length === 0) return null;
    return toDeviceCommandRecord(item);
  }
}

function toProductItem(item: Record<string, AttributeValue>): CatalogProductItem {
  const identity = toCatalogProductIdentity(item);
  const result: CatalogProductItem = {
    ...identity,
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
  const identity = toCatalogTemplateIdentity(item);
  const result: CatalogTemplateItem = {
    ...identity,
  };
  const updatedAtUtc = readOptionalString(item, "LocalLastModifiedUtc");
  if (updatedAtUtc !== undefined) result.updatedAtUtc = updatedAtUtc;
  return result;
}

function toDeviceCommandRecord(item: Record<string, AttributeValue>): DeviceCommandRecord {
  // Best-effort parse of the row's PayloadJson to extract `ProductCode` for
  // the wire response — the row stores the full hydrated payload as a single
  // string attribute, so we can't read it directly via Dynamo projection.
  // A malformed / missing payload degrades to an empty productCode rather
  // than failing the GET.
  let productCode = "";
  const rawPayload = readOptionalString(item, "PayloadJson");
  if (typeof rawPayload === "string" && rawPayload.length > 0) {
    try {
      const parsed = JSON.parse(rawPayload) as { ProductCode?: unknown };
      if (typeof parsed.ProductCode === "string") {
        productCode = parsed.ProductCode;
      }
    } catch {
      // ignore — productCode stays "".
    }
  }

  return {
    id: readNumber(item, "Id"),
    deviceCode: readString(item, "DeviceCode"),
    storeCode: readString(item, "StoreCode"),
    commandType: readString(item, "CommandType"),
    status: readString(item, "Status"),
    requestedAtUtc: readString(item, "RequestedAtUtc"),
    claimedAtUtc: readNullableString(item, "ClaimedAtUtc"),
    completedAtUtc: readNullableString(item, "CompletedAtUtc"),
    errorMessage: readNullableString(item, "ErrorMessage"),
    productCode,
  };
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
    labelCount: quantity > 0 ? quantity : 1,
  };
  const templateCode = readOptionalString(item, "TemplateCode");
  if (templateCode !== undefined) result.templateCode = templateCode;
  return result;
}
