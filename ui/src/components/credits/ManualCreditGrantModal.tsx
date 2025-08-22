"use client";

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/hono-client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { CreditSelectionStep } from "./CreditSelectionStep";
import { ExistingCreditSelector } from "./ExistingCreditSelector";
import { NewCreditConfigurator } from "./NewCreditConfigurator";
import { GrantConfigurator } from "./GrantConfigurator";
import { GrantConfirmation } from "./GrantConfirmation";
import { GrantSuccess } from "./GrantSuccess";

export interface AvailableCreditDefinition {
  id: string;
  name: string;
  description: string | null;
  applicationType: "usage" | "monetary";
  featureSlug: string | null;
  source: "plan" | "manual";
  currency: string | null;
  currentGrants: Array<{
    id: string;
    remainingAmount: number; // In cents for monetary, units for usage
    initialAmount: number; // In cents for monetary, units for usage
    expiryDate: string | null;
    status: string;
  }>;
}

export interface NewCreditConfig {
  applicationType: "usage" | "monetary";
  scope: "component" | "price" | "plan" | "merchant";
  featureId?: string;
  planId?: string;
  priceId?: string;
  priceComponentId?: string;
  currency?: string;
  billingVisible?: boolean;
  billingDescription?: string;
  name: string;
  description?: string;
}

export interface GrantConfig {
  amount: number; // Store in cents for monetary, units for usage internally
  expiryDate: Date | null;
  notes: string;
}

interface CreditGrant {
  id: string;
  initialAmount: number;
  remainingAmount: number;
  customerId: string;
  applicationType: "usage" | "monetary";
  source: string;
  status: string;
  createdAt: string;
}

interface CreditDefinition {
  id: string;
  name: string;
  description: string | null;
  applicationType: "usage" | "monetary";
  scope: "plan" | "merchant";
}

type ModalStep =
  | "select"
  | "extend"
  | "new"
  | "configure"
  | "confirm"
  | "success";

interface ManualCreditGrantModalProps {
  customerId: string;
  customerName: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (grant: CreditGrant) => void;
}

