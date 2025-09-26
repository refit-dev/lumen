"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/hono-client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";
import {
  YC_ENROLLMENT_FEATURE_SLUG,
  YC_ENROLLMENT_PLACEHOLDER_DOMAIN,
} from "@lumen/common/utils";

interface FeatureEntitlement {
  entitled: boolean | null;
  feature: { slug: string; value: boolean | string | number | null } | null;
}

type MatcherType = "email" | "domain";

const getEntitlements = async () => {
  const res = await fetch("/api/lumen/entitlements/{customerId}", {
    credentials: "include",
  });
  return res.json();
};

export function PlanEnrollmentRules({ planId }: { planId: string }) {
  const queryClient = useQueryClient();
  const [matcherType, setMatcherType] = useState<MatcherType>("email");
  const [matcherValue, setMatcherValue] = useState("");
  const [entitlements, setEntitlements] = useState<FeatureEntitlement[]>([]);

  useEffect(() => {
    getEntitlements().then((data) => {
      setEntitlements(data?.entitlements || []);
    });
  }, []);

  const enabled = useMemo(() => !!planId, [planId]);

  const { data, isLoading } = useQuery<{
    rules: Array<{
      id: string;
      matcherType: MatcherType;
      matcherValue: string;
    }>;
  }>({
    queryKey: ["plan-enrollment-rules", planId],
    queryFn: async () => {
      const res = await apiClient.enrollment.rules.$get({ query: { planId } });
      return res.json();
    },
    enabled,
  });

  const createRule = useMutation({
    mutationFn: async () => {
      const res = await apiClient.enrollment.rules.$post({
        json: { planId, matcherType, matcherValue },
      });
      const body = (await res.json()) as { error?: string };
      if (body.error) throw new Error(body.error);
      return body;
    },
    onSuccess: () => {
      setMatcherValue("");
      queryClient.invalidateQueries({
        queryKey: ["plan-enrollment-rules", planId],
      });
    },
  });

  const createYcRule = useMutation({
    mutationFn: async () => {
      const res = await apiClient.enrollment.rules.$post({
        json: {
          planId,
          matcherType: "domain" as MatcherType,
          matcherValue: YC_ENROLLMENT_PLACEHOLDER_DOMAIN,
        },
      });
      const body = (await res.json()) as { error?: string };
      if (body.error) throw new Error(body.error);

      const resp = await apiClient.plans[":id"][
        "toggle-pricing-table-visibility"
      ].$post({
        param: { id: planId },
        json: { isVisible: false },
      });
      const toggleBody = await resp.json();
      if ("error" in toggleBody && (toggleBody as { error?: string }).error) {
        throw new Error(String((toggleBody as { error?: string }).error));
      }

      return { success: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["plan-enrollment-rules", planId],
      });
      // Invalidate queries that reflect pricing table visibility
      queryClient.invalidateQueries({
        queryKey: ["plan-versions", planId],
      });
      queryClient.invalidateQueries({ queryKey: ["pricing-tables"] });
      queryClient.invalidateQueries({
        queryKey: ["pricing-tables-with-plan", planId],
      });
    },
  });

  const hasYcEntitlement = useMemo(
    () =>
      entitlements.some((e) => e?.feature?.slug === YC_ENROLLMENT_FEATURE_SLUG),
    [entitlements]
  );

  const ycRulePresent = useMemo(
    () =>
      (data?.rules || []).some(
        (r) =>
          r.matcherType === "domain" &&
          r.matcherValue === YC_ENROLLMENT_PLACEHOLDER_DOMAIN
      ),
    [data?.rules]
  );

  const deleteRule = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiClient.enrollment.rules[":id"].$delete({
        param: { id },
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["plan-enrollment-rules", planId],
      });
    },
  });

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
      <div className="p-6 border-b border-slate-200 bg-slate-50/50">
        <h2 className="text-xl font-bold text-slate-900 flex items-center gap-3">
          <div className="bg-white p-2 rounded-md border border-slate-200">
            <Users className="h-5 w-5 text-slate-600" />
          </div>
          Enrollment Rules
        </h2>
      </div>
      <div className="p-4 space-y-4">
        <p className="text-sm text-slate-600">
          If a user with a matching email signs up they will be automatically
          assigned to this plan
        </p>
        <div className="flex gap-2 items-end">
          <div className="w-36">
            <Label className="text-xs">Type</Label>
            <Select
              value={matcherType}
              onValueChange={(v: MatcherType) => setMatcherType(v)}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="domain">Domain</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1">
            <Label className="text-xs">Value</Label>
            <Input
              value={matcherValue}
              onChange={(e) => setMatcherValue(e.target.value)}
              placeholder={
                matcherType === "email" ? "jane@acme.com" : "acme.com"
              }
              className="h-8 text-xs"
            />
          </div>
          <Button
            size="sm"
            onClick={() => createRule.mutate()}
            disabled={!matcherValue || createRule.isPending}
          >
            Add
          </Button>
        </div>

        {hasYcEntitlement && !ycRulePresent ? (
          <div>
            <Button
              size="sm"
              className="text-xs font-bold bg-orange-500 text-white hover:bg-orange-600"
              onClick={() => createYcRule.mutate()}
              disabled={createYcRule.isPending}
            >
              Click here to automatically enroll YC Companies to this plan
            </Button>
          </div>
        ) : null}

        <div className="space-y-2">
          {isLoading ? (
            <div className="text-xs text-muted-foreground">Loading...</div>
          ) : (data?.rules?.length ?? 0) === 0 ? (
            <div className="text-xs text-muted-foreground">No rules yet</div>
          ) : (
            data?.rules?.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between rounded border px-2 py-1"
              >
                <div className="text-xs">
                  <span className="font-medium">{r.matcherType}</span>:{" "}
                  {r.matcherType === "domain" &&
                  r.matcherValue === YC_ENROLLMENT_PLACEHOLDER_DOMAIN ? (
                    <Badge className="bg-orange-50 text-orange-700 border-orange-200">
                      YC Companies
                    </Badge>
                  ) : (
                    r.matcherValue
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => deleteRule.mutate(r.id)}
                >
                  Delete
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
