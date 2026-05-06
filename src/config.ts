/**
 * Env-var-driven config for the customer-api Lambda.
 *
 * The DM cloud bearer token used by the customer-pairing device-side endpoint
 * is intentionally NOT read here — this Lambda is web-side only and gates
 * every request on a customer bearer (sha256 -> CustomerTokens table lookup).
 */

export interface CustomerApiOptions {
  devicesTableName: string;
  customerTokensTableName: string;
  /** Lower bound (minutes) for the device "online" heuristic. */
  onlineWindowMinutes: number;
  /** Lower bound (minutes) for the device "active" heuristic. */
  activeWindowMinutes: number;
}

const DEFAULT_DEVICES_TABLE = "DMLabelPrinterCloudDevices";
const DEFAULT_CUSTOMER_TOKENS_TABLE = "DMLabelPrinterCloudCustomerTokens";
const DEFAULT_ONLINE_WINDOW_MINUTES = 5;
const DEFAULT_ACTIVE_WINDOW_MINUTES = 60;

function readValue(key: string, fallback: string): string {
  const raw = process.env[key];
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

export function loadOptions(): CustomerApiOptions {
  return {
    devicesTableName: readValue("DM_LABEL_PRINTER_CLOUD_DEVICES_TABLE", DEFAULT_DEVICES_TABLE),
    customerTokensTableName: readValue(
      "DM_LABEL_PRINTER_CLOUD_CUSTOMER_TOKENS_TABLE",
      DEFAULT_CUSTOMER_TOKENS_TABLE
    ),
    onlineWindowMinutes: DEFAULT_ONLINE_WINDOW_MINUTES,
    activeWindowMinutes: DEFAULT_ACTIVE_WINDOW_MINUTES
  };
}
