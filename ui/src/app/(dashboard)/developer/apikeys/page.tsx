"use client";
import { apiClient } from "@/lib/hono-client";
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";

import { Trash2 } from "lucide-react";
import { CodeBlock } from "@/components/ui/codeblock";
import { IdBadge } from "@/components/ui/id-badge";
import { PageContent } from "@/components/dashboard/page-content";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";

export interface ApiKeyBase {
  id: string;
  name: string;
  keyType: "secret" | "publishable";
  environment: "live" | "test";
  createdAt: string;
  revokedAt?: string | null;
  merchantId: string;
}

export interface DisplayApiKey extends ApiKeyBase {
  keyValue: string;
}

export interface CreatedApiKey extends ApiKeyBase {
  keyValue: string;
  prefix: string;
  permissions: ("admin" | "public")[];
}

export interface PublishableKey {
  id: string;
  name: string;
  keyType: "secret" | "publishable";
  environment: "live" | "test";
  keyValue: string;
  prefix: string;
  createdAt: string;
}

export interface CreateApiKeyPayload {
  name: string;
  keyType: "secret" | "publishable";
  environment: "live" | "test";
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<DisplayApiKey[]>([]);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<CreatedApiKey | null>(
    null
  );
  const [publishableKey, setPublishableKey] = useState<PublishableKey | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingKeys, setIsLoadingKeys] = useState(true);
  const [isLoadingPublishable, setIsLoadingPublishable] = useState(false);
  const [isRevoking, setIsRevoking] = useState<string | null>(null);

  const fetchApiKeys = async () => {
    setIsLoadingKeys(true);
    try {
      const response = await apiClient["api-keys"].$get();
      if (!response.ok) {
        throw new Error("Failed to fetch API keys");
      }
      const result = await response.json();
      setKeys(result.data || []);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load API keys.";
      setError(message);
      setKeys([]);
    } finally {
      setIsLoadingKeys(false);
    }
  };

  const fetchPublishableKey = async (environment: "live" | "test" = "live") => {
    setIsLoadingPublishable(true);
    setError(null);
    try {
      const response = await apiClient["api-keys"]["publishable"].$get({
        query: { environment },
      });
      if (!response.ok) {
        if (response.status === 404) {
          setPublishableKey(null);
          return;
        }
        throw new Error("Failed to fetch publishable key");
      }
      const result = await response.json();
      setPublishableKey(result.data || null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load publishable key.";
      setError(message);
    } finally {
      setIsLoadingPublishable(false);
    }
  };

  useEffect(() => {
    fetchApiKeys();
    fetchPublishableKey();
  }, []);

  const handleRevokeKey = async (keyId: string) => {
    setIsRevoking(keyId);
    setError(null);

    try {
      const response = await apiClient["api-keys"][":id"].$delete({
        param: { id: keyId },
      });

      if (!response.ok) {
        throw new Error("Failed to revoke API key.");
      }

      fetchApiKeys();
      fetchPublishableKey();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "An unexpected error occurred during revocation.";
      setError(message);
    } finally {
      setIsRevoking(null);
    }
  };

  const handleFormSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    setNewlyCreatedKey(null);

    const formData = new FormData(event.currentTarget);
    const name = formData.get("name") as string;
    const keyType = "secret";
    const environment = "live";

    if (!name) {
      setError("Name is required.");
      setIsLoading(false);
      return;
    }

    const payload: CreateApiKeyPayload = { name, keyType, environment };

    try {
      const response = await apiClient["api-keys"].$post({
        json: payload,
      });

      const result = await response.json();

      if (
        response.ok &&
        "success" in result &&
        result.success &&
        "data" in result
      ) {
        setNewlyCreatedKey(result.data as CreatedApiKey);
        fetchApiKeys();
        (event.target as HTMLFormElement).reset();
      } else if ("error" in result && result.error) {
        setError(
          (result as { details?: string }).details ||
            (result as { error: string }).error ||
            "Failed to create API key."
        );
      } else {
        setError("Failed to create API key. Unexpected response structure.");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <PageContent title="API Keys">
      <div className="container mx-auto p-4 space-y-8">
        {newlyCreatedKey && (
          <Card className="bg-green-50 border-green-200">
            <CardHeader>
              <CardTitle className="text-green-700">
                API Key Created, value will not be shown again
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p>
                <strong>Key Value:</strong>{" "}
                {newlyCreatedKey && (
                  <IdBadge value={newlyCreatedKey.keyValue} />
                )}
              </p>

              <div className="mt-4">
                <CodeBlock
                  code={`// .env\nLUMEN_API_KEY=${newlyCreatedKey.keyValue}`}
                  copyValue={`LUMEN_API_KEY=${newlyCreatedKey.keyValue}`}
                  language="typescript"
                />
              </div>

              <Button
                onClick={() => setNewlyCreatedKey(null)}
                variant="outline"
                size="sm"
                className="mt-4"
              >
                I have saved the key, close this dialog
              </Button>
            </CardContent>
          </Card>
        )}
        {error && (
          <Card className="bg-red-50 border-red-200">
            <CardHeader>
              <CardTitle className="text-red-700">Error</CardTitle>
            </CardHeader>
            <CardContent>
              <p>{error}</p>
              <Button
                onClick={() => setError(null)}
                variant="outline"
                size="sm"
                className="mt-2"
              >
                Dismiss
              </Button>
            </CardContent>
          </Card>
        )}

        {!newlyCreatedKey && (
          <Card className="bg-green-50 border-green-200">
            <CardHeader>
              <CardTitle>Create New API Key</CardTitle>
            </CardHeader>
            <form onSubmit={handleFormSubmit}>
              <CardContent className="space-y-4">
                <div className="space-y-1">
                  <Label htmlFor="name">Key Name</Label>
                  <Input
                    id="name"
                    name="name"
                    className="bg-white"
                    placeholder="e.g., My Production Key"
                    required
                    disabled={isLoading}
                  />
                </div>
              </CardContent>
              <CardFooter className="mt-2">
                <Button type="submit" disabled={isLoading}>
                  {isLoading ? "Creating..." : "Create Secret Key"}
                </Button>
              </CardFooter>
            </form>
          </Card>
        )}

        {publishableKey && (
          <Card>
            <CardHeader>
              <CardTitle>Publishable Key</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p>
                <IdBadge value={publishableKey.keyValue} />
              </p>

              <div className="mt-4">
                <CodeBlock
                  code={`// .env\nNEXT_PUBLIC_LUMEN_PUBLISHABLE_KEY=${publishableKey.keyValue}`}
                  copyValue={`NEXT_PUBLIC_LUMEN_PUBLISHABLE_KEY=${publishableKey.keyValue}`}
                  language="typescript"
                />
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Existing API Keys</CardTitle>
            <Button
              onClick={() => fetchPublishableKey()}
              disabled={isLoadingPublishable}
              variant="outline"
              size="sm"
            >
              {isLoadingPublishable ? "Loading..." : "Refresh Keys"}
            </Button>
          </CardHeader>
          <CardContent>
            {isLoadingKeys ? (
              <p>Loading keys...</p>
            ) : keys.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Environment</TableHead>
                    <TableHead>Value (Masked)</TableHead>
                    <TableHead>Created At</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys
                    .sort((a, b) =>
                      a.revokedAt === null ? -1 : b.revokedAt === null ? 1 : 0
                    )
                    .map((key) => (
                      <TableRow key={key.id}>
                        <TableCell>{key.name}</TableCell>
                        <TableCell>{key.keyType}</TableCell>
                        <TableCell>{key.environment}</TableCell>
                        <TableCell>
                          <IdBadge
                            value={key.keyValue + "..."}
                            isCopyable={false}
                          />
                        </TableCell>
                        <TableCell>
                          <LocaleAwareDate
                            date={key.createdAt}
                            includeTime={true}
                          />
                        </TableCell>
                        <TableCell>
                          {key.revokedAt ? (
                            <span className="text-red-500">Revoked</span>
                          ) : (
                            <span className="text-green-500">Active</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {!key.revokedAt && (
                            <Button
                              className="cursor-pointer"
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRevokeKey(key.id)}
                              disabled={isRevoking === key.id}
                              aria-label={`Revoke key ${key.name}`}
                            >
                              {isRevoking === key.id ? (
                                "Revoking..."
                              ) : (
                                <Trash2 className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            ) : (
              <p>No API keys found.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </PageContent>
  );
}
