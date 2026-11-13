/** Customer history image reads: the parent handler authenticates the device;
 * this layer additionally binds the selected job to that device and store.
 * Old/missing images remain unavailable; no historical re-render is performed.
 */
import type { DeviceRecord } from "../types";
import { PrintImageError, type ImageScope } from "./print-image";
import type { PrintImageStore } from "../storage/print-image-store";
import type { LambdaResponse } from "./http-results";
import { jsonResponse } from "./http-results";

export interface ImageJob {
  deviceCode: string;
  storeCode: string;
  localJobId: number;
  createdAtUtc: string;
}
export function parsePrintImageRoute(path: string): { deviceCode: string; jobId: number; artifactId?: string } | null {
  const match = /^\/api\/v1\/me\/devices\/([^/]+)\/jobs\/([1-9]\d*)\/images(?:\/([0-9a-f]{64}))?$/.exec(path);
  if (!match) return null;
  let deviceCode: string;
  try {
    deviceCode = decodeURIComponent(match[1]);
  } catch {
    throw new PrintImageError("print_image_invalid", 400);
  }
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(deviceCode) || !Number.isSafeInteger(Number(match[2]))) throw new PrintImageError("print_image_invalid", 400);
  return { deviceCode, jobId: Number(match[2]), artifactId: match[3] };
}

export async function readPrintImages(
  device: DeviceRecord,
  job: ImageJob | null,
  artifactId: string | undefined,
  cursor: string | undefined,
  store: Pick<PrintImageStore, "list" | "get">,
): Promise<LambdaResponse> {
  if (!job || job.deviceCode !== device.deviceCode || job.storeCode !== device.storeCode) throw new PrintImageError("print_image_job_not_found", 404);
  if (!device.installationId || !device.storeId || !device.storeCode) throw new PrintImageError("print_image_unavailable", 404);
  const scope: ImageScope = {
    group: device.storeId,
    storeCode: device.storeCode,
    installationId: device.installationId,
    deviceCode: device.deviceCode,
  };
  if (!artifactId) {
    const result = await store.list(scope, job.localJobId, job.createdAtUtc, cursor);
    const response = jsonResponse(200, { ...result, state: result.items.length ? "available" : "unavailable" });
    response.headers = { ...response.headers, "Cache-Control": "private, no-store" };
    return response;
  }
  const result = await store.get(scope, job.localJobId, job.createdAtUtc, artifactId);
  return {
    statusCode: 200,
    isBase64Encoded: true,
    body: result.bytes.toString("base64"),
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": 'inline; filename="label-' + artifactId.slice(0, 12) + '.png"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization,Content-Type",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
    },
  };
}
