/** Private S3 PNG history. Canonical owner: printjob-sync; customer-api copies this.
 * One immutable object carries both PNG bytes and its manifest in metadata. No
 * job row is replaced and no additional DynamoDB writer/table is introduced.
 * PUT uses If-None-Match; a lost acknowledgement is recovered by checksum and
 * exact manifest comparison. Reads are proxied after authorization; no public URL.
 * DM_LABEL_PRINTER_IMAGE_BUCKET must be explicitly configured before activation.
 */
import {
  imageKey,
  imageMetadata,
  imagePrefix,
  PrintImageError,
  readImageMetadata,
  validatePng,
  type ImageScope,
  type PrintImageManifest,
} from "../lib/print-image";

type Input = Record<string, unknown>;
type Output = {
  Metadata?: Record<string, string>;
  ContentLength?: number;
  ContentType?: string;
  Body?: { transformToByteArray(): Promise<Uint8Array> };
  Contents?: { Key?: string }[];
  NextContinuationToken?: string;
};
type Command = { input: Input };
type S3Module = { S3Client: new (config: Input) => { send(command: Command): Promise<Output> } } & Record<
  "PutObjectCommand" | "HeadObjectCommand" | "GetObjectCommand" | "ListObjectsV2Command",
  new (input: Input) => Command
>;
let cached: { sdk: S3Module; client: { send(command: Command): Promise<Output> } } | undefined;
function runtime() {
  if (!cached) {
    // AWS SDK v3 is supplied by the managed Node.js 24 runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require("@aws-sdk/client-s3") as S3Module;
    cached = { sdk, client: new sdk.S3Client({}) };
  }
  return cached;
}
const named = (error: unknown, names: string[]): boolean => error instanceof Error && names.includes(error.name);

export class PrintImageStore {
  constructor(private readonly bucket = process.env.DM_LABEL_PRINTER_IMAGE_BUCKET?.trim() ?? "") {}
  private configured(): void {
    if (!this.bucket) throw new PrintImageError("print_images_not_configured", 503);
  }

  async put(scope: ImageScope, manifest: PrintImageManifest, bytes: Buffer): Promise<void> {
    this.configured();
    validatePng(bytes, manifest);
    const current = runtime(),
      Key = imageKey(scope, manifest),
      Metadata = imageMetadata(manifest);
    try {
      await current.client.send(
        new current.sdk.PutObjectCommand({
          Bucket: this.bucket,
          Key,
          Body: bytes,
          ContentType: "image/png",
          CacheControl: "private, no-store",
          ServerSideEncryption: "AES256",
          IfNoneMatch: "*",
          Metadata,
          ChecksumSHA256: Buffer.from(manifest.sha256, "hex").toString("base64"),
        }),
      );
    } catch (error) {
      if (!named(error, ["PreconditionFailed"])) throw error;
      const old = await current.client.send(new current.sdk.HeadObjectCommand({ Bucket: this.bucket, Key }));
      if (
        old.ContentLength !== bytes.length ||
        old.ContentType !== "image/png" ||
        JSON.stringify(readImageMetadata(old.Metadata)) !== JSON.stringify(manifest)
      )
        throw new PrintImageError("print_image_identity_conflict", 409);
    }
  }

  async list(
    scope: ImageScope,
    localJobId: number,
    createdAtUtc: string,
    cursor?: string,
  ): Promise<{ items: PrintImageManifest[]; nextCursor: string | null }> {
    this.configured();
    if (cursor && (cursor.length > 4096 || Array.from(cursor).some(character => character.charCodeAt(0) < 32)))
      throw new PrintImageError("print_image_invalid_cursor", 400);
    const current = runtime(),
      prefix = imagePrefix(scope, localJobId, createdAtUtc);
    const page = await current.client.send(
      new current.sdk.ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 20, ...(cursor ? { ContinuationToken: cursor } : {}) }),
    );
    const items: PrintImageManifest[] = [];
    for (const object of page.Contents ?? []) {
      if (!object.Key?.startsWith(prefix) || !/^[0-9a-f]{64}\.png$/.test(object.Key.slice(prefix.length)))
        throw new Error("Unexpected image key in private prefix");
      try {
        const head = await current.client.send(new current.sdk.HeadObjectCommand({ Bucket: this.bucket, Key: object.Key }));
        const manifest = readImageMetadata(head.Metadata);
        if (imageKey(scope, manifest) !== object.Key || head.ContentLength !== manifest.byteLength || head.ContentType !== "image/png")
          throw new Error("Image metadata mismatch");
        items.push(manifest);
      } catch (error) {
        if (!named(error, ["NotFound", "NoSuchKey"])) throw error;
      } // Expired between list and head.
    }
    return { items, nextCursor: page.NextContinuationToken ?? null };
  }

  async get(
    scope: ImageScope,
    localJobId: number,
    createdAtUtc: string,
    artifactId: string,
  ): Promise<{ manifest: PrintImageManifest; bytes: Buffer }> {
    this.configured();
    if (!/^[0-9a-f]{64}$/.test(artifactId)) throw new PrintImageError("print_image_invalid", 400);
    const current = runtime(),
      Key = imagePrefix(scope, localJobId, createdAtUtc) + artifactId + ".png";
    let result: Output;
    try {
      result = await current.client.send(new current.sdk.GetObjectCommand({ Bucket: this.bucket, Key }));
    } catch (error) {
      if (named(error, ["NoSuchKey", "NotFound"])) throw new PrintImageError("print_image_unavailable", 404);
      throw error;
    }
    const manifest = readImageMetadata(result.Metadata);
    if (imageKey(scope, manifest) !== Key || result.ContentLength !== manifest.byteLength || result.ContentType !== "image/png" || !result.Body)
      throw new Error("Stored image metadata mismatch");
    const bytes = Buffer.from(await result.Body.transformToByteArray());
    validatePng(bytes, manifest);
    return { manifest, bytes };
  }
}
