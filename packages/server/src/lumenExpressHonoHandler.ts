type SupportedPath =
  | "customers/subscription-status"
  | "entitlements/{customerId}"
  | "customers/portal/overview"
  | "customers/portal/create-setup-intent"
  | "customers/portal/set-subscription-payment-method"
  | "customers/portal/payment-methods/{id}"
  | "invoices/{id}/pdf";

const DEFAULT_SUPPORTED_PATHS: SupportedPath[] = [
  "customers/subscription-status",
  "entitlements/{customerId}",
  "customers/portal/overview",
  "customers/portal/create-setup-intent",
  "customers/portal/set-subscription-payment-method",
  "customers/portal/payment-methods/{id}",
  "invoices/{id}/pdf",
];

interface CommonOptions {
  apiKey?: string;
  apiUrl?: string;
  supportedPaths?: string[];
}

interface ExpressOptions extends CommonOptions {
  getUserId: (req: any) => string | undefined;
  mountPath?: string; // default: "/api/lumen"
}

export const lumenExpressHandler = (options: ExpressOptions) => {
  const {
    getUserId,
    apiKey,
    apiUrl,
    supportedPaths = DEFAULT_SUPPORTED_PATHS,
    mountPath = "/api/lumen",
  } = options;

  const pathToRegex = (pattern: string): RegExp => {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = "^" + escaped.replace(/\\\{[^/}]+\\\}/g, "[^/]+") + "$";
    return new RegExp(re);
  };

  const isAllowed = (backendPath: string): boolean => {
    return supportedPaths.some((p) => pathToRegex(p).test(backendPath));
  };

  return async (req: any, res: any) => {
    try {
      const API_KEY = apiKey || process.env.LUMEN_API_KEY;
      if (!API_KEY) {
        return res
          .status(500)
          .json({ error: "LUMEN_API_KEY is not set in environment" });
      }

      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Derive suffix after mountPath robustly
      let suffix = "";
      if (req.params && typeof req.params[0] === "string") {
        suffix = "/" + req.params[0];
      } else if (req.originalUrl && typeof req.originalUrl === "string") {
        suffix = req.originalUrl.startsWith(mountPath)
          ? req.originalUrl.slice(mountPath.length)
          : req.originalUrl;
      } else {
        suffix = req.path || "";
      }
      const lumenBackendPath = decodeURIComponent(suffix.replace(/^\//, ""));

      if (!isAllowed(lumenBackendPath)) {
        return res.status(404).json({ error: "Unsupported path" });
      }

      const API_URL =
        apiUrl || process.env.LUMEN_API_URL || "https://api.getlumen.dev";
      let path = API_URL.replace("/v1", "") + "/v1/" + lumenBackendPath;

      const urlParams = new URLSearchParams();

      // Append original query params
      const query = req.query || {};
      for (const key of Object.keys(query)) {
        const value = (query as Record<string, unknown>)[key];
        if (Array.isArray(value)) {
          value.forEach((v) => urlParams.append(key, String(v)));
        } else if (value != null) {
          urlParams.append(key, String(value));
        }
      }

      // Security: externalCustomerId, if present, must match userId
      const externalCustomerId = (query as Record<string, unknown>)[
        "externalCustomerId"
      ];
      if (
        typeof externalCustomerId === "string" &&
        externalCustomerId !== userId
      ) {
        return res.status(403).json({ error: "Forbidden" });
      }

      if (path.includes("{customerId}")) {
        path = path.replace("{customerId}", userId);
        urlParams.append("isExtCustId", "true");
      }

      const queryString = urlParams.toString();
      if (queryString) {
        path = path + "?" + queryString;
      }

      const method = (req.method || "GET").toUpperCase();
      // Assume body has been parsed by JSON middleware when applicable
      const body =
        method === "GET" || method === "HEAD"
          ? undefined
          : req.body
            ? JSON.stringify({ ...req.body })
            : undefined;

      // Security: for POST/PUT/PATCH with externalCustomerId in body, validate it
      try {
        if (body) {
          const parsed =
            typeof req.body === "object" ? req.body : JSON.parse(body);
          const extId = parsed?.externalCustomerId as string | undefined;
          if (extId && extId !== userId) {
            return res.status(403).json({ error: "Forbidden" });
          }
        }
      } catch {
        // ignore body parse errors; upstream will handle invalid JSON
      }

      const response = await fetch(path, {
        method,
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body,
      });

      let data: any = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      return res.status(response.status).json(data);
    } catch (error: any) {
      return res
        .status(500)
        .json({ error: error?.message || "Internal Error" });
    }
  };
};

interface HonoOptions extends CommonOptions {
  getUserId: (c: any) => string | undefined;
  mountPath?: string; // default: "/api/lumen"
}

export const lumenHonoHandler = (options: HonoOptions) => {
  const {
    getUserId,
    apiKey,
    apiUrl,
    supportedPaths = DEFAULT_SUPPORTED_PATHS,
    mountPath = "/api/lumen",
  } = options;

  const pathToRegex = (pattern: string): RegExp => {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = "^" + escaped.replace(/\\\{[^/}]+\\\}/g, "[^/]+") + "$";
    return new RegExp(re);
  };

  const isAllowed = (backendPath: string): boolean => {
    return supportedPaths.some((p) => pathToRegex(p).test(backendPath));
  };

  return async (c: any) => {
    try {
      const API_KEY = apiKey || process.env.LUMEN_API_KEY;
      if (!API_KEY) {
        return c.json(
          { error: "LUMEN_API_KEY is not set in environment" },
          500
        );
      }

      const userId = getUserId(c);
      if (!userId) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      // Hono path includes the mount path; strip it
      const fullPath: string = c.req.path || "";
      const suffix = fullPath.startsWith(mountPath)
        ? fullPath.slice(mountPath.length)
        : fullPath;
      const lumenBackendPath = decodeURIComponent(suffix.replace(/^\//, ""));

      if (!isAllowed(lumenBackendPath)) {
        return c.json({ error: "Unsupported path" }, 404);
      }

      const API_URL =
        apiUrl || process.env.LUMEN_API_URL || "https://api.getlumen.dev";
      let path = API_URL.replace("/v1", "") + "/v1/" + lumenBackendPath;

      const urlParams = new URLSearchParams();
      // Copy original query params
      const url = new URL(c.req.url);
      url.searchParams.forEach((value, key) => urlParams.append(key, value));

      // Security: externalCustomerId must match
      const extId = url.searchParams.get("externalCustomerId");
      if (extId && extId !== userId) {
        return c.json({ error: "Forbidden" }, 403);
      }

      if (path.includes("{customerId}")) {
        path = path.replace("{customerId}", userId);
        urlParams.append("isExtCustId", "true");
      }

      const queryString = urlParams.toString();
      if (queryString) {
        path = path + "?" + queryString;
      }

      const method = (c.req.method || "GET").toUpperCase();
      let body: string | undefined = undefined;
      let parsedBody: any = undefined;
      if (method !== "GET" && method !== "HEAD") {
        try {
          parsedBody = await c.req.json();
          body = JSON.stringify({ ...parsedBody });
        } catch {
          body = undefined;
        }
      }

      // Security: for POST/PUT/PATCH with externalCustomerId in body, validate it
      if (parsedBody && typeof parsedBody.externalCustomerId === "string") {
        if (parsedBody.externalCustomerId !== userId) {
          return c.json({ error: "Forbidden" }, 403);
        }
      }

      const response = await fetch(path, {
        method,
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body,
      });

      let data: any = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      return c.json(data ?? {}, response.status);
    } catch (error: any) {
      return c.json({ error: error?.message || "Internal Error" }, 500);
    }
  };
};
