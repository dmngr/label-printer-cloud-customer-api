import assert from "node:assert/strict";
import test from "node:test";
import { bindTemplateInputs, readTemplateInputs } from "../lib/template-inputs";

test("explicit fields enforce required/default/type rules and normalize fields aliases", () => {
  const inputs = readTemplateInputs(
    JSON.stringify({
      inputs: [
        { key: "fields.title", label: "Τίτλος", required: true },
        { key: "route", defaultValue: "R-7" },
        { key: "weight", type: "number" },
        { key: "expiry", type: "date" },
      ],
    }),
  );
  assert.deepEqual(
    { ...bindTemplateInputs(inputs, { "FIELDS.Title": "Hello", weight: "1.25", expiry: "2028-02-29" }) },
    { title: "Hello", route: "R-7", weight: "1.25", expiry: "2028-02-29" },
  );
  assert.throws(() => bindTemplateInputs(inputs, {}), /Τίτλος/);
  assert.throws(() => bindTemplateInputs(inputs, { title: "x", weight: "Infinity" }));
  assert.throws(() => bindTemplateInputs(inputs, { title: "x", expiry: "2027-02-29" }));
  assert.throws(() => bindTemplateInputs(inputs, { title: "x", expiry: "0000-01-01" }));
  assert.throws(() => readTemplateInputs('{"inputs":[{"key":"date"}]}'));
  assert.throws(() => readTemplateInputs('{"inputs":[{"key":"title"},{"key":"fields.TITLE"}]}'));
});

test("legacy layouts infer bindings; explicit empty schema and constants produce none", () => {
  assert.deepEqual(readTemplateInputs('{"inputs":[]}'), []);
  const inferred = readTemplateInputs(
    '{"elements":[{"type":"text","field":"title"},{"type":"barcode","field":"code"},{"type":"text","field":"date"},{"type":"text","field":"ignored","text":"constant"}]}',
  );
  assert.deepEqual(
    inferred.map(field => [field.key, field.required]),
    [
      ["title", false],
      ["code", true],
    ],
  );
  assert.equal(readTemplateInputs("{}")[0].key, "productName");
  assert.throws(() => bindTemplateInputs([], JSON.parse('{"__proto__":"x"}')));
});
