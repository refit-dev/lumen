"use client";
import * as React from "react";
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
} from "@tanstack/react-table";
import {
  ArrowUpDown,
  ChevronDown,
  MoreHorizontal,
  Plus,
  Loader2,
  Trash2,
  TrendingUp,
  Users,
  DollarSign,
  Calendar,
  Eye,
  Edit,
  Copy,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { apiClient } from "@/lib/hono-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { Plan } from "@lumen/common/schema";
import { FailedToLoadError } from "@/components/dashboard/failed-to-load-error";
import { PageContent } from "@/components/dashboard/page-content";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCurrency } from "@lumen/common/utils";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";
import { useSession } from "@/lib/auth-client";

const CREATE_PLAN_ROUTE = "/plans/create";

// Enhanced plan type with revenue and performance metrics
type PlanWithPrices = Plan & {
  prices?: Array<{
    id: string;
    currency: string;
    pricingData?: {
      components?: Array<{
        type: string;
        amount_cents?: number;
        recurrence_rule?: string;
        unit_label?: string;
      }>;
    };
  }>;
  features?: Array<{
    slug: string;
    displayName: string;
  }>;
  isVisibleInPricingTable?: boolean;
  isEnterprisePlan?: boolean;
  enterpriseRedirectUrl?: string | null;
  buttonText?: string;
};

type PlanRow = PlanWithPrices & {
  activeSubscribers: number;
  mrrCents: number;
  arrCents: number;
  monthlyPrice: number;
  yearlyPrice: number;
  currency: string;
  conversionRate: number;
  churnRate: number;
  isPopular: boolean;
  lastSubscriptionDate: Date | null;
  avgRevenuePerUser: number;
  perUnit?: boolean;
  unitLabel?: string;
};

// Pricing component type for usage-based display
type PriceComponent = {
  type: string;
  amount_cents?: number;
  unit_cost_cents?: number;
  unit_label?: string;
  recurrence_rule?: string;
  label?: string;
  component_name?: string;
};

// Helper to calculate MRR from price components
const calculateMRRFromComponents = (
  components: Array<{
    type: string;
    amount_cents?: number;
    recurrence_rule?: string;
    num_seats?: number;
  }>
): number => {
  let mrrCents = 0;
  for (const component of components) {
    const amount = component.amount_cents;
    if (!amount) continue;

    const recurrenceRule = component.recurrence_rule || "";

    if (component.type === "fixed") {
      // Fixed components: amount is the total monthly or yearly charge
      if (recurrenceRule.includes("FREQ=MONTHLY")) {
        mrrCents += amount;
      } else if (recurrenceRule.includes("FREQ=YEARLY")) {
        mrrCents += Math.round(amount / 12);
      }
    } else if (component.type === "per_unit") {
      // Seat-based per_unit components: amount is per seat per billing period
      // Note: This calculates base MRR assuming minimum seats (since we don't have
      // actual seat usage data per subscription in this context)
      const minSeats = component.num_seats || 1;

      if (recurrenceRule.includes("FREQ=MONTHLY")) {
        // amount is per seat per month
        mrrCents += amount * minSeats;
      } else if (recurrenceRule.includes("FREQ=YEARLY")) {
        // amount is per seat per year, so divide by 12 to get per seat per month
        mrrCents += Math.round((amount * minSeats) / 12);
      }
    }
    // Note: usage-based components are not included in MRR calculation
    // as they are variable and unpredictable
  }
  return mrrCents;
};

// Helper to extract pricing info from plan (supports fixed and per_unit components)
const extractPricingInfo = (plan: PlanWithPrices) => {
  let monthlyPrice = 0;
  let yearlyPrice = 0;
  let currency: string | undefined;
  let perUnit = false;
  let unitLabel: string | undefined;

  if (plan.prices && plan.prices.length > 0) {
    const price = plan.prices[0];
    currency = price.currency;

    if (price.pricingData?.components) {
      for (const component of price.pricingData.components) {
        // We consider both fixed and per_unit components
        if (
          (component.type === "fixed" || component.type === "per_unit") &&
          component.amount_cents
        ) {
          const recurrence = component.recurrence_rule || "";
          if (recurrence.includes("FREQ=MONTHLY")) {
            monthlyPrice = component.amount_cents;
          } else if (recurrence.includes("FREQ=YEARLY")) {
            yearlyPrice = component.amount_cents;
          }

          if (component.type === "per_unit") {
            perUnit = true;
            if (component.unit_label) {
              unitLabel = component.unit_label;
            } else {
              unitLabel = "unit";
            }
          }
        }
      }
    }
  }

  return { monthlyPrice, yearlyPrice, currency, perUnit, unitLabel };
};

