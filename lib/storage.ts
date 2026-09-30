import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Permanent asset storage on the Railway bucket (S3-compatible, private).
 * Server only. Files are streamed from provider URLs straight into the bucket —
 * never held whole in memory — and served back through short-lived presigned URLs.
 *
 * Env (set on Railway as references to the `cineforge-assets` bucket):
 *   S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION, S3_ENDPOINT
 */

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB safety cap
/** How long a presigned link works. Pages re-fetch links, so this can stay short. */
export const PRESIGN_TTL_SECONDS = 60 * 60;

interface StorageConfig {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  endpoint: string;
}

function readConfig(): StorageConfig | null {
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const region = process.env.S3_REGION?.trim() || "auto";
  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) return null;
  return { bucket, accessKeyId, secretAccessKey, region, endpoint };
}

export function isStorageConfigured(): boolean {
  return readConfig() !== null;
}

let cached: { key: string; client: S3Client; bucket: string } | null = null;

function getClient(): { client: S3Client; bucket: string } {
  const config = readConfig();
  if (!config) throw new Error("Asset storage is not configured (S3_* variables).");
  const cacheKey = `${config.endpoint}|${config.bucket}|${config.accessKeyId}`;
  if (!cached || cached.key !== cacheKey) {
    cached = {
      key: cacheKey,
      bucket: config.bucket,
      client: new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        // Railway buckets use virtual-hosted-style URLs; S3_FORCE_PATH_STYLE=true
        // is only for older buckets or local S3 test servers.
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      }),
    };
  }
  return { client: cached.client, bucket: cached.bucket };
}

export interface ArchivedObject {
  key: string;
  contentType: string;
  byteSize: number | null;
}

/**
 * Streams a remote file (Fal, Magnific, …) into the bucket under `key`.
 * Only https sources from the caller's own pipeline are passed here.
 */
export async function archiveFromUrl(
  sourceUrl: string,
  key: string,
  fallbackContentType: string,
): Promise<ArchivedObject> {
  const url = new URL(sourceUrl);
  if (url.protocol !== "https:") throw new Error("Only https sources can be archived.");

  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed with HTTP ${res.status}.`);
  }

  const lengthHeader = res.headers.get("content-length");
  const declaredSize = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  if (declaredSize !== null && declaredSize > MAX_ARCHIVE_BYTES) {
    throw new Error(`File is larger than the ${MAX_ARCHIVE_BYTES} byte archive limit.`);
  }

  const contentType =
    res.headers.get("content-type")?.split(";")[0]?.trim() || fallbackContentType;

  const { client, bucket } = getClient();
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
      ContentType: contentType,
    },
    queueSize: 2,
    partSize: 8 * 1024 * 1024,
  });

  let uploaded = 0;
  upload.on("httpUploadProgress", (p) => {
    if (typeof p.loaded === "number") uploaded = p.loaded;
  });
  await upload.done();

  return { key, contentType, byteSize: declaredSize ?? (uploaded || null) };
}

/** Short-lived link to a private object. `downloadName` forces a file download. */
export async function presignGet(key: string, downloadName?: string): Promise<string> {
  const { client, bucket } = getClient();
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(downloadName
      ? { ResponseContentDisposition: `attachment; filename="${downloadName.replace(/"/g, "")}"` }
      : {}),
  });
  return getSignedUrl(client, command, { expiresIn: PRESIGN_TTL_SECONDS });
}

export async function deleteObject(key: string): Promise<void> {
  const { client, bucket } = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
