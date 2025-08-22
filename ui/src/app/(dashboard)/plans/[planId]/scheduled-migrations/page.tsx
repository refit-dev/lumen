"use client";

import { apiClient } from "@/lib/hono-client";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Calendar, Users, ArrowRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";

interface ScheduledMigration {
  id: string;
  createdAt: string;
  subscriptionId: string;
  effectiveDate: string | null;
  effectiveOnNextBilling: boolean | null;
  newPlanId: string | null;
  newPriceId: string | null;
  newVersionNumber: string | null;
  processedAt: string | null;
  subscription: {
    id: string;
    stableSubscriptionId: string;
    createdAt: string;
    customer: {
      id: string;
      name: string | null;
      email: string | null;
      externalCustomerId?: string | null;
    };
    plan?: {
      id: string;
      planName: string;
      versionNumber: number;
      stablePlanId: string;
    };
  };
  newPlan: {
    id: string;
    planName: string;
    versionNumber: number;
    stablePlanId: string;
  } | null;
}

export default function ScheduledMigrationsPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const planId = params.planId as string;
  const view = searchParams?.get("view") || "outgoing";

  // Fetch the current plan details
  const { data: currentPlan, isLoading: isPlanLoading } = useQuery({
    queryKey: ["plan", planId],
    queryFn: async () => {
      const response = await apiClient.plans[":id"].$get({
        param: { id: planId },
        query: { includeFeatures: "true" },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(String(data.error));
      }
      return data.plans?.[0];
    },
    enabled: !!planId,
  });

  // Fetch scheduled migrations (outgoing)
  const { data: scheduledMigrations, isLoading: isMigrationsLoading } =
    useQuery({
      queryKey: ["scheduled-migrations", planId],
      queryFn: async (): Promise<ScheduledMigration[]> => {
        const response = await apiClient.plans[":planId"][
          "scheduled-migrations"
        ].$get({
          param: { planId },
        });
        const data = await response.json();
        if ("error" in data) {
          throw new Error(String(data.error));
        }
        return data.scheduledMigrations || [];
      },
      enabled: !!planId,
    });

  // Fetch incoming migrations
  const { data: incomingMigrations, isLoading: isIncomingLoading } = useQuery({
    queryKey: ["incoming-migrations", planId],
    queryFn: async (): Promise<ScheduledMigration[]> => {
      const response = await apiClient.plans[":planId"][
        "incoming-migrations"
      ].$get({
        param: { planId },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(String(data.error));
      }
      return data.incomingMigrations || [];
    },
    enabled: !!planId,
  });

  const isLoading = isPlanLoading || isMigrationsLoading || isIncomingLoading;

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-8">
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="space-y-4">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-8">
      {/* Header */}
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.back()}
            className="flex items-center gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Plan
          </Button>
        </div>

        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
            <Calendar className="h-8 w-8 text-blue-600" />
            Scheduled Migrations
          </h1>
          <p className="text-gray-600 mt-2">
            Manage subscriptions scheduled to migrate to newer plan versions
          </p>
        </div>

        {currentPlan && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium text-blue-900">Current Plan</h3>
                <p className="text-sm text-blue-700">
                  {currentPlan.planName} (v{currentPlan.versionNumber})
                </p>
              </div>
              <div className="text-sm text-blue-700">
                <span className="font-medium">
                  {scheduledMigrations?.length || 0}
                </span>{" "}
                outgoing •{" "}
                <span className="font-medium">
                  {incomingMigrations?.length || 0}
                </span>{" "}
                incoming
              </div>
            </div>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="flex space-x-1 bg-gray-100 p-1 rounded-lg max-w-md">
          <Button
            variant={view === "outgoing" ? "default" : "ghost"}
            size="sm"
            className="flex-1"
            onClick={() =>
              router.push(`/plans/${planId}/scheduled-migrations?view=outgoing`)
            }
          >
            Outgoing ({scheduledMigrations?.length || 0})
          </Button>
          <Button
            variant={view === "incoming" ? "default" : "ghost"}
            size="sm"
            className="flex-1"
            onClick={() =>
              router.push(`/plans/${planId}/scheduled-migrations?view=incoming`)
            }
          >
            Incoming ({incomingMigrations?.length || 0})
          </Button>
        </div>
      </div>

      {/* Migrations Table */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="p-6 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Users className="h-5 w-5 text-gray-600" />
            {view === "outgoing" ? "Outgoing" : "Incoming"} Migrations (
            {view === "outgoing"
              ? scheduledMigrations?.length || 0
              : incomingMigrations?.length || 0}
            )
          </h2>
        </div>

        <div className="overflow-x-auto">
          {(view === "outgoing" &&
            scheduledMigrations &&
            scheduledMigrations.length > 0) ||
          (view === "incoming" &&
            incomingMigrations &&
            incomingMigrations.length > 0) ? (
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
                  <TableHead className="font-medium">Customer</TableHead>
                  <TableHead className="font-medium">Subscription</TableHead>
                  <TableHead className="font-medium">Current Version</TableHead>
                  <TableHead className="font-medium">Target Version</TableHead>
                  <TableHead className="font-medium">
                    Migration Timing
                  </TableHead>
                  <TableHead className="font-medium">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(view === "outgoing"
                  ? scheduledMigrations!
                  : incomingMigrations!
                ).map((migration) => (
                  <TableRow key={migration.id} className="hover:bg-gray-50">
                    <TableCell>
                      <div>
                        <div className="font-medium text-gray-900">
                          {migration.subscription.customer.name}
                        </div>
                        <div className="text-sm text-gray-500">
                          {migration.subscription.customer.email}
                        </div>
                        {migration.subscription.customer.externalCustomerId && (
                          <div className="text-xs text-gray-400 font-mono">
                            {migration.subscription.customer.externalCustomerId}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-sm">
                        {migration.subscription.stableSubscriptionId}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {view === "incoming"
                          ? // For incoming migrations, show the subscriber's current plan version
                            `v${migration.subscription.plan?.versionNumber ?? "Unknown"}`
                          : // For outgoing migrations, show the version of the plan we are editing
                            `v${currentPlan?.versionNumber ?? "Unknown"}`}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <ArrowRight className="h-4 w-4 text-gray-400" />
                        <Badge variant="default">
                          {view === "incoming"
                            ? // Incoming: target is the plan version we're viewing
                              `v${currentPlan?.versionNumber ?? "Unknown"}`
                            : // Outgoing: target is recorded on the migration itself
                              `v${migration.newVersionNumber || "Unknown"}`}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Calendar className="h-4 w-4 text-amber-500" />
                        <span className="text-sm">
                          {migration.effectiveOnNextBilling
                            ? "Next billing cycle"
                            : migration.effectiveOnNextBilling === false
                              ? "Immediate"
                              : "Unknown"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-gray-600">
                        <LocaleAwareDate
                          date={migration.createdAt}
                          includeTime={true}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="p-12 text-center">
              <Calendar className="h-12 w-12 mx-auto mb-4 text-gray-300" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                No {view === "outgoing" ? "Outgoing" : "Incoming"} Migrations
              </h3>
              <p className="text-gray-500 max-w-sm mx-auto">
                {view === "outgoing"
                  ? "There are currently no subscriptions scheduled to migrate from this plan version."
                  : "There are currently no subscriptions scheduled to migrate to this plan version."}
              </p>
            </div>
          )}
        </div>
      </div>

      {((view === "outgoing" &&
        scheduledMigrations &&
        scheduledMigrations.length > 0) ||
        (view === "incoming" &&
          incomingMigrations &&
          incomingMigrations.length > 0)) && (
        <div
          className={`border rounded-lg p-4 ${
            view === "outgoing"
              ? "bg-amber-50 border-amber-200"
              : "bg-green-50 border-green-200"
          }`}
        >
          <div className="flex items-start gap-3">
            <Calendar
              className={`h-5 w-5 mt-0.5 ${
                view === "outgoing" ? "text-amber-600" : "text-green-600"
              }`}
            />
            <div>
              <h4
                className={`font-medium ${
                  view === "outgoing" ? "text-amber-900" : "text-green-900"
                }`}
              >
                {view === "outgoing"
                  ? "Migration Timeline"
                  : "Incoming Migrations"}
              </h4>
              <p
                className={`text-sm mt-1 ${
                  view === "outgoing" ? "text-amber-700" : "text-green-700"
                }`}
              >
                {view === "outgoing"
                  ? "Scheduled migrations will automatically process during each customer's next billing cycle. You can monitor the progress from the main plan page."
                  : "These subscriptions are scheduled to migrate to this plan version during their next billing cycle. They will automatically appear as subscribers once processed."}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
