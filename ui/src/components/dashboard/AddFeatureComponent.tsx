"use client";

import { useAppForm } from "@/hooks/form";
import { Toggle } from "@/components/ui/toggle";
import { Label } from "@/components/ui/label";
import { useState, useEffect, useCallback, useRef } from "react";
import { useStore } from "@tanstack/react-form";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

interface AddFeatureComponentProps {
  onRemove: () => void;
  onFeatureChange: (featureData: FeatureData | null) => void;
  index: number;
  showRemoveButton?: boolean;
}

export interface FeatureData {
  featureName: string;
  slug: string;
  eventName: string;
  maxUsage: number;
  isUsageBased: boolean;
}

export default function AddFeatureComponent({
  onRemove,
  onFeatureChange,
  index,
  showRemoveButton = true,
}: AddFeatureComponentProps) {
  const [isUsageBased, setIsUsageBased] = useState(false);
  const onFeatureChangeRef = useRef(onFeatureChange);

  // Update ref when callback changes
  useEffect(() => {
    onFeatureChangeRef.current = onFeatureChange;
  }, [onFeatureChange]);

  const form = useAppForm({
    defaultValues: {
      featureName: "",
      slug: "",
      eventName: "",
      maxUsage: 1000,
    },
    onSubmit: async () => {
      // This component doesn't submit on its own
    },
  });

  const generateSlugFromName = useCallback((name: string): string => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-");
  }, []);

  // Use store to watch for featureName changes
  const featureName = useStore(form.store, (state) => state.values.featureName);
  // Use store to watch for slug changes
  const slug = useStore(form.store, (state) => state.values.slug);
  // Use store to watch for eventName changes
  const eventName = useStore(form.store, (state) => state.values.eventName);
  // Use store to watch for maxUsage changes
  const maxUsage = useStore(form.store, (state) => state.values.maxUsage);

  // Update slug when featureName changes (for both boolean and usage-based)
  useEffect(() => {
    if (featureName) {
      const generatedSlug = generateSlugFromName(featureName);
      form.setFieldValue("slug", generatedSlug);
    }
  }, [featureName, generateSlugFromName, form]);

  // Update eventName when slug changes (only for usage-based)
  useEffect(() => {
    if (slug && isUsageBased) {
      form.setFieldValue("eventName", slug);
    }
  }, [slug, isUsageBased, form]);

  // Clear eventName when switching from usage-based to boolean
  useEffect(() => {
    if (!isUsageBased) {
      form.setFieldValue("eventName", "");
    }
  }, [isUsageBased, form]);

  // Notify parent when any relevant value changes
  const validateAndNotify = useCallback(() => {
    // Validate the feature data and notify parent
    if (featureName.trim() === "") {
      onFeatureChangeRef.current(null);
      return;
    }

    // Both boolean and usage-based features need a valid slug
    if (slug.trim() === "" || !/^[a-z0-9-]+$/.test(slug)) {
      onFeatureChangeRef.current(null);
      return;
    }

    if (isUsageBased) {
      // For usage-based features, we also need eventName
      if (eventName.trim() === "") {
        onFeatureChangeRef.current(null);
        return;
      }

      // Valid usage-based feature data
      onFeatureChangeRef.current({
        featureName,
        slug,
        eventName,
        maxUsage,
        isUsageBased: true,
      });
    } else {
      // Valid boolean feature data
      onFeatureChangeRef.current({
        featureName,
        slug,
        eventName: "", // Not needed for boolean features
        maxUsage: 0, // Not needed for boolean features
        isUsageBased: false,
      });
    }
  }, [featureName, slug, eventName, maxUsage, isUsageBased]);

  useEffect(() => {
    validateAndNotify();
  }, [validateAndNotify]);

  return (
    <div className="border rounded-lg p-4 space-y-4 relative">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">Feature {index + 1}</h3>
        {showRemoveButton && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRemove}
            className="h-8 w-8 p-0"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <form.AppField
        name="featureName"
        children={(field) => <field.TextField label="Feature Name" />}
      />

      <form.AppField name="slug">
        {(field) => <field.TextField label="Feature Slug" />}
      </form.AppField>

      <div className="space-y-2">
        <Label>Feature Type</Label>
        <div className="flex space-x-2">
          <Toggle
            pressed={!isUsageBased}
            onPressedChange={() => setIsUsageBased(false)}
          >
            Boolean Feature
          </Toggle>
          <Toggle
            pressed={isUsageBased}
            onPressedChange={() => setIsUsageBased(true)}
          >
            Usage-based Feature
          </Toggle>
        </div>
      </div>

      {isUsageBased && (
        <>
          <form.AppField name="eventName">
            {(field) => <field.TextField label="Event Name" />}
          </form.AppField>
          <form.AppField
            name="maxUsage"
            children={(field) => (
              <field.NumberField label="Maximum Usage Per Month" />
            )}
          />
        </>
      )}
    </div>
  );
}
