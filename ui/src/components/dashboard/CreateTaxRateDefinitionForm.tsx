"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiClient } from "@/lib/hono-client";
import { useAppForm } from "@/hooks/form";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

interface CreateTaxRateDefinitionFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

const createTaxRateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  taxRate: z.string().min(1, "Tax rate is required"),
  jurisdiction: z.string().optional(),
});

export function CreateTaxRateDefinitionForm({
  onSuccess,
  onCancel,
}: CreateTaxRateDefinitionFormProps) {
  const [taxRateError, setTaxRateError] = useState("");

  const form = useAppForm({
    defaultValues: {
      name: "",
      description: "",
      taxRate: "",
      jurisdiction: "",
    },
    onSubmit: async ({ value }) => {
      try {
        // Convert percentage to decimal (e.g., 19.5 -> 0.195)
        const taxRateDecimal = (parseFloat(value.taxRate) / 100).toString();

        await createMutation.mutateAsync({
          name: value.name,
          description: value.description || undefined,
          taxRate: taxRateDecimal,
          jurisdiction: value.jurisdiction || undefined,
        });

        onSuccess();
      } catch (error) {
        console.error("Error creating tax rate definition:", error);
        throw error;
      }
    },
    validators: {
      onSubmit: ({ value }) => {
        const result = createTaxRateSchema.safeParse(value);
        if (!result.success) {
          const errors = result.error.issues.reduce(
            (acc: Record<string, string>, issue: z.ZodIssue) => ({
              ...acc,
              [issue.path[0]]: issue.message,
            }),
            {}
          );
          return { fields: errors };
        }
        return undefined;
      },
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: {
      name: string;
      description?: string;
      taxRate: string;
      jurisdiction?: string;
    }) => {
      const response = await apiClient.tax["rate-definitions"]["create"].$post({
        json: data,
      });
      const result = await response.json();
      if ("error" in result) {
        throw new Error(result.error as string);
      }
      return result;
    },
  });

  const validateTaxRate = (value: string) => {
    if (!value || value.trim() === "") {
      setTaxRateError("");
      return true;
    }

    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      setTaxRateError("Please enter a valid number");
      return false;
    }

    if (numValue < 0) {
      setTaxRateError("Tax rate cannot be negative");
      return false;
    }

    if (numValue > 100) {
      setTaxRateError("Tax rate cannot exceed 100%");
      return false;
    }

    setTaxRateError("");
    return true;
  };

  return (
    <Dialog open={true} onOpenChange={onCancel}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Tax Rate Definition</DialogTitle>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
          className="space-y-4"
        >
          <form.AppField
            name="name"
            children={(field) => <field.TextField label="Name" autoFocus />}
          />

          <form.AppField
            name="description"
            children={(field) => (
              <field.TextField label="Description" isOptional />
            )}
          />

          <div className="space-y-2">
            <form.AppField
              name="taxRate"
              children={(field) => (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <field.TextField
                      label="Tax Rate"
                      onChange={(value) => {
                        // Only allow numbers and single decimal point
                        if (value === "" || /^\d*\.?\d*$/.test(value)) {
                          field.handleChange(value);
                          validateTaxRate(value);
                        }
                      }}
                    />
                    <span className="text-sm text-gray-700 mt-6">%</span>
                  </div>
                  {taxRateError && (
                    <div className="text-xs text-red-600">{taxRateError}</div>
                  )}
                </div>
              )}
            />
          </div>

          <form.AppField
            name="jurisdiction"
            children={(field) => (
              <field.TextField label="Jurisdiction" isOptional />
            )}
          />

          <div className="flex justify-end gap-3 pt-4">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createMutation.isPending || !!taxRateError}
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Tax Rate"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
