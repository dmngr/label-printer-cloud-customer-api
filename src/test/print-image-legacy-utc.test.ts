import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { readPrintImages, type ImageJob } from "../lib/print-image-routes";
import { imageKey, imageMetadata, imagePrefix, parseImageManifest } from "../lib/print-image";
import { PrintImageStore } from "../storage/print-image-store";
import type { DeviceRecord } from "../types";

const manifest = parseImageManifest(JSON.parse(readFileSync("src/test/fixtures/print-image-windows.json", "utf8")));
const bytes = readFileSync("src/test/fixtures/print-image-windows.png");
const scope = { group: "group-a", storeCode: "store-a", installationId: "install-a", deviceCode: "device-a" };
const device: DeviceRecord = {
  ...scope,
  storeId: scope.group,
  hostName: null,
  printers: null,
  printersReportedAtUtc: null,
  deviceName: "fixture",
  appVersion: "fixture",
  lastSeenAtUtc: "",
  pendingCommands: 0,
  failedJobs: 0,
};
const job: ImageJob = {
  deviceCode: scope.deviceCode,
  storeCode: scope.storeCode,
  localJobId: manifest.localJobId,
  createdAtUtc: manifest.jobCreatedAtUtc.slice(0, -1),
};
const key = imageKey(scope, manifest);
let expectedPrefix = imagePrefix(scope, job.localJobId, manifest.jobCreatedAtUtc);
let missing = false,
  calls = 0;
const sdk: Record<string, unknown> = {
  S3Client: class {
    async send(command: { kind: string; input: Record<string, unknown> }) {
      calls++;
      if (command.kind === "ListObjectsV2Command") {
        assert.equal(command.input.Prefix, expectedPrefix);
        return { Contents: missing ? [] : [{ Key: key }] };
      }
      assert.equal(command.input.Key, key);
      if (missing) throw Object.assign(new Error("gone"), { name: "NoSuchKey" });
      return {
        ContentType: "image/png",
        ContentLength: bytes.length,
        Metadata: imageMetadata(manifest),
        Body: { transformToByteArray: async () => bytes },
      };
    }
  },
};
for (const kind of ["ListObjectsV2Command", "HeadObjectCommand", "GetObjectCommand"])
  sdk[kind] = class {
    kind = kind;
    constructor(public input: Record<string, unknown>) {}
  };
const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
const original = loader._load;
loader._load = function (name, ...args) {
  return name === "@aws-sdk/client-s3" ? sdk : original.call(this, name, ...args);
};
const oldTimezone = process.env.TZ;
process.env.TZ = "Pacific/Honolulu";
after(() => {
  loader._load = original;
  if (oldTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = oldTimezone;
});
const store = new PrintImageStore("isolated-private-bucket");

test("stored UTC without Z lists and downloads the original object in a non-UTC timezone", async () => {
  assert.notEqual(new Date(job.createdAtUtc).getTime(), new Date(manifest.jobCreatedAtUtc).getTime());
  const listed = await readPrintImages(device, job, undefined, undefined, store);
  assert.equal(listed.statusCode, 200);
  assert.ok(listed.body);
  assert.deepEqual(JSON.parse(listed.body).items, [manifest]);
  const downloaded = await readPrintImages(device, job, manifest.artifactId, undefined, store);
  assert.equal(downloaded.statusCode, 200);
  assert.ok(downloaded.body);
  assert.deepEqual(Buffer.from(downloaded.body, "base64"), bytes);
  assert.equal(job.createdAtUtc, manifest.jobCreatedAtUtc.slice(0, -1));
});

test("already qualified UTC keeps the same image identity", async () => {
  const result = await readPrintImages(device, { ...job, createdAtUtc: manifest.jobCreatedAtUtc }, undefined, undefined, store);
  assert.ok(result.body);
  assert.deepEqual(JSON.parse(result.body).items, [manifest]);
});

test("observed seven-digit stored UTC yields unavailable for a historical job with no image", async () => {
  const timestamp = "2026-10-20T08:49:51.0438102";
  expectedPrefix = imagePrefix(scope, 128, timestamp + "Z");
  missing = true;
  try {
    const result = await readPrintImages(device, { ...job, localJobId: 128, createdAtUtc: timestamp }, undefined, undefined, store);
    assert.equal(result.statusCode, 200);
    assert.ok(result.body);
    assert.deepEqual(JSON.parse(result.body), { items: [], nextCursor: null, state: "unavailable" });
  } finally {
    missing = false;
    expectedPrefix = imagePrefix(scope, job.localJobId, manifest.jobCreatedAtUtc);
  }
});

test("missing download remains 404 after legacy UTC normalization", async () => {
  missing = true;
  try {
    await assert.rejects(readPrintImages(device, job, manifest.artifactId, undefined, store), { code: "print_image_unavailable", status: 404 });
  } finally {
    missing = false;
  }
});

for (const timestamp of ["2026-02-30T08:49:51", "2026-10-20T08:49:51+03:00", "2026-10-20", "2026-10-20T08:49:51.12345678", ""])
  test("malformed stored timestamp stays rejected before S3: " + JSON.stringify(timestamp), async () => {
    const before = calls;
    await assert.rejects(readPrintImages(device, { ...job, createdAtUtc: timestamp }, undefined, undefined, store), {
      code: "print_image_invalid",
      status: 400,
    });
    assert.equal(calls, before);
  });

test("legacy compatibility does not weaken foreign device or store guards", async () => {
  const before = calls;
  for (const foreign of [
    { ...job, deviceCode: "other" },
    { ...job, storeCode: "other" },
  ])
    await assert.rejects(readPrintImages(device, foreign, undefined, undefined, store), { code: "print_image_job_not_found", status: 404 });
  assert.equal(calls, before);
});

test("upload manifests still require an explicit UTC zone", () => {
  assert.throws(() => parseImageManifest({ ...manifest, jobCreatedAtUtc: job.createdAtUtc }), { code: "print_image_invalid" });
});
