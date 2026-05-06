/**
 * Smoke tests — verify the handler can be loaded without crashing the
 * runtime, that the bearer extractor + sha256 helpers behave as expected,
 * and that the redact/policy helpers ported from the customer-pairing repo
 * still pass their canonical assertions here.
 *
 * Run via the compiled JS output: `npm run build && node --test dist/test`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

test("sha256Hex returns lowercase 64-char hex for a base64url-shaped bearer", async () => {
  const { sha256Hex } = await import("../lib/bearer-authorizer");

  // Sanity: known SHA-256 of "abc" is ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
  const known = sha256Hex("abc");
  assert.equal(known, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

  // Shape check on a synthetic 32-byte base64url-ish bearer.
  const synthetic = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
  const hash = sha256Hex(synthetic);
  assert.equal(hash.length, 64);
  assert.ok(/^[0-9a-f]{64}$/.test(hash), `hash not lowercase hex: ${hash}`);
});

test("extractBearer parses the canonical Authorization header forms", async () => {
  const { extractBearer } = await import("../lib/bearer-authorizer");

  const ok = extractBearer({
    headers: { authorization: "Bearer abc.def" }
  } as never);
  assert.equal(ok.kind, "ok");
  if (ok.kind === "ok") assert.equal(ok.bearer, "abc.def");

  const missing = extractBearer({ headers: {} } as never);
  assert.equal(missing.kind, "missing");

  const invalidScheme = extractBearer({
    headers: { authorization: "Basic abcdef" }
  } as never);
  assert.equal(invalidScheme.kind, "invalid");

  const emptyBearer = extractBearer({
    headers: { authorization: "Bearer    " }
  } as never);
  assert.equal(emptyBearer.kind, "invalid");

  const caseInsensitive = extractBearer({
    headers: { Authorization: "bearer abc" }
  } as never);
  assert.equal(caseInsensitive.kind, "ok");
});

test("handler entrypoint compiles cleanly to dist/", async () => {
  // We can't import the handler under `node --test` locally because it
  // pulls in `@aws-sdk/client-dynamodb` (runtime-included on Node 18+ Lambda
  // runtimes; intentionally NOT pinned in package.json per Phase 4). So
  // instead we assert the compiled handler file exists and was emitted by
  // tsc — that's enough to catch a missing-export / build-broken regression.
  const fs = await import("node:fs");
  const path = await import("node:path");

  const apiEntry = path.resolve(__dirname, "..", "handlers", "customer-api.js");

  assert.ok(fs.existsSync(apiEntry), `missing compiled handler: ${apiEntry}`);

  const source = fs.readFileSync(apiEntry, "utf8");
  assert.match(source, /exports\.handler\s*=/);
  // BigInt shim must survive into the compiled output.
  assert.match(source, /BigInt\.prototype/);
});

test("redactDeep replaces sensitive header values but keeps the schema", async () => {
  const { redactDeep } = await import("../lib/handled-errors");

  const event = {
    headers: { authorization: "Bearer s3cret", "x-api-key": "k1", accept: "application/json" },
    body: '{"foo":"bar"}'
  };

  const redacted = redactDeep(event) as { headers: Record<string, string>; body: string };
  assert.equal(redacted.headers["authorization"], "[REDACTED]");
  assert.equal(redacted.headers["x-api-key"], "[REDACTED]");
  assert.equal(redacted.headers["accept"], "application/json");
  assert.equal(redacted.body, '{"foo":"bar"}');
});

test("handled-error policy lookup falls back to false for unknown codes", async () => {
  const { shouldSuppress } = await import("../lib/handled-errors");
  assert.equal(shouldSuppress("totally_unknown_code_12345"), false);
});

test("custom_errors.policy.json declares all customer_api_* codes used by the handler", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");

  // dist/test/smoke.test.js -> ../../custom_errors.policy.json from repo root.
  const candidates = [
    path.resolve(__dirname, "..", "..", "custom_errors.policy.json"),
    path.resolve(__dirname, "..", "..", "..", "custom_errors.policy.json")
  ];

  let raw: string | null = null;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      raw = fs.readFileSync(candidate, "utf8");
      break;
    }
  }
  assert.ok(raw, "custom_errors.policy.json not found from dist/test");

  const parsed = JSON.parse(raw) as { errors?: Record<string, unknown> };
  const declared = Object.keys(parsed.errors ?? {});
  const required = [
    "customer_api_unauthorized",
    "customer_api_invalid_token",
    "customer_api_token_not_found",
    "customer_api_token_no_stores",
    "customer_api_device_not_found",
    "customer_api_forbidden_store",
    "customer_api_invalid_query_param"
  ];
  for (const code of required) {
    assert.ok(declared.includes(code), `missing handled-error code in policy: ${code}`);
  }
});
