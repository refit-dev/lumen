"use client";

import { apiClient } from "@/lib/hono-client";
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, Shield, Key, CheckCircle, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";

interface DodoConfig {
  id: string;
  secretKey: string | null;
  hasWebhook: boolean;
  createdAt: string;
}

export default function DodoPage() {
  const [dodoConfig, setDodoConfig] = useState<DodoConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    secretKey: "",
  });
  const [showForm, setShowForm] = useState(false);

  const fetchDodoConfig = async () => {
    setIsLoading(true);
    try {
      const response = await apiClient.dodo.config.$get();
      if (response.ok) {
        const result = await response.json();
        setDodoConfig(result);
        setFormData({
          secretKey: "",
        });
      } else if (response.status === 404) {
        setDodoConfig(null);
        setShowForm(true);
      } else {
        throw new Error("Failed to fetch Dodo configuration");
      }
    } catch (error) {
      console.error("Error fetching Dodo config:", error);
      if (error instanceof Error && !error.message.includes("404")) {
        toast.error("Failed to load Dodo configuration");
      }
      setDodoConfig(null);
      setShowForm(true);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDodoConfig();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.secretKey) {
      toast.error("Secret key is required");
      return;
    }

    setIsSaving(true);
    try {
      // First validate the API key
      const validateResponse = await apiClient.dodo["validate-key"].$post({
        json: {
          secretKey: formData.secretKey,
        },
      });

      if (!validateResponse.ok) {
        const error = (await validateResponse.json()) as { error: string };
        toast.error(error.error || "Failed to validate API key");
        return;
      }

      // If validation succeeds, proceed with saving
      const response = await apiClient.dodo.config.$post({
        json: {
          secretKey: formData.secretKey,
        },
      });

      if (response.ok) {
        const result = await response.json();
        if ("message" in result) {
          toast.success(result.message);
        } else {
          toast.success("Dodo configuration saved successfully");
        }
        await fetchDodoConfig();
        setShowForm(false);
        setFormData({ secretKey: "" });
      } else {
        const error = await response.json();
        console.error("Error saving Dodo config:", error);
        throw new Error("Failed to save Dodo configuration");
      }
    } catch (error) {
      console.error("Error saving Dodo config:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to save Dodo configuration"
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleInputChange = (field: keyof typeof formData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-4 space-y-8">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 space-y-8">
      <div className="flex items-center space-x-3">
        <Shield className="h-8 w-8 text-blue-600" />
        <h1 className="text-3xl font-bold">Dodo Payments Configuration</h1>
      </div>

      <p className="text-muted-foreground">
        Manage your Dodo Payments API keys to process payments. These keys are
        securely stored and encrypted.
      </p>

      {dodoConfig && !showForm && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <span>Dodo Payments Configuration Active</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4">
              <div className="space-y-2">
                <Label className="flex items-center space-x-2">
                  <Key className="h-4 w-4" />
                  <span>Secret Key</span>
                </Label>
                <div className="font-mono text-sm bg-muted p-2 rounded border">
                  {dodoConfig.secretKey || "Not set"}
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Label>Webhook Status:</Label>
              <Badge variant={dodoConfig.hasWebhook ? "default" : "secondary"}>
                {dodoConfig.hasWebhook ? "Configured" : "Not configured"}
              </Badge>
            </div>

            <div className="text-sm text-muted-foreground">
              Configuration created:{" "}
              <LocaleAwareDate date={dodoConfig.createdAt} includeTime={true} />
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={() => setShowForm(true)} variant="outline">
              Update Dodo Configuration
            </Button>
          </CardFooter>
        </Card>
      )}

      {(!dodoConfig || showForm) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              {dodoConfig ? (
                <>
                  <Key className="h-5 w-5" />
                  <span>Update Dodo Configuration</span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-5 w-5 text-orange-500" />
                  <span>Add Dodo Configuration</span>
                </>
              )}
            </CardTitle>
            {!dodoConfig && (
              <p className="text-sm text-muted-foreground">
                No Dodo Payments configuration found. Add your API key to start
                processing payments.
              </p>
            )}
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="secretKey">Dodo Payments Secret Key</Label>
                <div className="flex space-x-2">
                  <Input
                    id="secretKey"
                    type="text"
                    value={formData.secretKey}
                    onChange={(e) =>
                      handleInputChange("secretKey", e.target.value)
                    }
                    placeholder="Your Dodo Payments secret key..."
                    disabled={isSaving}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  This key is kept secure on the server and never exposed
                  publicly.
                </p>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h4 className="font-medium text-blue-900 mb-2">
                  Important Notes:
                </h4>
                <ul className="text-sm text-blue-800 space-y-1">
                  <li>
                    • Your API key will be validated automatically when saving
                  </li>
                  <li>• Keys are encrypted and stored securely</li>
                  <li>• The system will try both test and live environments</li>
                </ul>
              </div>
            </CardContent>
            <CardFooter className="space-x-2 pt-6">
              <Button type="submit" disabled={isSaving || !formData.secretKey}>
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : dodoConfig ? (
                  "Update Configuration"
                ) : (
                  "Save Configuration"
                )}
              </Button>
              {dodoConfig && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setShowForm(false);
                    setFormData({
                      secretKey: "",
                    });
                  }}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
              )}
            </CardFooter>
          </form>
        </Card>
      )}
    </div>
  );
}
