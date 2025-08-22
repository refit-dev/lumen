"use client";

import { apiClient } from "@/lib/hono-client";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Trash2,
  Loader2,
  ArrowUpDown,
  ChevronDown,
  Edit,
  ToggleLeft,
  ToggleRight,
  BarChart3,
  Settings,
} from "lucide-react";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  PaginationState,
} from "@tanstack/react-table";
import { CustomerFromApi } from "@lumen/common/schema";
import { IdBadge } from "@/components/ui/id-badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { CreditCard, Users, Zap } from "lucide-react";
import { PlanMigrationModal } from "@/components/dashboard/PlanMigrationModal";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PricingTableCards } from "@/components/ui/pricing-table";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";

// Import API types for plan with features
interface APIFeature {
  id: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  merchantId: string;
  slug: string;
  displayName: string;
  featureValue: boolean | number | string;
  metricIds: string[] | null;
}

interface APIPlanWithFeatures {
  id: string;
  pspPlanId: string | null;
  createdAt: string;
  deletedAt: string | null;
  merchantId: string;
  stablePlanId: string;
  versionNumber: number;
  planName: string;
  planDescription: string | null;
  commitMessage: string | null;
  isTrialPlan: boolean;
  trialParentPlanId: string | null;
  trialDays: number | null;
  features: APIFeature[];
  isVisibleInPricingTable: boolean;
  isEnterprisePlan: boolean;
  enterpriseRedirectUrl: string | null;
  buttonText: string;
}

// Type guard to ensure an object has the full Plan-with-features shape
const isAPIPlanWithFeatures = (plan: unknown): plan is APIPlanWithFeatures => {
  if (typeof plan !== "object" || plan === null) return false;
  const obj = plan as Record<string, unknown>;
  return (
    "features" in obj &&
    Array.isArray(obj.features as unknown[]) &&
    "isVisibleInPricingTable" in obj
  );
};

// Subscription type with customer relation
interface SubscriptionWithCustomer {
  id: string;
  createdAt: string;
  deletedAt: string | null;
  merchantId: string;
  effectivePriceId: string;
  customerId: string;
  planId: string;
  versionNumber: number;
  priceOverrideId: string | null;
  featureOverrideId: string | null;
  startTimestamp: string;
  endTimestamp: string | null;
  customer: CustomerFromApi;
}

// Types for pricing components - flexible to handle actual API data
interface PricingComponent {
  type: "fixed" | "per_unit" | "usage";
  amount_cents?: number;
  per_unit_cents?: number;
  unit_cost_cents?: number;
  recurrence_rule?: string;
  component_name?: string;
  label?: string;
  bill_immediately?: boolean;
  component_id?: string;
  metric_id?: string;
  unit_label?: string;
  [key: string]: unknown; // Allow additional properties
}

// Customer table columns
const customerColumns: ColumnDef<SubscriptionWithCustomer>[] = [
  {
    id: "select",
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        onClick={(e) => e.stopPropagation()}
        aria-label="Select row"
      />
    ),
    enableSorting: false,
    enableHiding: false,
  },
  {
    accessorKey: "customer.name",
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Customer Name
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      );
    },
    cell: ({ row }) => row.original.customer?.name || "-",
  },
  {
    accessorKey: "customer.email",
    header: "Email",
    cell: ({ row }) => row.original.customer?.email || "-",
  },
  {
    id: "customer.externalCustomerId",
    accessorKey: "customer.externalCustomerId",
    header: "External ID",
    cell: ({ row }) => row.original.customer?.externalCustomerId || "-",
  },
  {
    id: "customer.businessName",
    accessorKey: "customer.businessName",
    header: "Business Name",
    cell: ({ row }) => row.original.customer?.businessName || "-",
  },
  {
    id: "customer.taxId",
    accessorKey: "customer.taxId",
    header: "Tax ID",
    cell: ({ row }) => row.original.customer?.taxId || "-",
  },
  {
    id: "customer.taxStatus",
    header: "Tax Status",
    cell: ({ row }) => {
      const customer = row.original.customer;
      if (customer?.taxExempt === null || customer?.taxExempt === undefined) {
        return "-";
      }
      return (
        <Badge
          variant={customer.taxExempt ? "secondary" : "outline"}
          className={
            customer.taxExempt
              ? "bg-amber-100 text-amber-800 border-amber-200"
              : "bg-green-100 text-green-800 border-green-200"
          }
        >
          {customer.taxExempt ? "Exempt" : "Applicable"}
        </Badge>
      );
    },
  },
  {
    accessorKey: "createdAt",
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Subscription Start
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      );
    },
    cell: ({ row }) => <LocaleAwareDate date={row.getValue("createdAt")} />,
  },
];

// Type for price data from API
interface PriceData {
  pricingData?: {
    components?: PricingComponent[];
  };
}

// Helper function to check if a plan is truly free (all components are $0)
const isTrulyFreePlan = (planPrices: PriceData[] | undefined): boolean => {
  return (
    planPrices?.every((price) =>
      price.pricingData?.components?.every((component) => {
        if (component.type === "fixed" || component.type === "per_unit") {
          return (component.amount_cents ?? 0) === 0;
        } else if (component.type === "usage") {
          return (component.unit_cost_cents ?? 0) === 0;
        }
        return true;
      })
    ) ?? false
  );
};

// Helper function to check if a plan is usage-only (no fixed costs, but has usage costs)
const isUsageOnlyPlan = (planPrices: PriceData[] | undefined): boolean => {
  if (!planPrices || planPrices.length === 0) return false;

  return planPrices.some((price) => {
    const hasZeroFixedCosts =
      price.pricingData?.components?.every((component) =>
        component.type === "fixed" || component.type === "per_unit"
          ? (component.amount_cents ?? 0) === 0
          : true
      ) ?? false;

    const hasUsageCosts =
      price.pricingData?.components?.some(
        (component) =>
          component.type === "usage" && (component.unit_cost_cents ?? 0) > 0
      ) ?? false;

    return hasZeroFixedCosts && hasUsageCosts;
  });
};

