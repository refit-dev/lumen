"use client";

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/hono-client";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface Feature {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  featureType: "boolean" | "number" | "string";
  featureValue: boolean | number | string;
}

interface FeatureBadgeSelectorProps {
  selectedFeatureIds: string[];
  onFeatureToggle: (featureId: string) => void;
}

export default function FeatureBadgeSelector({
  selectedFeatureIds,
  onFeatureToggle,
}: FeatureBadgeSelectorProps) {
  const [features, setFeatures] = useState<Feature[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchFeatures = async () => {
      try {
        setLoading(true);
        const response = await apiClient.features.$get();
        const data = await response.json();

        if ("error" in data) {
          setError(data.error);
        } else {
          setFeatures(data.features);
        }
      } catch (err) {
        setError("Failed to fetch features");
        console.error("Error fetching features:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchFeatures();
  }, []);

  if (loading) {
    return (
      <div className="space-y-2">
        <Label className="text-base font-medium">Existing Features</Label>
        <div className="flex flex-wrap gap-2">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="h-6 w-20 bg-muted animate-pulse rounded-md"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        <Label className="text-base font-medium">Existing Features</Label>
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (features.length === 0) {
    return (
      <div className="space-y-2">
        <Label className="text-base font-medium">Existing Features</Label>
        <p className="text-sm text-muted-foreground">
          No features found. Create your first feature by adding it below.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label className="text-base font-medium">Existing Features</Label>
      <p className="text-sm text-muted-foreground">
        Click on features to add them to this plan
      </p>
      <div className="flex flex-wrap gap-2">
        {features.map((feature) => {
          const isSelected = selectedFeatureIds.includes(feature.id);
          return (
            <Badge
              key={feature.id}
              variant={isSelected ? "default" : "outline"}
              className={cn(
                "cursor-pointer transition-all duration-200 hover:scale-105",
                isSelected && "bg-primary text-primary-foreground",
                !isSelected && "hover:bg-muted"
              )}
              onClick={() => onFeatureToggle(feature.id)}
            >
              <span className="flex items-center gap-1">
                {isSelected ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <span className="h-3 w-3" />
                )}
                {feature.displayName}
                {feature.featureType === "number" && (
                  <span className="text-xs opacity-75">
                    ({feature.featureValue} included)
                  </span>
                )}
              </span>
            </Badge>
          );
        })}
      </div>
      {selectedFeatureIds.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {selectedFeatureIds.length} feature
          {selectedFeatureIds.length !== 1 ? "s" : ""} selected
        </p>
      )}
    </div>
  );
}
