import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { env } from "../env";
import { logger } from "./logging";

const { AWS_REGION } = env;

// Cache for secrets to avoid repeated calls
const secretCache: Record<string, { value: string; timestamp: number }> = {};
const SECRET_CACHE_TTL = 5 * 60 * 1000; // 5 minute cache

let secretsManagerClient: SecretsManagerClient | null = null;

function getSecretsManagerClient(): SecretsManagerClient {
  if (!secretsManagerClient) {
    logger.debug(
      `Initializing Secrets Manager client in region: ${AWS_REGION}`
    );
    secretsManagerClient = new SecretsManagerClient({
      region: AWS_REGION,
    });
  }
  return secretsManagerClient;
}

/**
 * Get a secret value from AWS Secrets Manager by its name (e.g., lumen/staging/some-secret), with caching.
 * Assumes the secret contains a plain string value.
 * @param secretName The name of the secret to retrieve.
 * @returns The secret string value, or null if not found or an error occurs.
 */
export const getSecret = async (secretName: string): Promise<string | null> => {
  // Check cache first using the name as the key
  const cachedValue = secretCache[secretName];
  if (cachedValue && Date.now() - cachedValue.timestamp < SECRET_CACHE_TTL) {
    logger.debug(`Returning cached secret value for name: ${secretName}`);
    return cachedValue.value;
  }

  logger.debug(`Attempting to fetch secret value for name: ${secretName}`);
  try {
    const client = getSecretsManagerClient();
    // Use SecretId with the name for the command
    const command = new GetSecretValueCommand({ SecretId: secretName });
    const response = await client.send(command);

    const secretString = response.SecretString;

    if (secretString) {
      logger.debug(`Successfully fetched secret for name: ${secretName}`);
      // Cache the result using the name
      secretCache[secretName] = {
        value: secretString,
        timestamp: Date.now(),
      };
      return secretString;
    } else {
      // Handle cases where the secret might be binary or empty, although we expect string
      logger.warn(
        `Secret fetched for name ${secretName}, but SecretString is empty.`
      );
      return null;
    }
  } catch (error: any) {
    // Log specific AWS SDK errors if needed
    logger.error(
      `Error fetching secret ${secretName}: ${error.message || error}`
    );
    // Example: Check for specific errors like ResourceNotFoundException
    if (error.name === "ResourceNotFoundException") {
      logger.error(`Secret name ${secretName} not found.`);
    }
    return null;
  }
};

export const getSecretOrEnvVar = async ({
  secretNameTemplate,
  envVariableName,
  throwOnDevError = true,
  throwOnStagingOrProdError = true,
}: {
  secretNameTemplate: string;
  envVariableName: string;
  throwOnDevError?: boolean;
  throwOnStagingOrProdError?: boolean;
}): Promise<string | null> => {
  if (env.NODE_ENV === "development" || env.NODE_ENV === "test") {
    const envValue = env[envVariableName as keyof typeof env];
    if (!envValue) {
      if (throwOnDevError) {
        throw new Error(`${envVariableName} is required in development`);
      }
      return null;
    }
    return envValue as string;
  }

  const secretName = secretNameTemplate.replace("*", env.NODE_ENV);
  const secret = await getSecret(secretName);
  if (!secret) {
    if (throwOnStagingOrProdError) {
      throw new Error(`${secretName} not found in Secrets Manager`);
    }
    return null;
  }
  return secret;
};
