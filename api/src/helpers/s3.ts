import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env";

// Environment variable validation (optional but recommended)
const {
  STORAGE_REGION: storageRegion,
  STORAGE_ENDPOINT: storageEndpoint,
  STORAGE_ACCESS_KEY_ID: storageAccessKeyId,
  STORAGE_SECRET_ACCESS_KEY: storageSecretAccessKey,
  NODE_ENV: nodeEnv,
  INVOICE_BUCKET: storageBucket,
} = env;

if (!storageBucket) {
  throw new Error("INVOICE_BUCKET is required");
}

// Memoized S3 client instance
let s3Client: S3Client | null = null;

/**
 * Get a configured S3 client instance based on the environment.
 * Uses MinIO settings for development, AWS SDK defaults for staging/production.
 */
export function getS3Client(): S3Client {
  if (s3Client) {
    return s3Client;
  }

  console.debug(`Initializing S3 client for environment: ${nodeEnv}`);

  if (nodeEnv === "development" || nodeEnv === "test") {
    const credentials = {
      accessKeyId: storageAccessKeyId,
      secretAccessKey: storageSecretAccessKey,
    };

    console.debug(`Using MinIO endpoint: ${storageEndpoint}`);
    s3Client = new S3Client({
      region: storageRegion, // MinIO doesn't strictly use region but SDK might require it
      endpoint: storageEndpoint,
      credentials,
      forcePathStyle: true, // Required for MinIO
    });
  } else {
    // AWS S3 configuration for staging/production
    // Rely on default AWS SDK credential provider chain (IAM role, etc.)
    // Do NOT check for explicit env vars or pass credentials here.
    console.debug(`Using AWS S3 region: ${storageRegion}`);
    s3Client = new S3Client({
      region: storageRegion,
      // No explicit credentials - SDK will use IAM role or other providers
      // forcePathStyle: false (default for AWS)
    });
  }

  return s3Client;
}

/**
 * Generate a presigned URL for accessing an S3 object.
 * This URL will expire after the specified expiration time.
 *
 * @param key The object key in the bucket
 * @param expiresIn Expiration time in seconds (default: 15 minutes)
 * @returns A promise that resolves to the presigned URL
 */
