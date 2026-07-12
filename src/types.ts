/**
 * Shared types for the customer-api Lambda.
 *
 * The wire shapes are locked here so the web app at app.label.ninja can be
 * wired against them in a follow-up without re-discovering them from the
 * handler implementation.
 */

export interface CustomerTokenRecord {
  tokenHash: string;
  storeIds: string[];
  lastUsedAtUtc: string;
}

export interface DeviceRecord {
  deviceCode: string;
  storeId: string;
  deviceName: string;
  appVersion: string;
  lastSeenAtUtc: string;
  pendingCommands: number;
  failedJobs: number;
}

export interface DeviceSummary {
  deviceCode: string;
  deviceName: string;
  appVersion: string;
  lastSeenAtUtc: string;
  isActive: boolean;
  isOnline: boolean;
  pendingCommands: number;
  failedJobs: number;
}

export interface DeviceDetail extends DeviceSummary {
  storeId: string;
}

export interface StoreSummary {
  storeId: string;
  deviceCount: number;
  onlineCount: number;
}

export interface StoresResponse {
  stores: StoreSummary[];
}

export interface StoreDevicesGroup {
  storeId: string;
  devices: DeviceSummary[];
}

export interface DevicesResponse {
  stores: StoreDevicesGroup[];
}

/**
 * Catalog product item — projection of `DMLabelPrinterCloudCatalogProducts`
 * rows surfaced to the customer-facing web app.
 *
 * Optional fields are omitted when absent on the record (per spec). `priceCents`
 * is computed by multiplying the stored decimal `Price` by 100 (rounded).
 */
export interface CatalogProductItem {
  /** Device-local product id (LocalProductId), not the DynamoDB row key. */
  id: number;
  code: string;
  name: string;
  categoryName?: string;
  priceCents?: number;
  updatedAtUtc?: string;
}

export interface CatalogProductsResponse {
  items: CatalogProductItem[];
}

/**
 * Catalog template item — projection of `DMLabelPrinterCloudCatalogTemplates`
 * rows surfaced to the customer-facing web app.
 */
export interface CatalogTemplateItem {
  /** Device-local template id (LocalTemplateId), not the DynamoDB row key. */
  id: number;
  code: string;
  name: string;
  updatedAtUtc?: string;
}

export interface CatalogTemplatesResponse {
  items: CatalogTemplateItem[];
}

/**
 * Print-job item — projection of `DMLabelPrinterCloudPrintJobs` rows.
 *
 * Per spec, `completedAtUtc` and `errorMessage` are written as `null` when
 * absent on the record (nullable in the wire schema). Other optional fields
 * are omitted when absent.
 */
export interface PrintJobItem {
  id: number;
  createdAtUtc: string;
  completedAtUtc: string | null;
  status: string;
  templateCode?: string;
  errorMessage: string | null;
  labelCount: number;
}

export interface PrintJobsResponse {
  items: PrintJobItem[];
  nextCursor: string | null;
}

/**
 * Catalog product lookup record returned by the storage layer when hydrating
 * a print-label command's payload from a customer-supplied `productCode`.
 *
 * Only the three id-ish fields are projected from the catalog row — the rest
 * (price, category, …) live on the catalog response surface, not on the
 * command payload the device-side `CloudRemoteCommandService` consumes.
 */
export interface CatalogProductLookup {
  /** Device-local product id used by local API commands. */
  id: number;
  code: string;
  name: string;
}

/** Same shape as `CatalogProductLookup`, projected from the templates table. */
export interface CatalogTemplateLookup {
  /** Device-local template id used by local API commands. */
  id: number;
  code: string;
  name: string;
}

/**
 * Body the customer-api accepts on `POST /commands`. Phase 3 added four
 * catalog-edit command types alongside `print-label`:
 *
 *   - `print-label`     — enqueue a label print (server hydrates payload from
 *                         the catalog mirror).
 *   - `upsert-product`  — insert/update a product (payload IS the intent).
 *   - `delete-product`  — delete a product by id.
 *   - `upsert-template` — insert/update a template (payload IS the intent).
 *   - `delete-template` — delete a template by id.
 *
 * The fields marked optional below are only populated for the matching
 * `commandType`; the handler validates them per type. We type them as
 * `unknown` so the discriminator + per-field validators stay strict.
 */
export interface CreateCommandRequestBody {
  commandType?: unknown;
  // print-label fields
  productCode?: unknown;
  templateCode?: unknown;
  quantity?: unknown;
  // upsert-product / upsert-template payloads
  product?: unknown;
  template?: unknown;
  // delete-product / delete-template ids
  productId?: unknown;
  templateId?: unknown;
}

/**
 * Wire payload returned by `POST /commands` (HTTP 201). Mirrors the row
 * the device-side claim flow will pick up next time it polls.
 *
 * `productCode` is only meaningful for `print-label`; for the Phase 3
 * catalog-edit types (`upsert-product` / `delete-product` / `upsert-template`
 * / `delete-template`) it stays `null` since the row's PayloadJson encodes
 * the upsert/delete intent rather than a product reference.
 */
export interface CreateCommandResponse {
  id: number;
  status: string;
  requestedAtUtc: string;
  commandType: string;
  productCode: string | null;
}

/**
 * Wire payload returned by `GET /commands/{id}` (HTTP 200). `claimedAtUtc`,
 * `completedAtUtc` and `errorMessage` are nullable — they only appear on the
 * row after the device claims / completes the command.
 */
export interface CommandDetailResponse {
  id: number;
  status: string;
  commandType: string;
  requestedAtUtc: string;
  claimedAtUtc: string | null;
  completedAtUtc: string | null;
  productCode: string;
  errorMessage: string | null;
}

/**
 * Internal record returned by the storage layer when a command row is read
 * back. The handler shapes this into `CommandDetailResponse` on the wire.
 */
export interface DeviceCommandRecord {
  id: number;
  deviceCode: string;
  storeCode: string;
  commandType: string;
  status: string;
  requestedAtUtc: string;
  claimedAtUtc: string | null;
  completedAtUtc: string | null;
  errorMessage: string | null;
  productCode: string;
}
