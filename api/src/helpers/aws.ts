import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { env } from "../env";
const { SSM_PATH, AWS_REGION } = env;

// Cache for SSM parameters to avoid repeated calls
const ssmCache: Record<string, { value: string; timestamp: number }> = {};
const SSM_CACHE_TTL = 5 * 60 * 1000; // 5 minute cache

/**
 * Get a parameter from SSM Parameter Store with caching
 * @param paramName The name of the parameter to get (will be prefixed with SSM_PATH if not starting with /)
 * @returns The parameter value, or null if not found
 */
export const getSSMParameter = async (
  paramName: string
): Promise<string | null> => {
  // Normalize parameter name
  const normalizedParamName = paramName.startsWith("/")
    ? paramName
    : `${SSM_PATH || ""}/${paramName}`;

  // Check cache first
  const cachedValue = ssmCache[normalizedParamName];
  if (cachedValue && Date.now() - cachedValue.timestamp < SSM_CACHE_TTL) {
    return cachedValue.value;
  }

  try {
    // Initialize SSM client
    const ssmClient = new SSMClient({
      region: AWS_REGION,
    });

    // Get parameter from SSM
    const command = new GetParameterCommand({
      Name: normalizedParamName,
      WithDecryption: true,
    });

    const response = await ssmClient.send(command);
    const value = response.Parameter?.Value || null;

    if (value) {
      // Cache the result
      ssmCache[normalizedParamName] = {
        value,
        timestamp: Date.now(),
      };
    }

    return value;
  } catch (error) {
    console.error(
      `Error fetching SSM parameter ${normalizedParamName}:`,
      error
    );
    return null;
  }
};