export async function generatePresignedUrl(
  key: string,
  expiresIn: number = 900 // 15 minutes in seconds
): Promise<string> {
  const client = getS3Client();
  const bucket = storageBucket;
  try {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    // Generate the presigned URL
    const signedUrl = await getSignedUrl(client, command, {
      expiresIn,
    });

    console.debug(`Generated presigned URL for ${key} in ${bucket}`);
    return signedUrl;
  } catch (error) {
    console.error(`Failed to generate presigned URL for ${key}:`, error);
    throw new Error(
      `Failed to generate presigned URL: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Upload a file to S3.
 *
 * @param key The object key in the bucket
 * @param body The file content as a Buffer
 * @param contentType The MIME type of the file (e.g., 'application/pdf')
 */
export async function uploadFile(
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const client = getS3Client();
  const bucket = storageBucket;
  console.info(`Uploading file to S3`, { bucket, key, contentType });

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ACL: "private", // Ensure files are private by default
      })
    );
    console.info(`Successfully uploaded file`, { bucket, key });
    const url = getObjectStorageUrl(key);
    console.debug(`Successfully uploaded ${key} to ${bucket}. URL: ${url}`);
  } catch (error) {
    console.error(
      `Failed to upload file to S3: ${error instanceof Error ? error.message : String(error)}`,
      {
        bucket,
        key,
      }
    );
    throw new Error(
      `S3 upload failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Constructs the storage location URL for a file stored in S3/MinIO.
 * This URL points to the object's location but is NOT publicly accessible
 * if the object's ACL is private. Access typically requires a presigned URL.
 * For development, constructs a path-style URL using the MinIO endpoint.
 * For staging/production, constructs the standard AWS S3 URL.
 *
 * @param key The object key in the bucket
 * @returns The object's storage location URL string
 */
export function getObjectStorageUrl(key: string): string {
  const bucket = storageBucket;
  // Ensure key doesn't have a leading slash for consistency
  const cleanKey = key.startsWith("/") ? key.slice(1) : key;

  if (nodeEnv === "development" || nodeEnv === "test") {
    if (!storageEndpoint) {
      console.error("STORAGE_ENDPOINT is required to build URL in development");
      throw new Error(
        "STORAGE_ENDPOINT is required to build URL in development"
      );
    }
    // Ensure endpoint doesn't have a trailing slash
    const cleanEndpoint = storageEndpoint.endsWith("/")
      ? storageEndpoint.slice(0, -1)
      : storageEndpoint;
    const url = `${cleanEndpoint}/${bucket}/${cleanKey}`;
    console.debug(`Constructed MinIO URL: ${url}`);
    return url;
  } else {
    // Staging/Production: Construct standard AWS S3 URL
    // Example: https://invoices-staging.s3.us-east-1.amazonaws.com/invoice-123.pdf
    const url = `https://${bucket}.s3.${storageRegion}.amazonaws.com/${cleanKey}`;
    console.debug(`Constructed AWS S3 URL: ${url}`);
    return url;
  }
}

/**
 * Check if a file exists in S3.
 * @param key The object key
 * @returns Promise<boolean> True if the file exists, false otherwise
 */
export async function fileExists(key: string): Promise<boolean> {
  const client = getS3Client();
  const bucket = storageBucket;

  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    return true;
  } catch (error) {
    // If the error is because the object doesn't exist, return false
    // Otherwise, log the error but still return false
    if (
      (error as any).name === "NotFound" ||
      (error as any).code === "NotFound"
    ) {
      return false;
    }
    console.error(
      `Error checking if file exists: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Delete a file from S3.
 * @param key The object key to delete
 */
export async function deleteFile(key: string): Promise<void> {
  const client = getS3Client();
  const bucket = storageBucket;
  console.info(`Deleting file from S3`, { bucket, key });

  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    console.info(`Successfully deleted file`, { bucket, key });
  } catch (error) {
    console.error(
      `Failed to delete file from S3: ${error instanceof Error ? error.message : String(error)}`,
      {
        bucket,
        key,
      }
    );
    throw new Error(
      `S3 delete failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Extract bucket and key from an S3 URL.
 * This is useful for parsing presigned URLs or direct S3 URLs.
 * Handles both path-style and virtual-hosted style URLs.
 *
 * @param url The S3 URL to parse
 * @returns Object with bucket and key, or null if parsing fails
 */
export function extractBucketAndKeyFromUrl(
  url: string
): { bucket: string; key: string } | null {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;
    const pathname = parsedUrl.pathname.startsWith("/")
      ? parsedUrl.pathname.substring(1)
      : parsedUrl.pathname; // Remove leading slash

    let bucket: string | undefined;
    let key: string | undefined;

    // Check for MinIO path-style URL (e.g., http://localhost:9000/bucket-name/key)
    // Assumes bucket name is the first segment of the path
    const pathSegments = pathname.split("/");
    // Use storageEndpoint for more reliable MinIO check
    const isMinioLike =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      (storageEndpoint && new URL(storageEndpoint).hostname === hostname);

    if (pathSegments.length > 1 && isMinioLike) {
      // Heuristic: If hostname matches common local dev patterns or configured endpoint, assume path-style
      bucket = pathSegments[0];
      key = pathSegments.slice(1).join("/");
    } else {
      // Assume standard AWS virtual-hosted style (e.g., https://bucket-name.s3...)
      // Or AWS path-style if bucket name is not in hostname (less common now)
      const s3HostnameRegex = /^(.*?)\.s3(?:[-.][a-z0-9-]+)*\.amazonaws\.com$/;
      const match = hostname.match(s3HostnameRegex);

      if (match && match[1]) {
        // Virtual-hosted style: bucket is part of the hostname
        bucket = match[1];
        key = pathname;
      } else if (pathname.includes("/")) {
        // Attempt to parse as path-style (e.g., s3.amazonaws.com/bucket/key)
        // This is less common for presigned URLs but included for robustness
        bucket = pathSegments[0];
        key = pathSegments.slice(1).join("/");
      }
    }

    if (bucket && key !== undefined) {
      // Key can be an empty string for bucket root, but must be defined
      return { bucket, key };
    }

    console.warn(`Could not reliably extract bucket and key from URL: ${url}`);
    return null;
  } catch (error) {
    console.error(`Error parsing S3 URL ${url}:`, error);
    return null;
  }
}
