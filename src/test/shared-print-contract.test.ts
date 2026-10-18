import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "./fixtures/shared-print-v1.json";
import { parseSharedPrintRequest, templateFingerprint } from "../lib/shared-print-request";

// Byte-identical fixture owned by label-printers-panel/tests/LabelPrinter.Tests/Fixtures.
test("shared fixture pins Windows/cloud fingerprint, Unicode and case normalization", () => {
  assert.equal(templateFingerprint(fixture.width, fixture.height, fixture.layoutJson), fixture.templateFingerprint);
  const value = parseSharedPrintRequest(fixture.request);
  assert.equal(value.templateCode, fixture.normalizedTemplateCode);
  assert.equal(value.fields.header, "Τίτλος");
  assert.equal(value.fields.recordedtime, "14:32");
  for (const expiresAtUtc of ["0000-01-01T00:00:00Z", "2026-02-30T00:00:00Z", "2026-10-18T10:00:00+00:00"])
    assert.throws(() => parseSharedPrintRequest({ ...fixture.request, expiresAtUtc }));
  const fields = Object.fromEntries(Array.from({ length: 64 }, (_, i) => ["field" + i, "x".repeat(4096)]));
  assert.throws(() => parseSharedPrintRequest({ ...fixture.request, fields }));
});
