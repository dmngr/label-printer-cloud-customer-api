/**
 * Handled-errors emitter, implementing the canonical `ACTION:` log marker
 * documented in `dmngr/lambda-policies/handled-errors/handled-error-policy.md`.
 *
 * Log line shape (must be a single whitespace-delimited token — no spaces
 * inside `ACTION:...`):
 *
 *   ACTION:SLACK_HANDLED_ERROR_HE1=<error_code>|<base64url(json)>
 *
 * Suppression of the legacy Slack alert (`RequestId SUCCESS`) is gated by
 * `custom_errors.policy.json` at the repo root. We default to `false` so an
 * unknown / missing code is never silently suppressed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface PolicyEntry {
  emit_requestid_success?: boolean;
}

interface PolicyFile {
  defaults?: { emit_requestid_success?: boolean };
  errors?: Record<string, PolicyEntry>;
}

let cachedPolicy: PolicyFile | null | undefined;

function loadPolicy(): PolicyFile | null {
  if (cachedPolicy !== undefined) return cachedPolicy;

  // Look in CWD (Lambda working dir) and one level up (covers `dist/` builds
  // where __dirname points inside the compiled bundle).
  const candidates = [
    path.join(process.cwd(), "custom_errors.policy.json"),
    path.join(__dirname, "..", "..", "custom_errors.policy.json"),
    path.join(__dirname, "..", "..", "..", "custom_errors.policy.json")
  ];

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as PolicyFile;
      cachedPolicy = parsed && typeof parsed === "object" ? parsed : null;
      return cachedPolicy;
    } catch {
      // try next candidate
    }
  }

  cachedPolicy = null;
  return cachedPolicy;
}

/**
 * Returns whether the handled-error policy says we may suppress legacy Slack
 * alerting for `errorCode` by also emitting `RequestId SUCCESS`.
 *
 * Safety: any failure to read/parse the policy returns `false` (no
 * suppression).
 */
export function shouldSuppress(errorCode: string): boolean {
  const code = String(errorCode || "").trim();
  if (code.length === 0) return false;

  const policy = loadPolicy();
  if (!policy || typeof policy !== "object") return false;

  const override = policy.errors?.[code]?.emit_requestid_success;
  if (typeof override === "boolean") return override;

  return Boolean(policy.defaults?.emit_requestid_success);
}

function base64UrlEncode(jsonString: string): string {
  return Buffer.from(jsonString, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Emit a handled-error marker for `errorCode`. The caller is responsible for
 * deciding whether to also write `RequestId SUCCESS` (only for *non-catch*
 * code paths and only when policy says so) — see policy.
 *
 * IMPORTANT: this is logged as a single token. Do not split across multiple
 * `console.log` arguments — the firehose transformer tokenizes on whitespace
 * and would lose the marker.
 */
export function logHandledErrorAction(errorCode: string, suppressed: boolean): void {
  const payload = {
    v: 2,
    error_code: errorCode,
    suppressed: Boolean(suppressed)
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  console.log(`ACTION:SLACK_HANDLED_ERROR_HE1=${errorCode}|${encoded}`);
}

const REDACT_VALUE = "[REDACTED]";
const SENSITIVE_KEY_RE =
  /^(authorization|cookie|set-cookie|x-api-key|x-amz-security-token|token|access_token|refresh_token|id_token|password|secret)$/i;

/**
 * Recursively replaces values whose key matches the sensitive-key allowlist
 * with `[REDACTED]`. Preserves the schema (same keys/arrays) so the catch
 * event log is replay-safe.
 */
export function redactDeep(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((entry) => redactDeep(entry, seen));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, val]) => [
      key,
      SENSITIVE_KEY_RE.test(key) ? REDACT_VALUE : redactDeep(val, seen)
    ])
  );
}

/**
 * Custom error class used to flag policy-tracked failure modes. The `code`
 * field is the stable `error_code` used by the handled-errors pipeline and
 * `custom_errors.policy.json`.
 */
export class CustomError extends Error {
  public readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "CustomError";
    this.code = code;
  }
}
