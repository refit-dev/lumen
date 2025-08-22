export const lumenNextHandler = async ({
  request,
  userId,
  apiKey,
  apiUrl,
}: {
  request: any;
  userId: string;
  apiKey?: string;
  apiUrl?: string;
}) => {
  const SUPPORTED_PATHS = [
    "customers/subscription-status",
    "entitlements/{customerId}",
  ];
  const API_KEY = apiKey || process.env.LUMEN_API_KEY;
  if (!API_KEY) {
    throw new Error("LUMEN_API_KEY is not set in .env file");
  }

  const query = request.nextUrl.searchParams;
  const externalCustomerId = query.get("externalCustomerId");
  if (externalCustomerId && externalCustomerId !== userId) {
    return { error: "Forbidden" };
  }

  const { pathname } = request.nextUrl;
  const lumenBackendPath = decodeURIComponent(
    pathname.split("/").slice(3).join("/")
  );

  if (!SUPPORTED_PATHS.includes(lumenBackendPath)) {
    return { error: "Unsupported path" };
  }

  const API_URL =
    apiUrl || process.env.LUMEN_API_URL || "https://api.getlumen.dev";

  let path = API_URL.replace("/v1", "") + "/v1/" + lumenBackendPath;

  const urlParams = new URLSearchParams();

  query.forEach((value: string, key: string) => {
    urlParams.append(key, value);
  });

  if (path.includes("{customerId}")) {
    path = path.replace("{customerId}", userId);
    urlParams.append("isExtCustId", "true");
  }

  const queryString = urlParams.toString();
  if (queryString) {
    path = path + "?" + queryString;
  }

  const response = await fetch(path, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    method: request.method,
    body: request.body ? JSON.stringify({ ...request.body }) : undefined,
  });

  return await response.json();
};
