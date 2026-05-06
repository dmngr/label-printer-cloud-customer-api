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
