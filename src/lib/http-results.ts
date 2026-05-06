/**
 * Function URL response helpers, mirrored from the customer-pairing repo.
 *
 * Function URL `BUFFERED` mode expects an `APIGatewayProxyStructuredResultV2`
 * shape (`{ statusCode, headers, body }`).
 */

import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export type LambdaResponse = APIGatewayProxyStructuredResultV2;

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

function buildHeaders(contentType: string | null): Record<string, string> {
  const headers: Record<string, string> = { ...CORS_HEADERS };
  if (contentType !== null) {
    headers["Content-Type"] = contentType;
  }
  return headers;
}

export function jsonResponse(statusCode: number, payload: unknown): LambdaResponse {
  return {
    statusCode,
    headers: buildHeaders("application/json; charset=utf-8"),
    body: JSON.stringify(payload)
  };
}

export function textResponse(statusCode: number, message: string): LambdaResponse {
  return {
    statusCode,
    headers: buildHeaders("text/plain; charset=utf-8"),
    body: message
  };
}

export function noContentResponse(): LambdaResponse {
  return {
    statusCode: 204,
    headers: buildHeaders(null),
    body: ""
  };
}