export function ManualCreditGrantModal({
  customerId,
  customerName,
  isOpen,
  onClose,
  onSuccess,
}: ManualCreditGrantModalProps) {
  const queryClient = useQueryClient();

  // State management
  const [step, setStep] = useState<ModalStep>("select");
  const [creditType, setCreditType] = useState<"extend" | "new">("extend");
  const [selectedDefinition, setSelectedDefinition] =
    useState<AvailableCreditDefinition | null>(null);
  const [newCreditConfig, setNewCreditConfig] =
    useState<NewCreditConfig | null>(null);
  const [grantConfig, setGrantConfig] = useState<GrantConfig>({
    amount: 0,
    expiryDate: null,
    notes: "",
  });
  const [createdGrant, setCreatedGrant] = useState<{
    creditGrant: CreditGrant;
    creditDefinition: CreditDefinition;
  } | null>(null);

  // Fetch available credit definitions for extending
  const { data: availableDefinitions, isLoading: isLoadingDefinitions } =
    useQuery({
      queryKey: ["customer-available-credit-definitions", customerId],
      queryFn: async () => {
        const response = await apiClient.credits.customers[":customerId"][
          "available-credit-definitions"
        ].$get({
          param: { customerId },
        });
        const data = await response.json();
        if ("error" in data) {
          throw new Error(
            typeof data.error === "string" ? data.error : "Unknown error"
          );
        }
        return data.availableDefinitions as AvailableCreditDefinition[];
      },
      enabled: isOpen && customerId !== "",
    });

  // Fetch validation limits
  const { data: limits } = useQuery({
    queryKey: ["credit-limits"],
    queryFn: async () => {
      const response = await apiClient.credits.limits.$get();
      const data = await response.json();
      if ("error" in data) {
        throw new Error("Error while fetching credit limits");
      }
      return data.limits;
    },
    enabled: isOpen,
  });

  // Create manual credit grant mutation
  const createGrantMutation = useMutation({
    mutationFn: async (grantData: {
      customerId: string;
      creditType: "extend" | "new";
      existingCreditDefinitionId?: string;
      newCreditConfig?: NewCreditConfig;
      amount: number;
      expiryDate?: Date;
      notes?: string;
    }) => {
      const response = await apiClient.credits["manual-grant"].$post({
        json: grantData,
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }
      return data;
    },
    onSuccess: (data) => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({
        queryKey: ["customer-available-credit-definitions", customerId],
      });
      queryClient.invalidateQueries({
        queryKey: ["customer", customerId],
      });
      queryClient.invalidateQueries({
        queryKey: ["manual-grants"],
      });

      setCreatedGrant(data);
      setStep("success");

      toast.success("Credits granted successfully!", {
        description: `${grantConfig.amount} credits granted to ${customerName}`,
      });

      if (onSuccess) {
        onSuccess(data.creditGrant);
      }
    },
    onError: (error) => {
      console.error("Error creating manual credit grant:", error);
      toast.error("Failed to grant credits", {
        description:
          error instanceof Error ? error.message : "An unknown error occurred",
      });
    },
  });

  // Handle step navigation
  const handleStepSelect = (selectedCreditType: "extend" | "new") => {
    setCreditType(selectedCreditType);
    if (selectedCreditType === "extend") {
      setStep("extend");
    } else {
      setStep("new");
    }
  };

  const handleExtendSelect = (definition: AvailableCreditDefinition) => {
    setSelectedDefinition(definition);
    setStep("configure");
  };

  const handleNewConfigured = (config: NewCreditConfig) => {
    setNewCreditConfig(config);
    setStep("configure");
  };

  const handleGrantConfigured = (config: GrantConfig) => {
    setGrantConfig(config);
    setStep("confirm");
  };

  const handleConfirm = () => {
    // Amount is already in correct format (cents for monetary, units for usage)
    const apiAmount = grantConfig.amount;

    const grantData = {
      customerId,
      creditType,
      amount: apiAmount,
      notes: grantConfig.notes || undefined,
      ...(grantConfig.expiryDate && {
        expiryDate: grantConfig.expiryDate,
      }),
      ...(creditType === "extend" && selectedDefinition
        ? { existingCreditDefinitionId: selectedDefinition.id }
        : {}),
      ...(creditType === "new" && newCreditConfig ? { newCreditConfig } : {}),
    };

    createGrantMutation.mutate(grantData);
  };

  const handleBack = () => {
    switch (step) {
      case "extend":
      case "new":
        setStep("select");
        break;
      case "configure":
        if (creditType === "extend") {
          setStep("extend");
        } else {
          setStep("new");
        }
        break;
      case "confirm":
        setStep("configure");
        break;
      default:
        break;
    }
  };

  const handleClose = () => {
    // Reset all state when closing
    setStep("select");
    setCreditType("extend");
    setSelectedDefinition(null);
    setNewCreditConfig(null);
    setGrantConfig({
      amount: 0,
      expiryDate: null,
      notes: "",
    });
    setCreatedGrant(null);
    onClose();
  };

  const getModalTitle = () => {
    switch (step) {
      case "select":
        return `Grant Credits to ${customerName}`;
      case "extend":
        return "Extend Existing Credits";
      case "new":
        return "Grant New Credits";
      case "configure":
        return "Configure Credit Grant";
      case "confirm":
        return "Confirm Credit Grant";
      case "success":
        return "Credits Granted Successfully";
      default:
        return "Grant Credits";
    }
  };

  const getModalDescription = () => {
    switch (step) {
      case "select":
        return "Choose whether to extend existing credits from the customer's plans or create new credits.";
      case "extend":
        return "Select from available credit definitions based on the customer's active subscription plans.";
      case "new":
        return "Configure new credit parameters not tied to existing plans.";
      case "configure":
        return "Set the amount and expiry date for the credit grant.";
      case "confirm":
        return "Review the details before granting credits.";
      case "success":
        return "The credits have been successfully granted to the customer.";
      default:
        return "";
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-none w-fit min-w-[600px] sm:max-w-none md:max-w-none lg:max-w-none xl:max-w-none max-h-[95vh] overflow-y-auto">
        <DialogHeader className="space-y-3 pb-6">
          <DialogTitle className="text-2xl font-bold">
            {getModalTitle()}
          </DialogTitle>
          <DialogDescription className="text-base text-muted-foreground">
            {getModalDescription()}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-8">
          {step === "select" && (
            <CreditSelectionStep onSelect={handleStepSelect} />
          )}

          {step === "extend" && (
            <ExistingCreditSelector
              availableDefinitions={availableDefinitions || []}
              isLoading={isLoadingDefinitions}
              onSelect={handleExtendSelect}
              onBack={handleBack}
              onClose={handleClose}
            />
          )}

          {step === "new" && (
            <NewCreditConfigurator
              onConfigured={handleNewConfigured}
              onBack={handleBack}
              onClose={handleClose}
            />
          )}

          {step === "configure" && (
            <GrantConfigurator
              creditDefinition={selectedDefinition}
              newCreditConfig={newCreditConfig}
              limits={limits}
              config={grantConfig}
              onChange={setGrantConfig}
              onNext={handleGrantConfigured}
              onBack={handleBack}
              onClose={handleClose}
            />
          )}

          {step === "confirm" && (
            <GrantConfirmation
              customerName={customerName}
              creditType={creditType}
              selectedDefinition={selectedDefinition}
              newCreditConfig={newCreditConfig}
              grantConfig={grantConfig}
              isLoading={createGrantMutation.isPending}
              onConfirm={handleConfirm}
              onBack={handleBack}
              onClose={handleClose}
            />
          )}

          {step === "success" && createdGrant && (
            <GrantSuccess
              customerName={customerName}
              createdGrant={createdGrant}
              onClose={handleClose}
              onGrantMore={() => {
                setStep("select");
                setCreditType("extend");
                setSelectedDefinition(null);
                setNewCreditConfig(null);
                setGrantConfig({
                  amount: 0,
                  expiryDate: null,
                  notes: "",
                });
                setCreatedGrant(null);
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
