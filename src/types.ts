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
  id: number;
  code: string;
  name: string;
}

/** Same shape as `CatalogProductLookup`, projected from the templates table. */
export interface CatalogTemplateLookup {
  id: number;
  code: string;
  name: string;
}

/**
 * Body the customer-api accepts on `POST /commands`. Only `print-label` is
 * supported in the Phase 2 cut. `quantity` defaults to 1 server-side and is
 * range-validated (1..999). `templateCode` is optional — when absent the
 * device falls back to the product's default template at print time.
 */
export interface CreateCommandRequestBody {
  commandType?: unknown;
  productCode?: unknown;
  templateCode?: unknown;
  quantity?: unknown;
}

/**
 * Wire payload returned by `POST /commands` (HTTP 201). Mirrors the row
 * the device-side claim flow will pick up next time it polls.
 */
export interface CreateCommandResponse {
  id: number;
  status: string;
  requestedAtUtc: string;
  commandType: string;
  productCode: string;
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