const PlanActions = ({ plan }: { plan: PlanRow }) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 w-8 p-0">
          <span className="sr-only">Open menu</span>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(plan.id);
          }}
        >
          <Copy className="mr-2 h-4 w-4" />
          Copy plan ID
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={`/plans/${plan.id}`} onClick={(e) => e.stopPropagation()}>
            <Eye className="mr-2 h-4 w-4" />
            View plan
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link
            href={`/plans/${plan.id}?edit=true`}
            onClick={(e) => e.stopPropagation()}
          >
            <Edit className="mr-2 h-4 w-4" />
            Edit plan
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const BASE_SELECT_COLUMN: ColumnDef<PlanRow> = {
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
};

export default function PlansPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  router.prefetch(CREATE_PLAN_ROUTE);

  const handleCreatePlan = useCallback(() => {
    router.push(CREATE_PLAN_ROUTE);
  }, [router]);

  const deletePlansMutation = useMutation({
    mutationFn: async (planIds: string[]) => {
      const deletePromises = planIds.map((id) =>
        apiClient.plans[":id"].$delete({
          param: { id },
        })
      );
      await Promise.all(deletePromises);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plans"] });
      setRowSelection({});
    },
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isCommandPaletteOpen =
        document.querySelector('[role="dialog"][data-state="open"]') !== null;

      if (
        event.key.toLowerCase() === "n" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !isCommandPaletteOpen
      ) {
        event.preventDefault();
        handleCreatePlan();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleCreatePlan]);

  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  );
  const [columnVisibility, setColumnVisibility] =
    React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState({});

  const {
    data: plans,
    isPending,
    isError,
  } = useQuery({
    queryKey: ["plans"],
    queryFn: async () => {
      const response = await apiClient.plans.$get({
        query: {
          includeFeatures: "true",
          includePrices: "true",
        },
      });
      const data = await response.json();
      if (!data.plans) {
        throw new Error("No plans data received");
      }

      // Group plans by stablePlanId and keep only the latest version of each
      const plansByStableId = new Map<string, PlanWithPrices>();

      data.plans.forEach((planData) => {
        // Convert dates first to match Plan type
        const plan = {
          ...planData,
          createdAt: new Date(planData.createdAt),
          deletedAt: planData.deletedAt ? new Date(planData.deletedAt) : null,
        } as PlanWithPrices;

        const existing = plansByStableId.get(plan.stablePlanId);
        if (!existing || plan.versionNumber > existing.versionNumber) {
          plansByStableId.set(plan.stablePlanId, plan);
        }
      });

      // Convert back to array (dates already processed)
      return Array.from(plansByStableId.values());
    },
  });

  // Get all subscriptions to check for active subscribers
  const { data: allSubscriptions } = useQuery({
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
  });

  // Extend plans with revenue and performance metrics
  const extendedPlans: PlanRow[] = React.useMemo(() => {
    if (!plans) return [];

    return plans.map((plan) => {
      const planSubscriptions = (allSubscriptions || []).filter(
        (sub) => sub.planId === plan.id && !sub.endTimestamp && !sub.deletedAt
      );

      const activeSubscribers = planSubscriptions.length;
      const { monthlyPrice, yearlyPrice, currency, perUnit, unitLabel } =
        extractPricingInfo(plan as PlanWithPrices);

      // Calculate MRR from actual subscriptions
      let mrrCents = 0;
      const planWithPrices = plan as PlanWithPrices;
      if (
        planWithPrices.prices &&
        planWithPrices.prices[0]?.pricingData?.components
      ) {
        const baseMrrPerSubscription = calculateMRRFromComponents(
          planWithPrices.prices[0].pricingData.components
        );

        // For seat-based plans, this is an approximation based on minimum seats
        // Actual MRR would require fetching individual seat counts per subscription
        mrrCents = baseMrrPerSubscription * activeSubscribers;
      }

      const arrCents = mrrCents * 12;
      const avgRevenuePerUser =
        activeSubscribers > 0 ? mrrCents / activeSubscribers : 0;

      // Get last subscription date
      const lastSubscriptionDate =
        planSubscriptions.length > 0
          ? new Date(
              Math.max(
                ...planSubscriptions.map((sub) =>
                  new Date(sub.startTimestamp).getTime()
                )
              )
            )
          : null;

      // Simple popularity calculation (plans with >3 subscribers or >$1000 MRR)
      const isPopular = activeSubscribers > 3 || mrrCents > 100000;

      return {
        ...plan,
        activeSubscribers,
        mrrCents,
        arrCents,
        monthlyPrice,
        yearlyPrice,
        currency,
        perUnit,
        unitLabel,
        conversionRate: 0, // Would need conversion tracking
        churnRate: 0, // Would need churn tracking
        isPopular,
        lastSubscriptionDate,
        avgRevenuePerUser,
      } as PlanRow;
    });
  }, [plans, allSubscriptions]);

  // Summary statistics for merchant dashboard
  const summaryStats = React.useMemo(() => {
    if (!extendedPlans.length) {
      return {
        totalPlans: 0,
        plansWithSubscribers: 0,
        totalMRR: 0,
        totalARR: 0,
        avgPlanPrice: 0,
        mostPopularPlan: null,
        totalActiveSubscribers: 0,
        currency: undefined,
      };
    }

    const totalMRR = extendedPlans.reduce(
      (sum, plan) => sum + plan.mrrCents,
      0
    );
    const totalARR = totalMRR * 12;
    const plansWithSubscribers = extendedPlans.filter(
      (p) => p.activeSubscribers > 0
    );
    const avgPlanPrice =
      plansWithSubscribers.length > 0
        ? plansWithSubscribers.reduce(
            (sum, plan) => sum + plan.monthlyPrice,
            0
          ) / plansWithSubscribers.length
        : 0;

    const mostPopularPlan =
      extendedPlans.length > 0
        ? extendedPlans.reduce((max, plan) =>
            plan.activeSubscribers > max.activeSubscribers ? plan : max
          )
        : null;

    const totalActiveSubscribers = extendedPlans.reduce(
      (sum, plan) => sum + plan.activeSubscribers,
      0
    );

    // Careful currency fallback - try to get from actual plan data first
    let currency: string | undefined;

    // First try: get from plans with active subscribers (most relevant)
    if (plansWithSubscribers.length > 0) {
      currency = plansWithSubscribers.find((p) => p.currency)?.currency;
    }

    // Second try: get from any plan with currency data
    if (!currency && extendedPlans.length > 0) {
      currency = extendedPlans.find((p) => p.currency)?.currency;
    }

    // Final fallback only when absolutely no currency data exists
    if (!currency) {
      currency = session?.merchant?.defaultCurrency || "USD";
    }

    return {
      totalPlans: extendedPlans.length,
      plansWithSubscribers: plansWithSubscribers.length,
      totalMRR,
      totalARR,
      avgPlanPrice,
      mostPopularPlan,
      totalActiveSubscribers,
      currency,
    };
  }, [extendedPlans, session]);

  // Enhanced columns with revenue and performance data
  const columns: ColumnDef<PlanRow>[] = React.useMemo(() => {
    const enhancedColumns: ColumnDef<PlanRow>[] = [
      // Select column
      BASE_SELECT_COLUMN,

      // Plan name with popularity indicator
      {
        accessorKey: "planName",
        header: ({ column }) => (
          <div
            className="flex items-center cursor-pointer hover:text-foreground font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Plan Name
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </div>
        ),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <div className="font-medium">{row.getValue("planName")}</div>
            {row.original.isPopular && (
              <Badge variant="secondary" className="text-xs">
                Popular
              </Badge>
            )}
          </div>
        ),
      },

      // Pricing information
      {
        id: "pricing",
        // Keep the original sorting accessor based on the first monthly fixed amount for now
        accessorFn: (row) => row.monthlyPrice,
        header: ({ column }) => (
          <div
            className="flex items-center cursor-pointer hover:text-foreground font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            <DollarSign className="mr-1 h-4 w-4" />
            Pricing
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </div>
        ),
        cell: ({ row }) => {
          const priceObjects = (row.original.prices || []) as Array<{
            pricingData?: { components?: PriceComponent[] };
          }>;

          // Identify the monthly and yearly price objects separately (first match wins)
          const monthlyPriceObj = priceObjects.find((p) =>
            (p.pricingData?.components || []).some((c) =>
              c.recurrence_rule?.includes("FREQ=MONTHLY")
            )
          );
          const yearlyPriceObj = priceObjects.find((p) =>
            (p.pricingData?.components || []).some((c) =>
              c.recurrence_rule?.includes("FREQ=YEARLY")
            )
          );

          const monthlyComponents =
            monthlyPriceObj?.pricingData?.components ||
            ([] as PriceComponent[]);
          const yearlyComponents =
            yearlyPriceObj?.pricingData?.components || ([] as PriceComponent[]);

          const fixedMonthlyComp = monthlyComponents.find(
            (c) => c.type === "fixed" || c.type === "per_unit"
          ) as
            | (PriceComponent & {
                amount_cents?: number;
                unit_label?: string;
              })
            | null;
          const fixedYearlyComp = yearlyComponents.find(
            (c) => c.type === "fixed" || c.type === "per_unit"
          ) as
            | (PriceComponent & {
                amount_cents?: number;
                unit_label?: string;
              })
            | null;

          const usageComponents = monthlyComponents.filter(
            (c) => c.type === "usage"
          ) as Array<
            PriceComponent & {
              unit_cost_cents?: number;
              unit_label?: string;
              amount_cents?: number;
            }
          >;

          const displayCurrency =
            row.original.currency ||
            summaryStats.currency ||
            session?.merchant?.defaultCurrency ||
            "USD";

          const renderFixedLine = () => {
            if (!fixedMonthlyComp && !fixedYearlyComp) return null;

            const monthlyAmount = fixedMonthlyComp?.amount_cents ?? 0;
            const yearlyAmount = fixedYearlyComp?.amount_cents ?? 0;
            const perUnit = fixedMonthlyComp?.type === "per_unit";
            const unitLabel = perUnit
              ? fixedMonthlyComp?.unit_label || "unit"
              : undefined;

            return (
              <div className="text-sm font-medium flex items-baseline gap-1 flex-wrap">
                {fixedMonthlyComp && (
                  <>
                    {formatCurrency(monthlyAmount, displayCurrency)}/mo
                    {perUnit && unitLabel ? ` per ${unitLabel}` : ""}
                  </>
                )}
                {fixedYearlyComp && (
                  <span className="text-xs text-muted-foreground ml-1 whitespace-nowrap">
                    {formatCurrency(yearlyAmount, displayCurrency)}/yr
                    {perUnit && unitLabel ? ` per ${unitLabel}` : ""}
                  </span>
                )}
              </div>
            );
          };

          const renderUsageSummary = () => {
            if (usageComponents.length === 0) return null;
            return (
              <TooltipProvider delayDuration={0}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-xs text-muted-foreground underline cursor-help">
                      + usage
                    </span>
                  </TooltipTrigger>
                  <TooltipContent align="start">
                    <div className="space-y-1">
                      {usageComponents.map((comp, idx) => {
                        const amount =
                          comp.unit_cost_cents ?? comp.amount_cents ?? 0;
                        const labelText =
                          comp.label ||
                          comp.component_name ||
                          `Usage ${idx + 1}`;
                        const unitLbl = comp.unit_label || "unit";
                        return (
                          <div key={idx} className="text-xs">
                            {labelText}:{" "}
                            {formatCurrency(amount, displayCurrency)} per{" "}
                            {unitLbl}
                          </div>
                        );
                      })}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            );
          };

          const isFree =
            !fixedMonthlyComp &&
            !fixedYearlyComp &&
            usageComponents.length === 0;

          return (
            <div className="space-y-1">
              {renderFixedLine()} {renderUsageSummary()}
              {isFree && (
                <div className="text-sm text-muted-foreground">Free</div>
              )}
            </div>
          );
        },
      },

      // Active subscribers
      {
        accessorKey: "activeSubscribers",
        header: ({ column }) => (
          <div
            className="flex items-center cursor-pointer hover:text-foreground font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            <Users className="mr-1 h-4 w-4" />
            Subscribers
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </div>
        ),
        cell: ({ row }) => (
          <div className="font-medium">{row.getValue("activeSubscribers")}</div>
        ),
      },

      // MRR
      {
        accessorKey: "mrrCents",
        header: ({ column }) => (
          <div
            className="flex items-center cursor-pointer hover:text-foreground font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            <TrendingUp className="mr-1 h-4 w-4" />
            MRR
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </div>
        ),
        cell: ({ row }) => {
          const mrrCents = row.getValue("mrrCents") as number;
          const currency = row.original.currency;

          // Careful currency fallback
          const displayCurrency =
            currency ||
            summaryStats.currency ||
            session?.merchant?.defaultCurrency ||
            "USD";

          return (
            <div className="font-medium">
              {formatCurrency(mrrCents, displayCurrency)}
            </div>
          );
        },
      },

      // Version and creation date
      {
        id: "version",
        accessorKey: "versionNumber",
        header: ({ column }) => (
          <div
            className="flex items-center cursor-pointer hover:text-foreground font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Version
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </div>
        ),
        cell: ({ row }) => (
          <div className="space-y-1">
            <div className="font-medium">v{row.getValue("version")}</div>
            <div className="text-xs text-muted-foreground">
              <LocaleAwareDate date={row.original.createdAt} />
            </div>
          </div>
        ),
      },

      // Actions
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => {
          const plan = row.original;
          return <PlanActions plan={plan} />;
        },
      },
    ];

    return enhancedColumns;
  }, [summaryStats.currency, session]);

  // Use the enriched dataset for the table
  const tableData = isError ? [] : extendedPlans;

  const table = useReactTable({
    data: tableData,
    columns,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
    globalFilterFn: (row, columnId, filterValue) => {
      const name = row.getValue("planName") as string;
      const description = row.getValue("planDescription") as string;
      const searchValue = filterValue.toLowerCase();
      return (
        name.toLowerCase().includes(searchValue) ||
        description.toLowerCase().includes(searchValue)
      );
    },
  });

  // Check if selected plans have active subscribers
  const getSelectedPlansWithSubscribers = () => {
    if (!allSubscriptions) return [];
    const selectedRows = table.getSelectedRowModel().rows;
    const selectedPlans = selectedRows.map((row) => row.original);

    return selectedPlans.filter((plan) => {
      // Check if this plan has any active subscriptions
      return allSubscriptions.some(
        (sub) => sub.planId === plan.id && !sub.endTimestamp && !sub.deletedAt
      );
    });
  };

  const selectedPlansWithSubscribers = getSelectedPlansWithSubscribers();
  const canDeleteSelected = selectedPlansWithSubscribers.length === 0;

  const handleDeleteSelected = () => {
    const selectedRows = table.getSelectedRowModel().rows;
    const planIds = selectedRows.map((row) => row.original.id);
    deletePlansMutation.mutate(planIds);
  };

  return (
    <PageContent
      title="Plans"
      description="Manage your subscription plans and track revenue performance"
      actions={
        <div className="flex gap-2">
          {table.getSelectedRowModel().rows.length > 0 &&
            (canDeleteSelected ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    disabled={deletePlansMutation.isPending}
                  >
                    {deletePlansMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Deleting...
                      </>
                    ) : (
                      <>
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete Selected
                      </>
                    )}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Are you absolutely sure?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      This action cannot be undone.{" "}
                      {table.getSelectedRowModel().rows.length} plan
                      {table.getSelectedRowModel().rows.length !== 1
                        ? "s"
                        : ""}{" "}
                      and all associated data will be permanently deleted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <Button
                      variant="destructive"
                      onClick={handleDeleteSelected}
                      disabled={deletePlansMutation.isPending}
                    >
                      {deletePlansMutation.isPending ? (
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
                        Delete Selected
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      Cannot delete plans with active subscribers.{" "}
                      {selectedPlansWithSubscribers.length} selected plan
                      {selectedPlansWithSubscribers.length !== 1
                        ? "s have"
                        : " has"}{" "}
                      active subscribers.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ))}
          <Link href="/plans/create">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create Plan
              <kbd className="ml-2 pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[14px] font-medium text-muted-foreground opacity-100">
                N
              </kbd>
            </Button>
          </Link>
        </div>
      }
    >
      <div className="w-full space-y-6">
        {/* Revenue and Performance Dashboard */}
        {!isPending &&
          !isError &&
          (() => {
            // Careful currency fallback for summary display
            const displayCurrency: string =
              summaryStats.currency ||
              session?.merchant?.defaultCurrency ||
              "USD";

            return (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">
                      Total MRR
                    </CardTitle>
                    <DollarSign className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {formatCurrency(summaryStats.totalMRR, displayCurrency)}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      ARR:{" "}
                      {formatCurrency(summaryStats.totalARR, displayCurrency)}
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">
                      Active Plans
                    </CardTitle>
                    <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {summaryStats.plansWithSubscribers}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      of {summaryStats.totalPlans} total plans
                    </p>
                    {summaryStats.totalPlans > 0 && (
                      <Progress
                        value={
                          (summaryStats.plansWithSubscribers /
                            summaryStats.totalPlans) *
                          100
                        }
                        className="mt-2"
                      />
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">
                      Total Subscribers
                    </CardTitle>
                    <Users className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {summaryStats.totalActiveSubscribers}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Avg:{" "}
                      {summaryStats.plansWithSubscribers > 0
                        ? Math.round(
                            summaryStats.totalActiveSubscribers /
                              summaryStats.plansWithSubscribers
                          )
                        : 0}{" "}
                      per plan
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">
                      Avg Plan Price
                    </CardTitle>
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {formatCurrency(
                        summaryStats.avgPlanPrice,
                        displayCurrency
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {summaryStats.mostPopularPlan
                        ? `Top: ${summaryStats.mostPopularPlan.planName}`
                        : "No active plans"}
                    </p>
                  </CardContent>
                </Card>
              </div>
            );
          })()}

        {/* Filters and Search */}
        <div className="flex items-center py-4">
          <Input
            placeholder="Search plans by name or description..."
            value={table.getState().globalFilter ?? ""}
            onChange={(event) => table.setGlobalFilter(event.target.value)}
            className="max-w-sm"
            disabled={isPending || isError}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="ml-auto"
                disabled={isPending || isError}
              >
                Columns <ChevronDown className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {table
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

        {/* Plans Table */}
        {isError ? (
          <FailedToLoadError />
        ) : (
          <>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id}>
                      {headerGroup.headers.map((header) => {
                        return (
                          <TableHead key={header.id}>
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
                  {isPending ? (
                    Array.from({ length: 5 }).map((_, index) => (
                      <TableRow key={index}>
                        {columns.map((column, i) => (
                          <TableCell key={`skeleton-${i}`}>
                            <Skeleton className="h-4 w-[100px]" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : table.getRowModel().rows?.length ? (
                    table.getRowModel().rows.map((row) => (
                      <TableRow
                        key={row.id}
                        data-state={row.getIsSelected() && "selected"}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => router.push(`/plans/${row.original.id}`)}
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
                        colSpan={columns.length}
                        className="h-24 text-center"
                      >
                        No results.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-end space-x-2 py-4">
              <div className="flex-1 text-sm text-muted-foreground">
                {table.getFilteredSelectedRowModel().rows.length} of{" "}
                {table.getFilteredRowModel().rows.length} row(s) selected.
              </div>
              <div className="space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </PageContent>
  );
}
