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
    "customers/portal/overview",
    "customers/portal/create-setup-intent",
    "customers/portal/set-subscription-payment-method",
    "customers/portal/payment-methods/{id}",
    "invoices/{id}/pdf",
    // Credit top-up endpoints
    "credits/available-topups",
    "credits/topup",
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

  const pathToRegex = (pattern: string): RegExp => {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = "^" + escaped.replace(/\\\{[^/}]+\\\}/g, "[^/]+") + "$";
    return new RegExp(re);
  };

  const isAllowed = SUPPORTED_PATHS.some((p) =>
    pathToRegex(p).test(lumenBackendPath)
  );
  if (!isAllowed) {
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

  let body: string | undefined = undefined;
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    try {
      const json = await request.json();
      // Security: if externalCustomerId is present in body, ensure it matches userId
      if (
        json &&
        typeof json.externalCustomerId === "string" &&
        json.externalCustomerId !== userId
      ) {
        return { error: "Forbidden" };
      }
      body = JSON.stringify({ ...json });
    } catch {
      body = undefined;
    }
  }

  const response = await fetch(path, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    method,
    body,
  });

  if (!response.ok) {
    console.error("lumenNextHandler: Failed to fetch Lumen API", response);
  }

  return await response.json();
};
