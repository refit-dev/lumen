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

interface StripeConfig {
  id: string;
  publicKey: string | null;
  secretKey: string | null;
  hasWebhook: boolean;
  createdAt: string;
}

export default function StripePage() {
  const [stripeConfig, setStripeConfig] = useState<StripeConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    publicKey: "",
    secretKey: "",
  });
  const [showForm, setShowForm] = useState(false);

  const fetchStripeConfig = async () => {
    setIsLoading(true);
    try {
      const response = await apiClient.stripe.config.$get();
      if (response.ok) {
        const result = await response.json();
        setStripeConfig(result);
        setFormData({
          publicKey: result.publicKey || "",
          secretKey: "", // Never pre-fill secret key for security
        });
      } else if (response.status === 404) {
        setStripeConfig(null);
        setShowForm(true);
      } else {
        throw new Error("Failed to fetch Stripe configuration");
      }
    } catch (error) {
      console.error("Error fetching Stripe config:", error);
      if (error instanceof Error && !error.message.includes("404")) {
        toast.error("Failed to load Stripe configuration");
      }
      setStripeConfig(null);
      setShowForm(true);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStripeConfig();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.publicKey || !formData.secretKey) {
      toast.error("Both public key and secret key are required");
      return;
    }

    if (!formData.publicKey.startsWith("pk_")) {
      toast.error("Invalid public key format. Must start with 'pk_'");
      return;
    }

    if (!formData.secretKey.startsWith("sk_")) {
      toast.error("Invalid secret key format. Must start with 'sk_'");
      return;
    }

    setIsSaving(true);
    try {
      const response = await apiClient.stripe.config.$post({
        json: {
          publicKey: formData.publicKey,
          secretKey: formData.secretKey,
        },
      });

      if (response.ok) {
        const result = await response.json();
        toast.success(
          result.message || "Stripe configuration saved successfully"
        );
        await fetchStripeConfig();
        setShowForm(false);
        setFormData({ publicKey: "", secretKey: "" });
      } else {
        const error = await response.json();
        console.error("Error saving Stripe config:", error);
        throw new Error("Failed to save Stripe configuration");
      }
    } catch (error) {
      console.error("Error saving Stripe config:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to save Stripe configuration"
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
        <h1 className="text-3xl font-bold">Stripe Configuration</h1>
      </div>

      <p className="text-muted-foreground">
        Manage your Stripe API keys to process payments. These keys are securely
        stored and encrypted.
      </p>

      {stripeConfig && !showForm && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <span>Stripe Configuration Active</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4">
              <div className="space-y-2">
                <Label className="flex items-center space-x-2">
                  <Key className="h-4 w-4" />
                  <span>Publishable Key</span>
                </Label>
                <div className="font-mono text-sm bg-muted p-2 rounded border">
                  {stripeConfig.publicKey || "Not set"}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="flex items-center space-x-2">
                  <Shield className="h-4 w-4" />
                  <span>Secret Key</span>
                </Label>
                <div className="font-mono text-sm bg-muted p-2 rounded border">
                  {stripeConfig.secretKey || "Not set"}
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Label>Webhook Status:</Label>
              <Badge
                variant={stripeConfig.hasWebhook ? "default" : "secondary"}
              >
                {stripeConfig.hasWebhook ? "Configured" : "Not configured"}
              </Badge>
            </div>

            <div className="text-sm text-muted-foreground">
              Configuration created:{" "}
              <LocaleAwareDate
                date={stripeConfig.createdAt}
                includeTime={true}
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={() => setShowForm(true)} variant="outline">
              Update Stripe Keys
            </Button>
          </CardFooter>
        </Card>
      )}

      {(!stripeConfig || showForm) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              {stripeConfig ? (
                <>
                  <Key className="h-5 w-5" />
                  <span>Update Stripe Keys</span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-5 w-5 text-orange-500" />
                  <span>Add Stripe Keys</span>
                </>
              )}
            </CardTitle>
            {!stripeConfig && (
              <p className="text-sm text-muted-foreground">
                No Stripe configuration found. Add your keys to start processing
                payments.
              </p>
            )}
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="publicKey">Stripe Publishable Key</Label>
                <Input
                  id="publicKey"
                  type="text"
                  value={formData.publicKey}
                  onChange={(e) =>
                    handleInputChange("publicKey", e.target.value)
                  }
                  placeholder="pk_live_... or pk_test_..."
                  disabled={isSaving}
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">
                  This key is used on the client-side and is safe to expose
                  publicly.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="secretKey">Stripe Secret Key</Label>
                <Input
                  id="secretKey"
                  type="text"
                  value={formData.secretKey}
                  onChange={(e) =>
                    handleInputChange("secretKey", e.target.value)
                  }
                  placeholder="sk_live_... or sk_test_..."
                  disabled={isSaving}
                  autoComplete="off"
                  spellCheck={false}
                />
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
                  <li>• Use test keys (pk_test_/sk_test_) for development</li>
                  <li>• Use live keys (pk_live_/sk_live_) for production</li>
                  <li>• Your keys are encrypted and stored securely</li>
                </ul>
              </div>
            </CardContent>
            <CardFooter className="space-x-2 pt-6">
              <Button type="submit" disabled={isSaving}>
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : stripeConfig ? (
                  "Update Keys"
                ) : (
                  "Save Keys"
                )}
              </Button>
              {stripeConfig && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setShowForm(false);
                    setFormData({
                      publicKey: stripeConfig.publicKey || "",
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
