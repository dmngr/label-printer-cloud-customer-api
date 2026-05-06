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
