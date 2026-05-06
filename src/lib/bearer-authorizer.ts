/**
 * Bearer extractor + sha256 hasher for the customer-api Lambda.
 *
 * Strict mode only here: every request MUST present a customer bearer in
 * `Authorization: Bearer <token>`. The actual token-row lookup lives in the
 * dynamo store; this module is just the parsing/hashing surface.
 */

import { createHash } from "node:crypto";
import type { LambdaFunctionURLEvent } from "aws-lambda";

const BEARER_PREFIX = "Bearer ";

export type ExtractBearerResult =
  | { kind: "ok"; bearer: string }
  | { kind: "missing" }
  | { kind: "invalid" };

export function extractBearer(event: LambdaFunctionURLEvent): ExtractBearerResult {
  const headerValue = getAuthorizationHeader(event);
  if (headerValue === undefined) return { kind: "missing" };
  if (!startsWithCaseInsensitive(headerValue, BEARER_PREFIX)) return { kind: "invalid" };
  const token = headerValue.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0) return { kind: "invalid" };
  return { kind: "ok", bearer: token };
}

export function sha256Hex(value: string | null | undefined): string {
  const buf = Buffer.from(typeof value === "string" ? value : "", "utf8");
  return createHash("sha256").update(buf).digest("hex");
}

function getAuthorizationHeader(event: LambdaFunctionURLEvent): string | undefined {
  const headers = event.headers;
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization" && typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function startsWithCaseInsensitive(value: string, prefix: string): boolean {
  if (value.length < prefix.length) return false;
  return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}