export default function PlanDetailsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const params = useParams();
  const { data: session } = useSession();

  // Table states for customers
  const [customerSorting, setCustomerSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);
  const [customerColumnFilters, setCustomerColumnFilters] =
    useState<ColumnFiltersState>([]);
  const [customerColumnVisibility, setCustomerColumnVisibility] =
    useState<VisibilityState>({
      "customer.externalCustomerId": false,
      "customer.businessName": false,
      "customer.taxId": false,
      "customer.taxStatus": false,
      createdAt: false,
    });
  const [customerRowSelection, setCustomerRowSelection] = useState({});
  const [customerPagination, setCustomerPagination] = useState<PaginationState>(
    {
      pageIndex: 0,
      pageSize: 10,
    }
  );

  // Migration modal state – open automatically if query param present
  const searchParams = useSearchParams();
  const [showMigrationModal, setShowMigrationModal] = useState(
    searchParams?.get("showMigration") === "1"
  );

  // Extract migration-related version query params early so they are available
  // to any hooks or memoized computations that may reference them further below
  const urlFromVersionParam = searchParams?.get("fromVersion");
  const urlToVersionParam = searchParams?.get("toVersion");

  // Version selection state
  const [selectedVersionId, setSelectedVersionId] = useState<string>("");

  const planId = params.planId as string;

  // Mutations for plan operations
  const deletePlanMutation = useMutation({
    mutationFn: async () => {
      if (!selectedVersionId) throw new Error("No plan selected");
      const response = await apiClient.plans[":id"].$delete({
        param: { id: selectedVersionId },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plans"] });
      queryClient.invalidateQueries({ queryKey: ["plan-versions"] });
      router.push("/plans");
    },
  });

  // Toggle plan visibility in pricing table
  const togglePricingTableMutation = useMutation({
    mutationFn: async (isVisible: boolean) => {
      if (!selectedVersionId) throw new Error("No plan selected");
      const response = await apiClient.plans[":id"][
        "toggle-pricing-table-visibility"
      ].$post({
        param: { id: selectedVersionId },
        json: { isVisible },
      });

      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }

      return data;
    },
    onSuccess: (data, isVisible) => {
      queryClient.invalidateQueries({ queryKey: ["plan-versions", planId] });
      queryClient.invalidateQueries({ queryKey: ["pricing-tables"] });
      queryClient.invalidateQueries({
        queryKey: ["pricing-tables-with-plan", selectedVersionId],
      });

      toast.success(
        data.message ||
          (isVisible
            ? "Plan added to pricing table successfully"
            : "Plan removed from pricing table successfully")
      );
    },
    onError: (error, isVisible) => {
      console.error("Error toggling pricing table visibility:", error);

      toast.error(
        error instanceof Error
          ? error.message
          : isVisible
            ? "Failed to add plan to pricing table"
            : "Failed to remove plan from pricing table"
      );
    },
  });

  // Get all versions of the plan first (using the planId as stablePlanId initially)
  const { data: allPlanVersions, isLoading: isVersionsLoading } = useQuery<
    APIPlanWithFeatures[]
  >({
    queryKey: ["plan-versions", planId],
    queryFn: async () => {
      if (!planId) throw new Error("Plan ID is required");

      // First, get the current plan to determine the stablePlanId
      const currentPlanResponse = await apiClient.plans[":id"].$get({
        param: { id: planId },
        query: { includeFeatures: "true" },
      });
      const currentPlanData = await currentPlanResponse.json();
      if ("error" in currentPlanData) {
        throw new Error(String(currentPlanData.error));
      }
      if (!currentPlanData.plans || currentPlanData.plans.length === 0) {
        throw new Error("Plan not found");
      }

      const currentPlan = currentPlanData.plans[0];

      // Now get all versions using the stablePlanId as path parameter with isStableId flag
      const allVersionsResponse = await apiClient.plans[":id"].$get({
        param: { id: currentPlan.stablePlanId },
        query: {
          includeFeatures: "true",
          isStableId: "true",
        },
      });
      const allVersionsData = await allVersionsResponse.json();
      if ("error" in allVersionsData) {
        throw new Error(String(allVersionsData.error));
      }

      const versions = allVersionsData.plans || [];
      // Sort by version number descending (latest first) and narrow the type
      return versions
        .sort((a, b) => b.versionNumber - a.versionNumber)
        .filter(isAPIPlanWithFeatures);
    },
    enabled: !!planId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });

  const latestVersion = allPlanVersions?.[0];

  // Initialize selectedVersionId once versions are available
  useEffect(() => {
    if (latestVersion && !selectedVersionId) {
      setSelectedVersionId(latestVersion.id);
    }
    // We only want this to run once when latestVersion is first available
  }, [latestVersion, selectedVersionId]);

  // Get the currently selected plan version
  const plan = useMemo(() => {
    if (!allPlanVersions || !selectedVersionId) return null;
    return (
      allPlanVersions.find((v) => v.id === selectedVersionId) ||
      allPlanVersions[0]
    );
  }, [allPlanVersions, selectedVersionId]);

  const targetVersionNumber = useMemo(() => {
    const parsed = urlToVersionParam ? Number(urlToVersionParam) : NaN;
    if (!Number.isNaN(parsed)) return parsed;
    return latestVersion?.versionNumber || 0;
  }, [urlToVersionParam, latestVersion]);

  const isPlanLoading = isVersionsLoading;

  // Get plan's latest price (for the selected version)
  const { data: planPrices } = useQuery({
    queryKey: ["plan-prices", selectedVersionId],
    queryFn: async () => {
      if (!selectedVersionId) return null;
      const response = await apiClient.prices.$get({
        query: { planId: selectedVersionId },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }
      return data.prices || [];
    },
    enabled: !!selectedVersionId,
    staleTime: 5 * 60 * 1000, // 5 minutes - don't refetch unless data is actually stale
    refetchOnWindowFocus: false, // Don't refetch when user focuses window
    refetchOnReconnect: false, // Don't refetch on network reconnect
    refetchInterval: false, // Don't poll
  });

  // Track if planPrices reference actually changed
  const prevPlanPricesRef = useRef(planPrices);
  prevPlanPricesRef.current = planPrices;

  // Get credit definitions for the plan to show usage-based feature amounts
  const { data: planCreditDefinitions } = useQuery({
    queryKey: ["plan-credit-definitions", selectedVersionId],
    queryFn: async () => {
      if (!selectedVersionId) return null;
      const response = await apiClient.credits.definitions.$get({
        query: { scope: "plan" },
      });
      const data = await response.json();
      if ("error" in data) {
        console.error("Error fetching credit definitions:", data.error);
        return [];
      }
      // Filter for this specific plan version
      return data.definitions.filter((def) => def.planId === selectedVersionId);
    },
    enabled: !!selectedVersionId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });

  // Get trial plan information if it exists
  const { data: trialPlan } = useQuery({
    queryKey: ["trial-plan", selectedVersionId],
    queryFn: async () => {
      if (!selectedVersionId) return null;
      try {
        // Look for a trial plan that has this plan as its parent
        const trialResponse = await apiClient.plans.$get({
          query: { includeTrials: "true", includeFeatures: "true" },
        });
        const trialData = await trialResponse.json();

        if ("plans" in trialData && Array.isArray(trialData.plans)) {
          const trialPlan = trialData.plans.find(
            (p) => p.isTrialPlan && p.trialParentPlanId === selectedVersionId
            // manual typing needed because of union types - type inference is picking up the wrong part of the union
          ) as APIPlanWithFeatures | null;
          return trialPlan || null;
        }
        return null;
      } catch (err) {
        console.error("Error fetching trial plan data:", err);
        return null;
      }
    },
    enabled: !!selectedVersionId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });

  // Get trial credit definitions if trial plan exists
  const { data: trialCreditDefinitions } = useQuery({
    queryKey: ["trial-credit-definitions", trialPlan?.id],
    queryFn: async () => {
      if (!trialPlan?.id) return null;
      const response = await apiClient.credits.definitions.$get({
        query: { scope: "plan" },
      });
      const data = await response.json();
      if ("error" in data) {
        console.error("Error fetching trial credit definitions:", data.error);
        return [];
      }
      // Filter for the trial plan
      return data.definitions.filter((def) => def.planId === trialPlan.id);
    },
    enabled: !!trialPlan?.id,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });

  // Deduplicate credit definitions to avoid duplicates when the only difference is price linkage fields
  const dedupedCreditDefinitions = useMemo(() => {
    if (!planCreditDefinitions) return [];
    const seen = new Set<string>();
    return planCreditDefinitions.filter((def) => {
      const key = `${def.featureId}-${def.applicationType}-${def.defaultAmount}-${def.currency || ""}-${def.refillRrule || ""}-${def.refillAmount || ""}`;
      if (seen.has(key)) {
        return false; // duplicate
      }
      seen.add(key);
      return true;
    });
  }, [planCreditDefinitions]);

  // Deduplicate trial credit definitions
  const dedupedTrialCreditDefinitions = useMemo(() => {
    if (!trialCreditDefinitions) return [];
    const seen = new Set<string>();
    return trialCreditDefinitions.filter((def) => {
      const key = `${def.featureId}-${def.applicationType}-${def.defaultAmount}-${def.currency || ""}-${def.refillRrule || ""}-${def.refillAmount || ""}`;
      if (seen.has(key)) {
        return false; // duplicate
      }
      seen.add(key);
      return true;
    });
  }, [trialCreditDefinitions]);

  // Get all subscriptions and filter by plan
  const { data: allSubscriptions, isLoading: isSubscriptionsLoading } =
    useQuery({
      queryKey: ["subscriptions"],
      queryFn: async () => {
        const response = await apiClient.subscriptions.$get({
          query: { includeFeatures: "false" },
        });
        const data = await response.json();
        if ("error" in data) {
          throw new Error(String(data.error));
        }
        return data.subscriptions || [];
      },
      staleTime: 2 * 60 * 1000, // 2 minutes (subscriptions change more frequently)
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchInterval: false,
    });

  // Get scheduled migrations for this plan (outgoing)
  const { data: scheduledMigrations } = useQuery({
    queryKey: ["scheduled-migrations", plan?.stablePlanId, selectedVersionId],
    queryFn: async () => {
      if (!selectedVersionId) return [];

      const response = await apiClient.plans[":planId"][
        "scheduled-migrations"
      ].$get({
        param: { planId: selectedVersionId },
      });
      const data = await response.json();
      if ("error" in data) {
        console.error("Error fetching scheduled migrations:", data.error);
        return [];
      }
      return data.scheduledMigrations || [];
    },
    enabled: !!selectedVersionId,
  });

  // Get incoming scheduled migrations for this plan (incoming)
  const { data: incomingMigrations } = useQuery({
    queryKey: ["incoming-migrations", plan?.stablePlanId, selectedVersionId],
    queryFn: async () => {
      if (!selectedVersionId) return [];

      const response = await apiClient.plans[":planId"][
        "incoming-migrations"
      ].$get({
        param: { planId: selectedVersionId },
      });
      const data = await response.json();
      if ("error" in data) {
        console.error("Error fetching incoming migrations:", data.error);
        return [];
      }
      return data.incomingMigrations || [];
    },
    enabled: !!selectedVersionId,
  });

  // Get pricing tables that contain this plan (using selected version)
  const { data: pricingTablesWithPlan } = useQuery({
    queryKey: ["pricing-tables-with-plan", selectedVersionId],
    queryFn: async () => {
      if (!selectedVersionId) return [];
      const response = await apiClient["pricing-tables"].$get();
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }
      // Filter pricing tables that contain this plan version
      return (data.pricingTables || []).filter(
        (table: { pricingTablePlans?: { planId: string }[] }) =>
          table.pricingTablePlans?.some(
            (ptp: { planId: string }) => ptp.planId === selectedVersionId
          )
      );
    },
    enabled: !!selectedVersionId,
  });

  // Get detailed pricing table data if this plan is in a pricing table
  const { data: pricingTableData } = useQuery({
    queryKey: ["pricing-table-detail", pricingTablesWithPlan?.[0]?.id],
    queryFn: async () => {
      if (!pricingTablesWithPlan?.[0]?.id) return null;
      const response = await apiClient["pricing-tables"][":id"].$get({
        param: { id: pricingTablesWithPlan[0].id },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error);
      }
      return data.pricingTable;
    },
    enabled: !!pricingTablesWithPlan?.[0]?.id,
  });

  // Filter subscriptions by current plan version
  const planSubscriptions = useMemo(() => {
    if (!allSubscriptions || !selectedVersionId) return [];
    return allSubscriptions.filter((sub) => sub.planId === selectedVersionId);
  }, [allSubscriptions, selectedVersionId]);

  // Determine if the selected plan version can be deleted (latest version & no subscribers)
  const canDeletePlan =
    selectedVersionId === latestVersion?.id && planSubscriptions.length === 0;

  // Get active subscription count for migration analysis (across all versions)
  const activeSubscriptionCount = useMemo(() => {
    if (!allSubscriptions || !plan?.stablePlanId) return 0;
    // Count all active subscriptions across all versions of this plan
    return allSubscriptions.filter((sub) => {
      // Find the plan version for this subscription
      const subPlanVersion = allPlanVersions?.find((v) => v.id === sub.planId);
      return (
        subPlanVersion?.stablePlanId === plan.stablePlanId &&
        !sub.endTimestamp && // Active subscriptions
        !sub.deletedAt
      ); // Not soft-deleted
    }).length;
  }, [allSubscriptions, plan, allPlanVersions]);

  // -------- Migration Helper Computations ---------
  // Determine previous (source) and latest (target) version numbers and build default price mapping

  const previousVersionNumber = useMemo(() => {
    const parsed = urlFromVersionParam ? Number(urlFromVersionParam) : NaN;
    if (!Number.isNaN(parsed)) return parsed;
    if (!allPlanVersions || allPlanVersions.length < 2) {
      return latestVersion?.versionNumber || 0;
    }
    return allPlanVersions[1].versionNumber;
  }, [urlFromVersionParam, allPlanVersions, latestVersion]);

  // Build price mapping asynchronously once versions are available
  const [computedPriceMapping, setComputedPriceMapping] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    interface PriceDTO {
      id: string;
      currency: string;
      pricingData: {
        components: {
          component_name: string;
          type: string;
          amount_cents?: number;
        }[];
      };
    }

    const buildMapping = async () => {
      if (!allPlanVersions || !previousVersionNumber || !targetVersionNumber)
        return;

      const sourcePlan = allPlanVersions.find(
        (p) => p.versionNumber === previousVersionNumber
      );
      const targetPlan = allPlanVersions.find(
        (p) => p.versionNumber === targetVersionNumber
      );

      if (!sourcePlan || !targetPlan) return;

      const [sourcePricesRes, targetPricesRes] = await Promise.all([
        apiClient.prices.$get({ query: { planId: sourcePlan.id } }),
        apiClient.prices.$get({ query: { planId: targetPlan.id } }),
      ]);

      const [sourcePricesBody, targetPricesBody] = await Promise.all([
        sourcePricesRes.json(),
        targetPricesRes.json(),
      ]);

      if (
        "error" in sourcePricesBody ||
        "error" in targetPricesBody ||
        !Array.isArray(sourcePricesBody.prices) ||
        !Array.isArray(targetPricesBody.prices)
      ) {
        return;
      }

      const sourcePrices = sourcePricesBody.prices as PriceDTO[];
      const targetPrices = targetPricesBody.prices as PriceDTO[];

      const mapping: Record<string, string> = {};

      const hasComponent = (price: PriceDTO, name: string) =>
        price.pricingData.components?.some((c) => c.component_name === name);

      for (const src of sourcePrices) {
        if (hasComponent(src, "monthly")) {
          const tgt = targetPrices.find((p) => hasComponent(p, "monthly"));
          if (tgt) mapping[src.id] = tgt.id;
          continue;
        }
        if (hasComponent(src, "annual")) {
          const tgt = targetPrices.find((p) => hasComponent(p, "annual"));
          if (tgt) mapping[src.id] = tgt.id;
          continue;
        }
        // fallback by currency
        const tgt = targetPrices.find((p) => p.currency === src.currency);
        if (tgt) mapping[src.id] = tgt.id;
      }

      setComputedPriceMapping(mapping);
    };

    buildMapping();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allPlanVersions]);

  // Customer table
  const customerTable = useReactTable({
    data: planSubscriptions as SubscriptionWithCustomer[],
    columns: customerColumns,
    onSortingChange: setCustomerSorting,
    onColumnFiltersChange: setCustomerColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setCustomerColumnVisibility,
    onRowSelectionChange: setCustomerRowSelection,
    onPaginationChange: setCustomerPagination,
    state: {
      sorting: customerSorting,
      columnFilters: customerColumnFilters,
      columnVisibility: customerColumnVisibility,
      rowSelection: customerRowSelection,
      pagination: customerPagination,
    },
  });

  // Helper function to format currency
  const formatCurrency = (amountCents: number, currency: string) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amountCents / 100);
  };

  // Helper function to format recurrence
  const formatRecurrence = (recurrence?: string) => {
    if (!recurrence) return "One-time";
    if (recurrence.toLowerCase().includes("month")) return "Monthly";
    if (recurrence.toLowerCase().includes("year")) return "Yearly";
    if (recurrence.toLowerCase().includes("week")) return "Weekly";
    if (recurrence.toLowerCase().includes("day")) return "Daily";
    return recurrence;
  };

  // Helper function to get feature type display
  const getFeatureTypeDisplay = (feature: APIFeature) => {
    if (typeof feature.featureValue === "boolean") {
      return {
        type: "Feature",
        icon: "toggle",
        color: "text-slate-600",
        bgColor: "bg-white border-slate-200",
      };
    } else if (typeof feature.featureValue === "number") {
      return {
        type: "Usage Limit",
        icon: "meter",
        color: "text-slate-600",
        bgColor: "bg-white border-slate-200",
      };
    } else {
      return {
        type: "Configuration",
        icon: "settings",
        color: "text-slate-600",
        bgColor: "bg-white border-slate-200",
      };
    }
  };

  // Helper function to get component amount
  const getComponentAmount = (component: PricingComponent): number => {
    return (
      component.amount_cents ??
      component.per_unit_cents ??
      component.unit_cost_cents ??
      0
    );
  };

  // Helper function to get component label
  const getComponentLabel = (component: PricingComponent): string => {
    if (component.type === "per_unit" && component.unit_label) {
      return `per ${component.unit_label}`;
    }
    if (component.per_unit_cents) return "per unit";
    if (component.unit_cost_cents && component.unit_label)
      return `per ${component.unit_label}`;
    return "";
  };

  // Helper function to determine the currency (for trial pricing)
  const getCurrency = (): string => {
    // First try to get currency from plan prices
    if (planPrices && planPrices.length > 0) {
      return planPrices[0].currency;
    }
    // Fallback to merchant's default currency
    return session?.merchant?.defaultCurrency || "USD";
  };

  // Memoize the transformed plan data for pricing table preview
  const transformedPlanData = useMemo(() => {
    if (!plan || !planPrices) return null;
    return transformPlanForPricingTable(
      plan,
      planPrices,
      dedupedCreditDefinitions || [],
      trialPlan,
      dedupedTrialCreditDefinitions || []
    );
  }, [
    plan,
    planPrices,
    dedupedCreditDefinitions,
    trialPlan,
    dedupedTrialCreditDefinitions,
  ]);

  // Memoize the plans array to prevent re-renders
  const pricingTablePlans = useMemo(() => {
    return transformedPlanData ? [transformedPlanData] : [];
  }, [transformedPlanData]);

  // Memoize the setSelectedPlan function
  const handlePlanSelection = useCallback(() => {
    // Handle plan selection if needed - for preview purposes, we don't need to do anything
  }, []);

  // -------- Migration analysis --------
  interface MigrationAnalysis {
    hasFeatureChanges: boolean;
    hasPriceChanges: boolean;
    hasNumericFeatureChanges: boolean;
    recommendedStrategy: "immediate" | "next_billing_cycle" | "edit_in_place";
    canUseImmediate: boolean;
  }

  const [migrationAnalysis, setMigrationAnalysis] =
    useState<MigrationAnalysis | null>(null);

  useEffect(() => {
    const fetchAnalysis = async () => {
      if (
        !showMigrationModal ||
        migrationAnalysis ||
        !plan?.stablePlanId ||
        previousVersionNumber === 0 ||
        targetVersionNumber === 0
      ) {
        return;
      }

      try {
        const apiUrl = process.env.NEXT_PUBLIC_API_URL;
        if (!apiUrl) return;

        const resp = await fetch(
          `${apiUrl}/v1/plans/${plan.stablePlanId}/compare?fromVersion=${previousVersionNumber}&toVersion=${targetVersionNumber}`,
          {
            credentials: "include",
          }
        );
        const data = await resp.json();
        if (resp.ok && data.migrationAnalysis) {
          setMigrationAnalysis(data.migrationAnalysis as MigrationAnalysis);
        } else {
          console.error("Failed to load migration analysis", data.error);
        }
      } catch (err) {
        console.error("Migration analysis fetch error", err);
      }
    };

    fetchAnalysis();
  }, [
    showMigrationModal,
    migrationAnalysis,
    plan?.stablePlanId,
    previousVersionNumber,
    targetVersionNumber,
  ]);

  // Fallback stub to ensure component renders
  const effectiveMigrationAnalysis: MigrationAnalysis = migrationAnalysis ?? {
    hasFeatureChanges: true,
    hasPriceChanges: false,
    hasNumericFeatureChanges:
      plan?.features?.some((f) => typeof f.featureValue === "number") || false,
    recommendedStrategy: "immediate",
    canUseImmediate: true,
  };

  // Helper types for scheduled migration items and subscriptions that may
  // contain a stableSubscriptionId.
  type ScheduledMigrationItem = {
    subscriptionId: string;
    subscription?: {
      id: string;
      stableSubscriptionId?: string;
    };
  };

  type SubscriptionWithStableId = SubscriptionWithCustomer & {
    stableSubscriptionId?: string;
  };

  // Build a set of stable subscription IDs that already have a migration
  const scheduledStableIds: Set<string> = useMemo(() => {
    const ids = new Set<string>();
    (scheduledMigrations as ScheduledMigrationItem[] | undefined)?.forEach(
      (m) => {
        ids.add(m.subscription?.stableSubscriptionId ?? m.subscriptionId);
      }
    );
    return ids;
  }, [scheduledMigrations]);

  const subscribersWithoutScheduledMigrations = (
    planSubscriptions as SubscriptionWithStableId[]
  ).filter(
    (sub) => !scheduledStableIds.has(sub.stableSubscriptionId ?? sub.id)
  );

  // Determine if migration button should be shown
  const shouldShowMigrationButton = useMemo(() => {
    if (!plan || !allPlanVersions || !latestVersion) return false;

    // There must be at least two versions to migrate between
    if (allPlanVersions.length < 2) return false;

    // Only show if there are subscribers on this version
    if (planSubscriptions.length === 0) return false;

    // Only show if the selected version is not the latest version (there are newer versions to migrate to)
    if (selectedVersionId === latestVersion?.id) return false;

    return subscribersWithoutScheduledMigrations.length > 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    plan,
    allPlanVersions,
    latestVersion,
    selectedVersionId,
    planSubscriptions,
    scheduledMigrations,
  ]);

  if (isPlanLoading) {
    return <div>Loading...</div>;
  }

  console.log("🎨 About to render JSX - Final state:", {
    planId: plan?.id,
    pricingTablePlansLength: pricingTablePlans.length,
    hasTransformedData: !!transformedPlanData,
  });

  return (
    <div className="container mx-auto py-10">
      <div className="flex justify-between items-center mb-10">
        <Button variant="outline" onClick={() => router.back()}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
          <kbd className="ml-2 inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
            ESC
          </kbd>
        </Button>
        <div className="flex gap-2">
          {selectedVersionId && selectedVersionId !== latestVersion?.id ? (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={-1} className="inline-block">
                    <Button variant="outline" disabled>
                      <Edit className="mr-2 h-4 w-4" />
                      Edit Plan
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>You can only edit the latest version of the plan</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Button
              variant="outline"
              onClick={() => router.push(`/plans/${selectedVersionId}/edit`)}
              disabled={!selectedVersionId}
            >
              <Edit className="mr-2 h-4 w-4" />
              Edit Plan
            </Button>
          )}
          {shouldShowMigrationButton && (
            <Button
              variant="outline"
              onClick={() => setShowMigrationModal(true)}
              disabled={!plan?.stablePlanId}
              className="border-blue-200 text-blue-700 hover:bg-blue-50 hover:border-blue-300"
            >
              <Edit className="mr-2 h-4 w-4" />
              Migrate Subscribers
            </Button>
          )}
          {canDeletePlan ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Plan
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This action cannot be undone. The plan version and all
                    associated data will be permanently deleted.
                    {incomingMigrations && incomingMigrations.length > 0 && (
                      <div className="mt-4 p-3 border border-amber-300 bg-amber-50 rounded text-sm text-amber-800">
                        Warning: There are currently {incomingMigrations.length}{" "}
                        subscription{incomingMigrations.length !== 1 ? "s" : ""}{" "}
                        scheduled to migrate <strong>into</strong> this version.
                        Deleting it will automatically cancel those migrations.
                      </div>
                    )}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <Button
                    variant="destructive"
                    onClick={() => deletePlanMutation.mutate()}
                    disabled={deletePlanMutation.isPending}
                  >
                    {deletePlanMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Deleting...
                      </>
                    ) : (
                      <>
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </>
                    )}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={-1} className="inline-block">
                    <Button variant="destructive" disabled>
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete Plan
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="space-y-1">
                    <p>Plan deletion is blocked because:</p>
                    <ul className="text-xs space-y-1 ml-2">
                      {selectedVersionId !== latestVersion?.id && (
                        <li>• Only the latest version can be deleted</li>
                      )}
                      {planSubscriptions.length > 0 && (
                        <li>
                          • {planSubscriptions.length} subscriber
                          {planSubscriptions.length !== 1 ? "s" : ""} on this
                          version
                        </li>
                      )}
                      {/* Incoming migrations no longer block deletion, so not listed here */}
                    </ul>
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>

      {/* Plan Header */}
      <div className="space-y-6 mb-10">
        <div>
          <div className="flex items-center gap-3 mb-3">
            <h1 className="text-3xl font-bold">{plan?.planName}</h1>
            {planPrices?.some((price) =>
              price.pricingData?.components?.some(
                (component) => component.type === "per_unit"
              )
            ) && (
              <Badge variant="secondary" className="text-xs">
                <Users className="w-3 h-3 mr-1" />
                Seat-based
              </Badge>
            )}
            {/* Free plan badge */}
            {!plan?.isEnterprisePlan &&
              planPrices &&
              isTrulyFreePlan(planPrices) && (
                <Badge
                  variant="outline"
                  className="text-xs bg-emerald-50 border-emerald-200 text-emerald-700"
                >
                  <span className="w-2 h-2 bg-emerald-500 rounded-full mr-1.5"></span>
                  Free Plan
                </Badge>
              )}
            {/* Usage-only plan badge */}
            {!plan?.isEnterprisePlan &&
              planPrices &&
              isUsageOnlyPlan(planPrices) && (
                <Badge
                  variant="outline"
                  className="text-xs bg-orange-50 border-orange-200 text-orange-700"
                >
                  <span className="w-2 h-2 bg-orange-500 rounded-full mr-1.5"></span>
                  Usage-Based
                </Badge>
              )}
            {trialPlan && (
              <Badge
                variant="outline"
                className="text-xs bg-blue-50 border-blue-200 text-blue-700"
              >
                <span className="w-2 h-2 bg-blue-500 rounded-full mr-1.5"></span>
                {trialPlan.trialDays}-day free trial
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground text-lg mb-6">
            {plan?.planDescription || "No description provided"}
          </p>

          <div className="flex flex-wrap items-center gap-3 mb-6">
            <IdBadge value={selectedVersionId || ""} />
            {allPlanVersions && allPlanVersions.length > 1 ? (
              <Select
                value={selectedVersionId}
                onValueChange={(newVersionId) => {
                  setSelectedVersionId(newVersionId);
                  // Update the URL to reflect the new version
                  // router.push(`/plans/${newVersionId}`);
                }}
              >
                <SelectTrigger className="h-7 w-auto min-w-[120px] text-xs">
                  <SelectValue placeholder="Select version" />
                </SelectTrigger>
                <SelectContent>
                  {allPlanVersions.map((version) => (
                    <SelectItem
                      key={version.id}
                      value={version.id}
                      className="text-xs"
                    >
                      Version {version.versionNumber}
                      {version.id === latestVersion?.id && " (Latest)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Badge variant="outline" className="text-xs">
                Version {plan?.versionNumber}
              </Badge>
            )}
            {plan?.isEnterprisePlan && (
              <Badge variant="secondary" className="text-xs">
                Enterprise Plan
              </Badge>
            )}
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    document
                      .getElementById("customers-section")
                      ?.scrollIntoView({
                        behavior: "smooth",
                      });
                  }}
                  className="font-medium text-blue-600 hover:text-blue-700 hover:underline cursor-pointer transition-colors"
                >
                  {planSubscriptions.length} subscriber
                  {planSubscriptions.length !== 1 ? "s" : ""} on this version
                </button>
                {((scheduledMigrations && scheduledMigrations.length > 0) ||
                  (incomingMigrations && incomingMigrations.length > 0)) && (
                  <>
                    <span className="text-gray-400">•</span>
                    <div className="flex items-center gap-2">
                      {scheduledMigrations &&
                        scheduledMigrations.length > 0 && (
                          <button
                            onClick={() => {
                              router.push(
                                `/plans/${selectedVersionId}/scheduled-migrations`
                              );
                            }}
                            className="font-medium text-amber-600 hover:text-amber-700 hover:underline cursor-pointer transition-colors"
                          >
                            {scheduledMigrations.length} scheduled to migrate
                            out
                          </button>
                        )}
                      {scheduledMigrations &&
                        scheduledMigrations.length > 0 &&
                        incomingMigrations &&
                        incomingMigrations.length > 0 && (
                          <span className="text-gray-400">•</span>
                        )}
                      {incomingMigrations && incomingMigrations.length > 0 && (
                        <button
                          onClick={() => {
                            router.push(
                              `/plans/${selectedVersionId}/scheduled-migrations?view=incoming`
                            );
                          }}
                          className="font-medium text-green-600 hover:text-green-700 hover:underline cursor-pointer transition-colors"
                        >
                          {incomingMigrations.length} scheduled to migrate in
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
              <span className="text-xs">
                Created{" "}
                {plan?.createdAt ? (
                  <LocaleAwareDate
                    date={plan.createdAt}
                    style="medium"
                    className="inline font-normal"
                  />
                ) : (
                  "-"
                )}
              </span>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <Switch
              id="pricing-table-visibility"
              checked={plan?.isVisibleInPricingTable || false}
              onCheckedChange={(checked) => {
                togglePricingTableMutation.mutate(checked);
              }}
              disabled={togglePricingTableMutation.isPending}
            />
            <Label
              htmlFor="pricing-table-visibility"
              className="text-sm font-medium"
            >
              Show in pricing table
            </Label>
            {togglePricingTableMutation.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        {/* Left Column - Plan Details */}
        <div className="xl:col-span-2 space-y-8">
          {/* Pricing & Features */}
          <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
            <div className="p-6 border-b border-slate-200 bg-slate-50/50">
              <h2 className="text-xl font-bold text-slate-900 flex items-center gap-3">
                <div className="bg-white p-2 rounded-md border border-slate-200">
                  <CreditCard className="h-5 w-5 text-slate-600" />
                </div>
                Pricing & Features
              </h2>
            </div>
            <div className="p-6 space-y-10">
              {/* Pricing Section */}
              <div>
                <h3 className="text-base font-medium text-gray-900 mb-4">
                  Pricing Configuration
                </h3>
                {plan?.isEnterprisePlan ? (
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="bg-slate-100 p-3 rounded-lg border border-slate-200">
                          <CreditCard className="h-6 w-6 text-slate-600" />
                        </div>
                        <div>
                          <h4 className="font-semibold text-slate-900 text-lg">
                            Enterprise Plan
                          </h4>
                          <p className="text-sm text-slate-600">
                            Custom pricing - contact for details
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="bg-white border border-slate-300 rounded-lg px-4 py-2 mb-2 shadow-sm">
                          <span className="font-medium text-slate-900">
                            {plan.buttonText || "Contact us"}
                          </span>
                        </div>
                        {plan.enterpriseRedirectUrl && (
                          <div>
                            <a
                              href={plan.enterpriseRedirectUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-slate-600 hover:text-slate-900 hover:underline font-medium"
                            >
                              View Contact Link →
                            </a>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Trial Price Section */}
                    {trialPlan && (
                      <div className="border border-blue-200 rounded-lg p-6 bg-blue-50/30 hover:bg-blue-50/50 transition-all duration-200">
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-3">
                            <div className="bg-blue-100 p-2 rounded-md border border-blue-200">
                              <CreditCard className="h-5 w-5 text-blue-600" />
                            </div>
                            <div>
                              <h4 className="font-semibold text-blue-900">
                                Free Trial
                              </h4>
                              <p className="text-xs text-blue-600">
                                {trialPlan.trialDays} days free access
                              </p>
                            </div>
                          </div>
                          <div className="bg-white border border-blue-200 rounded-md px-3 py-1 shadow-sm">
                            <span className="text-xs font-medium text-blue-700">
                              {planPrices?.[0]?.currency?.toUpperCase() ||
                                "USD"}
                            </span>
                          </div>
                        </div>

                        <div className="space-y-3">
                          <div className="bg-white border border-blue-200 rounded-md p-4 shadow-sm">
                            <div className="flex items-center justify-between">
                              <div className="flex-1">
                                <h5 className="text-sm font-semibold text-blue-900 mb-1">
                                  Trial Period
                                </h5>
                                <div className="bg-blue-100 border border-blue-200 rounded-md px-3 py-1.5 inline-flex items-center justify-center min-w-[80px]">
                                  <span className="text-xs font-medium text-blue-600">
                                    {trialPlan.trialDays} days
                                  </span>
                                </div>
                              </div>
                              <div className="text-right ml-4">
                                <div className="text-xl font-bold text-blue-900">
                                  {formatCurrency(0, getCurrency())}
                                </div>
                                <div className="text-xs text-blue-600 font-medium">
                                  Free trial
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {planPrices && planPrices.length > 0 ? (
                      planPrices.map((price, index) => {
                        // Check if this price has only zero-amount components
                        const isFreePriceConfig = isTrulyFreePlan([price]);
                        const isUsageOnlyConfig = isUsageOnlyPlan([price]);

                        return (
                          <div
                            key={price.id}
                            className={`border rounded-lg p-6 transition-all duration-200 ${
                              isFreePriceConfig
                                ? "border-emerald-200 bg-emerald-50/30 hover:bg-emerald-50/50"
                                : isUsageOnlyConfig
                                  ? "border-orange-200 bg-orange-50/30 hover:bg-orange-50/50"
                                  : "border-slate-200 bg-slate-50/30 hover:bg-slate-50/50"
                            }`}
                          >
                            <div className="flex items-center justify-between mb-4">
                              <div className="flex items-center gap-3">
                                <div className="bg-slate-100 p-2 rounded-md border border-slate-200">
                                  <CreditCard className="h-5 w-5 text-slate-600" />
                                </div>
                                <div>
                                  <h4
                                    className={`font-semibold ${
                                      isFreePriceConfig
                                        ? "text-emerald-700"
                                        : isUsageOnlyConfig
                                          ? "text-orange-700"
                                          : "text-slate-900"
                                    }`}
                                  >
                                    {isFreePriceConfig
                                      ? "Free Plan"
                                      : isUsageOnlyConfig
                                        ? "Usage-Based Plan"
                                        : `Price Configuration ${index + 1}`}
                                  </h4>
                                  <p
                                    className={`text-xs ${
                                      isFreePriceConfig
                                        ? "text-emerald-600"
                                        : isUsageOnlyConfig
                                          ? "text-orange-600"
                                          : "text-slate-500"
                                    }`}
                                  >
                                    {price.pricingData.components.length}{" "}
                                    component
                                    {price.pricingData.components.length !== 1
                                      ? "s"
                                      : ""}
                                    {isFreePriceConfig && " • No cost"}
                                    {isUsageOnlyConfig && " • Pay-as-you-go"}
                                  </p>
                                </div>
                              </div>
                              <div className="bg-white border border-slate-200 rounded-md px-3 py-1 shadow-sm">
                                <span className="text-xs font-medium text-slate-700">
                                  {price.currency.toUpperCase()}
                                </span>
                              </div>
                            </div>

                            <div className="space-y-3">
                              {price.pricingData.components.map(
                                (component, compIndex) => (
                                  <div
                                    key={compIndex}
                                    className="bg-white border border-slate-200 rounded-md p-4 shadow-sm"
                                  >
                                    <div className="flex items-center justify-between">
                                      <div className="flex-1">
                                        <h5 className="text-sm font-semibold text-slate-900 mb-1">
                                          {component.type === "per_unit"
                                            ? "Per Unit"
                                            : component.type === "fixed"
                                              ? "Fixed"
                                              : "Usage"}
                                        </h5>
                                        <div className="bg-slate-100 border border-slate-200 rounded-md px-3 py-1.5 inline-flex items-center justify-center min-w-[80px]">
                                          <span className="text-xs font-medium text-slate-600">
                                            {formatRecurrence(
                                              component.recurrence_rule
                                            )}
                                          </span>
                                        </div>
                                      </div>
                                      <div className="text-right ml-4">
                                        <div>
                                          {getComponentAmount(component) ===
                                          0 ? (
                                            // Free plan styling
                                            <div>
                                              <div className="text-xl font-bold text-emerald-600">
                                                Free
                                              </div>
                                              <div className="text-xs text-emerald-500 font-medium">
                                                {component.type === "per_unit"
                                                  ? `per ${component.unit_label || "seat"}`
                                                  : formatRecurrence(
                                                      component.recurrence_rule
                                                    )}
                                              </div>
                                            </div>
                                          ) : (
                                            // Paid plan styling
                                            <div>
                                              <div className="text-xl font-bold text-slate-900">
                                                {formatCurrency(
                                                  getComponentAmount(component),
                                                  price.currency
                                                )}
                                              </div>
                                              {getComponentLabel(component) && (
                                                <div className="text-xs text-slate-500 font-medium">
                                                  {getComponentLabel(component)}
                                                </div>
                                              )}
                                            </div>
                                          )}

                                          {/* Seat-based additional info */}
                                          {component.type === "per_unit" &&
                                            (() => {
                                              const perUnitComp =
                                                component as PricingComponent & {
                                                  num_seats?: number;
                                                };
                                              const numSeats =
                                                perUnitComp.num_seats;
                                              return (
                                                <>
                                                  {typeof numSeats ===
                                                    "number" &&
                                                    numSeats > 0 && (
                                                      <div className="text-xs text-slate-600 mt-1">
                                                        Minimum {numSeats}{" "}
                                                        {component.unit_label ||
                                                          "seats"}
                                                      </div>
                                                    )}
                                                  <div className="text-xs text-slate-600 mt-1">
                                                    Overage billing:{" "}
                                                    {component.bill_immediately ===
                                                    false
                                                      ? "End of cycle"
                                                      : "Immediate"}
                                                  </div>
                                                </>
                                              );
                                            })()}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                )
                              )}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="text-center py-12 text-gray-500">
                        <div className="bg-gray-50 rounded-full p-4 w-16 h-16 mx-auto mb-4 flex items-center justify-center">
                          <CreditCard className="h-8 w-8 text-gray-400" />
                        </div>
                        <p className="text-sm font-medium">
                          No pricing configured
                        </p>
                        <p className="text-xs text-gray-400 mt-1">
                          Add pricing to your plan to see it here
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Features Section */}
              <div>
                <h3 className="text-base font-medium text-gray-900 mb-4">
                  Plan Features
                </h3>
                {plan?.features && plan.features.length > 0 ? (
                  <div className="space-y-3">
                    {plan.features.map((feature, featureIndex) => {
                      const typeInfo = getFeatureTypeDisplay(feature);

                      // Find all credit definitions associated with this feature (deduplicated)
                      const featureCreditDefinitions =
                        dedupedCreditDefinitions.filter(
                          (cd) => cd.featureId === feature.id
                        );

                      // Find trial credit definitions for this feature
                      const trialFeatureCreditDefinitions =
                        dedupedTrialCreditDefinitions.filter(
                          (cd) => cd.featureId === feature.id
                        );

                      // Get the appropriate icon
                      const IconComponent =
                        typeInfo.icon === "toggle"
                          ? typeof feature.featureValue === "boolean" &&
                            feature.featureValue
                            ? ToggleRight
                            : ToggleLeft
                          : typeInfo.icon === "meter"
                            ? BarChart3
                            : Settings;

                      return (
                        <div
                          key={`${selectedVersionId}-${feature.id}-${featureIndex}`}
                          className="border border-slate-200 rounded-lg p-4 bg-white hover:bg-slate-50/30 transition-all duration-200"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3 flex-1 min-w-0">
                              <div className="p-1.5 rounded-md bg-slate-100">
                                <IconComponent
                                  className={`h-3.5 w-3.5 ${typeInfo.color}`}
                                />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <h4 className="font-medium text-slate-900 text-sm">
                                    {feature.displayName}
                                  </h4>
                                  <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                                    {typeInfo.type}
                                  </span>
                                </div>
                                <div className="flex items-center gap-3">
                                  <code className="text-xs bg-slate-100 px-2 py-0.5 rounded font-mono text-slate-600">
                                    {feature.slug}
                                  </code>
                                  {feature.metricIds &&
                                    feature.metricIds.length > 0 && (
                                      <div className="flex items-center gap-1">
                                        <BarChart3 className="h-3 w-3 text-slate-400" />
                                        <span className="text-xs text-slate-600">
                                          {feature.metricIds.length} metric
                                          {feature.metricIds.length !== 1
                                            ? "s"
                                            : ""}
                                        </span>
                                      </div>
                                    )}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center">
                              {featureCreditDefinitions.length > 0 ||
                              trialFeatureCreditDefinitions.length > 0 ? (
                                // Show credit information with better styling
                                <div className="flex gap-2">
                                  {/* Regular plan credit definitions */}
                                  {featureCreditDefinitions.map(
                                    (creditDef, creditIndex) => {
                                      // Determine refresh schedule
                                      const getRefreshLabel = () => {
                                        if (creditDef.renewOnBilling) {
                                          return "Per billing cycle";
                                        }
                                        if (creditDef.refillRrule) {
                                          const rule =
                                            creditDef.refillRrule.toLowerCase();
                                          if (rule.includes("month"))
                                            return "Monthly";
                                          if (rule.includes("year"))
                                            return "Yearly";
                                          if (rule.includes("week"))
                                            return "Weekly";
                                          if (rule.includes("day"))
                                            return "Daily";
                                          return "Periodic";
                                        }
                                        if (
                                          creditDef.refillAmount &&
                                          creditDef.refillAmount > 0
                                        ) {
                                          return "Renewable";
                                        }
                                        return null;
                                      };

                                      const refreshLabel = getRefreshLabel();

                                      return (
                                        <div
                                          key={`${creditDef.id}-${creditIndex}`}
                                          className={`rounded-md px-3 py-2 text-center min-w-[100px] border ${
                                            creditDef.applicationType ===
                                            "usage"
                                              ? "bg-blue-50 border-blue-200"
                                              : creditDef.applicationType ===
                                                  "monetary"
                                                ? "bg-emerald-50 border-emerald-200"
                                                : creditDef.applicationType ===
                                                    "component"
                                                  ? "bg-purple-50 border-purple-200"
                                                  : "bg-slate-100 border-slate-200"
                                          }`}
                                        >
                                          {creditDef.applicationType ===
                                          "usage" ? (
                                            <>
                                              <div className="text-lg font-semibold text-blue-700">
                                                {creditDef.defaultAmount.toLocaleString()}
                                              </div>
                                              <div className="text-xs text-blue-600">
                                                credits
                                                {refreshLabel && (
                                                  <span className="block text-blue-500">
                                                    {refreshLabel}
                                                  </span>
                                                )}
                                              </div>
                                            </>
                                          ) : creditDef.applicationType ===
                                            "monetary" ? (
                                            <>
                                              <div className="text-lg font-semibold text-emerald-700">
                                                {creditDef.currency === "USD"
                                                  ? "$"
                                                  : "€"}
                                                {(
                                                  creditDef.defaultAmount / 100
                                                ).toFixed(2)}
                                              </div>
                                              <div className="text-xs text-emerald-600">
                                                discount
                                                {refreshLabel && (
                                                  <span className="block text-emerald-500">
                                                    {refreshLabel}
                                                  </span>
                                                )}
                                              </div>
                                            </>
                                          ) : creditDef.applicationType ===
                                            "component" ? (
                                            <>
                                              <div className="text-lg font-semibold text-purple-700">
                                                {creditDef.currency === "USD"
                                                  ? "$"
                                                  : "€"}
                                                {(
                                                  creditDef.defaultAmount / 100
                                                ).toFixed(2)}
                                              </div>
                                              <div className="text-xs text-purple-600">
                                                component
                                                {refreshLabel && (
                                                  <span className="block text-purple-500">
                                                    {refreshLabel}
                                                  </span>
                                                )}
                                              </div>
                                            </>
                                          ) : (
                                            <div className="text-sm font-medium text-slate-700">
                                              {creditDef.applicationType}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    }
                                  )}

                                  {/* Trial credit definitions */}
                                  {trialFeatureCreditDefinitions.map(
                                    (trialCreditDef, trialCreditIndex) => {
                                      return (
                                        <div
                                          key={`trial-${trialCreditDef.id}-${trialCreditIndex}`}
                                          className="rounded-md px-3 py-2 text-center min-w-[100px] border bg-yellow-50 border-yellow-200"
                                        >
                                          <div className="text-lg font-semibold text-yellow-700">
                                            {trialCreditDef.defaultAmount.toLocaleString()}
                                          </div>
                                          <div className="text-xs text-yellow-600">
                                            trial credits
                                            <span className="block text-yellow-500 text-[10px]">
                                              {trialPlan?.trialDays}-day trial
                                            </span>
                                          </div>
                                        </div>
                                      );
                                    }
                                  )}
                                </div>
                              ) : typeof feature.featureValue === "boolean" ? (
                                <div
                                  className={`rounded-md px-3 py-2 text-center min-w-[80px] border ${
                                    feature.featureValue
                                      ? "bg-emerald-50 border-emerald-200"
                                      : "bg-slate-100 border-slate-200"
                                  }`}
                                >
                                  <div className="flex items-center justify-center gap-1.5">
                                    <div
                                      className={`w-2 h-2 rounded-full ${feature.featureValue ? "bg-emerald-500" : "bg-slate-300"}`}
                                    ></div>
                                    <span
                                      className={`font-medium text-sm ${feature.featureValue ? "text-emerald-700" : "text-slate-600"}`}
                                    >
                                      {feature.featureValue ? "On" : "Off"}
                                    </span>
                                  </div>
                                </div>
                              ) : feature.featureValue === "usage_based" ? (
                                <div className="bg-slate-100 border border-slate-200 rounded-md px-3 py-2 text-center min-w-[80px]">
                                  <div className="text-sm font-medium text-slate-900">
                                    Metered
                                  </div>
                                </div>
                              ) : (
                                <div className="bg-slate-100 border border-slate-200 rounded-md px-3 py-2 text-center min-w-[80px]">
                                  <div className="text-sm font-medium text-slate-900">
                                    {String(feature.featureValue)}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500">
                    <div className="bg-gray-50 rounded-full p-4 w-16 h-16 mx-auto mb-4 flex items-center justify-center">
                      <Zap className="h-8 w-8 text-gray-400" />
                    </div>
                    <p className="text-sm font-medium">
                      No features configured
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      Add features to your plan to see them here
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Subscribed Customers Section */}
          <div
            className="bg-white rounded-lg border border-slate-200 shadow-sm"
            id="customers-section"
          >
            <div className="p-6 border-b border-slate-200 bg-slate-50/50">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-slate-900 flex items-center gap-3">
                  <div className="bg-white p-2 rounded-md border border-slate-200">
                    <Users className="h-5 w-5 text-slate-600" />
                  </div>
                  Customers ({planSubscriptions.length})
                </h2>
                <Button
                  size="sm"
                  onClick={() => router.push("/subscriptions/create")}
                  className="bg-blue-600 hover:bg-blue-700 text-white"
                >
                  Add Customer
                </Button>
              </div>
            </div>
            <div className="p-6">
              {isSubscriptionsLoading ? (
                <div className="space-y-4">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <Skeleton key={index} className="h-12 w-full" />
                  ))}
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="flex items-center space-x-4">
                    <Input
                      placeholder="Filter customers..."
                      value={customerTable.getState().globalFilter ?? ""}
                      onChange={(event) =>
                        customerTable.setGlobalFilter(event.target.value)
                      }
                      className="max-w-sm"
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm">
                          Columns <ChevronDown className="ml-2 h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {customerTable
                          .getAllColumns()
                          .filter((column) => column.getCanHide())
                          .map((column) => {
                            return (
                              <DropdownMenuCheckboxItem
                                key={column.id}
                                className="capitalize"
                                checked={column.getIsVisible()}
                                onCheckedChange={(value) =>
                                  column.toggleVisibility(!!value)
                                }
                              >
                                {column.id}
                              </DropdownMenuCheckboxItem>
                            );
                          })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="rounded-lg border border-gray-200 overflow-hidden">
                    <Table>
                      <TableHeader>
                        {customerTable.getHeaderGroups().map((headerGroup) => (
                          <TableRow key={headerGroup.id} className="bg-gray-50">
                            {headerGroup.headers.map((header) => {
                              return (
                                <TableHead
                                  key={header.id}
                                  className="font-medium"
                                >
                                  {header.isPlaceholder
                                    ? null
                                    : flexRender(
                                        header.column.columnDef.header,
                                        header.getContext()
                                      )}
                                </TableHead>
                              );
                            })}
                          </TableRow>
                        ))}
                      </TableHeader>
                      <TableBody>
                        {customerTable.getRowModel().rows?.length ? (
                          customerTable.getRowModel().rows.map((row) => (
                            <TableRow
                              key={row.id}
                              data-state={row.getIsSelected() && "selected"}
                              className="hover:bg-gray-50"
                            >
                              {row.getVisibleCells().map((cell) => (
                                <TableCell key={cell.id}>
                                  {flexRender(
                                    cell.column.columnDef.cell,
                                    cell.getContext()
                                  )}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))
                        ) : (
                          <TableRow>
                            <TableCell
                              colSpan={customerColumns.length}
                              className="h-24 text-center"
                            >
                              <div className="flex flex-col items-center justify-center text-gray-500">
                                <Users className="h-8 w-8 mb-2 opacity-50" />
                                <p className="text-sm">
                                  No customers subscribed to this plan
                                </p>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                  {customerTable.getRowModel().rows?.length > 0 && (
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-gray-500">
                        {
                          customerTable.getFilteredSelectedRowModel().rows
                            .length
                        }{" "}
                        of {customerTable.getFilteredRowModel().rows.length}{" "}
                        row(s) selected
                      </div>
                      <div className="flex items-center space-x-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => customerTable.previousPage()}
                          disabled={!customerTable.getCanPreviousPage()}
                        >
                          Previous
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => customerTable.nextPage()}
                          disabled={!customerTable.getCanNextPage()}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column - Live Preview */}
        <div className="xl:col-span-1">
          <div>
            <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
              <div className="p-6 border-b border-slate-200 bg-slate-50/50">
                <h2 className="text-xl font-bold text-slate-900">
                  Live Preview
                </h2>
                <p className="text-sm text-slate-600 mt-1">
                  How this plan appears in pricing tables
                </p>
                <div className="mt-3">
                  {pricingTableData && pricingTablesWithPlan?.length ? (
                    <div className="inline-flex items-center gap-2 px-3 py-2 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded-md font-medium">
                      <div className="w-2 h-2 bg-emerald-500 rounded-full"></div>
                      Plan is visible in pricing table
                    </div>
                  ) : (
                    <div className="inline-flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 text-amber-700 text-xs rounded-md font-medium">
                      <div className="w-2 h-2 bg-amber-500 rounded-full"></div>
                      Plan is not visible in pricing table
                    </div>
                  )}
                </div>
              </div>
              <div className="p-6">
                <div className="w-full max-w-sm mx-auto xl:max-w-none">
                  {pricingTablePlans.length > 0 &&
                    (() => {
                      return (
                        <PricingTableCards
                          plans={pricingTablePlans}
                          setSelectedPlan={handlePlanSelection}
                        />
                      );
                    })()}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Migration Modal */}
      <PlanMigrationModal
        isOpen={showMigrationModal && migrationAnalysis !== null}
        onClose={() => setShowMigrationModal(false)}
        stablePlanId={plan?.stablePlanId || ""}
        activeSubscriptionsCount={activeSubscriptionCount}
        fromVersion={previousVersionNumber}
        toVersion={targetVersionNumber}
        priceMapping={computedPriceMapping}
        migrationAnalysis={effectiveMigrationAnalysis}
      />
    </div>
  );
}

// Helper function to transform plan data for PricingTableCards
const transformPlanForPricingTable = (
  plan: APIPlanWithFeatures,
  planPrices: Array<{
    id: string;
    currency: string;
    pricingData: {
      components: PricingComponent[];
    };
  }>,
  creditDefinitions: Array<{
    featureId: string | null;
    defaultAmount: number;
    refillRrule?: string | null;
    [key: string]: unknown;
  }>,
  trialPlan?: APIPlanWithFeatures | null,
  trialCreditDefinitions?: Array<{
    featureId: string | null;
    defaultAmount: number;
    refillRrule?: string | null;
    [key: string]: unknown;
  }>
): {
  title: string;
  description: string;
  price: number;
  priceMonthly: number;
  priceYearly: number;
  currency: string;
  interval: string;
  features: Array<{ text: string }>;
  buttonText: string;
  buttonOutline: boolean;
  isPopular: boolean;
  popularText: string;
  planId: string;
  priceId?: string;
  priceIdMonthly?: string;
  priceIdYearly?: string;
  pricingData?: {
    components: PricingComponent[];
  };

  isEnterprisePlan: boolean;
  enterpriseRedirectUrl?: string;
  minSeats?: number;
  trial?: {
    available: boolean;
    days: number;
    trialPlanId: string;
  };
} => {
  // Get price amounts from pricing data components
  let priceMonthly = 0;
  let priceYearly = 0;
  let priceAmount = 0;
  let priceInterval = "month";
  let priceIdMonthly: string | undefined;
  let priceIdYearly: string | undefined;

  // Process all prices for this plan to find monthly and yearly pricing
  if (!plan.isEnterprisePlan && planPrices && planPrices.length > 0) {
    planPrices.forEach((price) => {
      if (
        price &&
        price.pricingData &&
        price.pricingData.components &&
        price.pricingData.components.length > 0
      ) {
        // Look for fixed or per_unit components in this price to determine if it's monthly or yearly
        for (const component of price.pricingData.components) {
          if (
            (component.type === "fixed" || component.type === "per_unit") &&
            "amount_cents" in component &&
            component.amount_cents
          ) {
            let recurrence = "";

            // Handle different components having different recurrence fields
            if (
              "recurrence_rule" in component &&
              typeof component.recurrence_rule === "string"
            ) {
              recurrence = component.recurrence_rule.toLowerCase();
            } else if (
              "billing_cycle" in component &&
              typeof component.billing_cycle === "string"
            ) {
              recurrence = component.billing_cycle.toLowerCase();
            }

            // Assign price based on recurrence - each price object typically has one billing frequency
            if (recurrence.includes("month") && priceMonthly === 0) {
              priceMonthly = component.amount_cents;
              priceIdMonthly = price.id;
            } else if (recurrence.includes("year") && priceYearly === 0) {
              priceYearly = component.amount_cents;
              priceIdYearly = price.id;
            } else if (priceAmount === 0) {
              // Use the first component as fallback
              priceAmount = component.amount_cents;
              priceInterval = recurrence || "month";
            }

            // Break after finding the first fixed/per_unit component in this price
            break;
          }
        }
      }
    });
  }

  const latestPrice = planPrices[0];
  // If no specific monthly/yearly pricing found, use the first component
  if (
    latestPrice &&
    priceMonthly === 0 &&
    priceYearly === 0 &&
    priceAmount === 0
  ) {
    const firstComponent = latestPrice.pricingData.components[0];
    if ("amount_cents" in firstComponent && firstComponent.amount_cents) {
      priceAmount = firstComponent.amount_cents;

      if (
        "recurrence_rule" in firstComponent &&
        typeof firstComponent.recurrence_rule === "string"
      ) {
        priceInterval = firstComponent.recurrence_rule.toLowerCase();
      } else if (
        "billing_cycle" in firstComponent &&
        typeof firstComponent.billing_cycle === "string"
      ) {
        priceInterval = firstComponent.billing_cycle.toLowerCase();
      }
    }
  }

  let minSeats: number | undefined;
  if (planPrices) {
    for (const price of planPrices) {
      const comp = price.pricingData?.components?.find(
        (c) =>
          c.type === "per_unit" &&
          typeof (c as unknown as Record<string, unknown>)["num_seats"] ===
            "number"
      );
      if (comp) {
        const ns = (comp as unknown as Record<string, unknown>)[
          "num_seats"
        ] as number;
        if (ns > 0) {
          minSeats = ns;
          break;
        }
      }
    }
  }

  // Check if this is a free plan (all components are $0)
  const isFreeBasePlan = !plan.isEnterprisePlan && isTrulyFreePlan(planPrices);
  const isUsageOnlyBasePlan =
    !plan.isEnterprisePlan && isUsageOnlyPlan(planPrices);

  return {
    title: plan.planName,
    description: plan.planDescription || "",
    price: plan.isEnterprisePlan ? 0 : priceAmount / 100, // Convert cents to dollars/euros
    priceMonthly: plan.isEnterprisePlan ? 0 : priceMonthly / 100, // Convert cents to dollars/euros
    priceYearly: plan.isEnterprisePlan
      ? 0
      : priceYearly
        ? priceYearly / 100
        : priceMonthly
          ? (priceMonthly * 12) / 100
          : 0, // Convert cents to dollars/euros
    currency: (latestPrice?.currency || "usd").toLowerCase(),
    interval: isFreeBasePlan
      ? "free"
      : isUsageOnlyBasePlan
        ? "usage-based"
        : planPrices?.some((price) =>
              price.pricingData?.components?.some(
                (component) => component.type === "per_unit"
              )
            )
          ? " month per seat"
          : priceInterval.toLowerCase(),
    ...(minSeats ? { minSeats } : {}),
    features: plan.features.map((feature) => {
      let featureText = feature.displayName;

      // Add credit allowance information from plan's credit definitions
      const creditDef = creditDefinitions.find(
        (cd) => cd.featureId === feature.id
      );
      if (
        creditDef &&
        typeof creditDef.defaultAmount === "number" &&
        creditDef.defaultAmount > 0
      ) {
        let renewal: "monthly" | "yearly" | "none" = "none";
        if (creditDef.refillRrule?.includes("MONTHLY")) {
          renewal = "monthly";
        } else if (creditDef.refillRrule?.includes("YEARLY")) {
          renewal = "yearly";
        }

        if (renewal === "monthly") {
          featureText += ` (${creditDef.defaultAmount!} per month)`;
        } else if (renewal === "yearly") {
          featureText += ` (${creditDef.defaultAmount!} per year)`;
        } else {
          featureText += ` (${creditDef.defaultAmount!} included)`;
        }
      }

      // Add trial credit allowance information if trial plan exists
      if (trialPlan && trialCreditDefinitions) {
        const trialCreditDef = trialCreditDefinitions.find(
          (cd) => cd.featureId === feature.id
        );
        if (
          trialCreditDef &&
          typeof trialCreditDef.defaultAmount === "number" &&
          trialCreditDef.defaultAmount > 0
        ) {
          featureText += ` • Trial: ${trialCreditDef.defaultAmount} during trial period`;
        }
      }

      return {
        text: featureText,
      };
    }),
    buttonText: plan.buttonText || "Get Started",
    buttonOutline: false,
    isPopular: false,
    popularText: "Popular",
    planId: plan.id,
    priceId: latestPrice ? latestPrice.id : undefined,
    priceIdMonthly: plan.isEnterprisePlan ? undefined : priceIdMonthly,
    priceIdYearly: plan.isEnterprisePlan ? undefined : priceIdYearly,
    isEnterprisePlan: plan.isEnterprisePlan || false,
    enterpriseRedirectUrl: plan.enterpriseRedirectUrl || undefined,
    pricingData: latestPrice ? latestPrice.pricingData : { components: [] },
    // Trial information
    trial: trialPlan
      ? {
          available: true,
          days: trialPlan.trialDays || 0,
          trialPlanId: trialPlan.id,
        }
      : undefined,
  };
};
