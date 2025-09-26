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
  Users,
  UserCheck,
  DollarSign,
  Activity,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
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
import { type Customer } from "@lumen/common/schema";
import { apiClient } from "@/lib/hono-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { useSession } from "@/lib/auth-client";
import { FailedToLoadError } from "@/components/dashboard/failed-to-load-error";
import { PageContent } from "@/components/dashboard/page-content";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";
import { formatCurrency } from "@lumen/common/utils";
import { PerUnitPriceComponentSchemaType } from "@lumen/common";

// Safe wrapper for formatCurrency to handle non-integer values
const safeFormatCurrency = (
  amountCents: number | string | null | undefined,
  currency: string
) => {
  const amount = parseInt(amountCents?.toString() || "0", 10);
  return formatCurrency(amount, currency);
};

const CREATE_CUSTOMER_ROUTE = "/customers/create";

// Enhanced customer type with subscription data
interface CustomerWithSubscriptions extends Customer {
  subscriptionCount: number;
  activeSubscriptionCount: number;
  totalMRRCents: number;
  lastActivityDate: Date | null;
  status: "active" | "inactive";
  // Add new fields for the enhanced view
  currentPlan: string | null;
  currentPlanPrice: number; // in cents
  subscriptionStartDate: Date | null;
  totalPaymentsCents: number;
  paymentCount: number;
  currency: string;
  currencies: Array<{
    currency: string;
    totalPaymentsCents: number;
    paymentCount: number;
  }>;
}

// Subscription type for MRR calculation
interface SubscriptionForMRR {
  id: string;
  customerId: string;
  endTimestamp: Date | null;
  startTimestamp: Date;
  createdAt: Date;
  plan?: {
    planName: string;
  };
  price: {
    currency: string;
    pricingData: {
      components: Array<{
        type: string;
        amount_cents?: number;
        recurrence_rule?: string;
        num_seats?: number;
      }>;
    };
  };
}

// Helper function to get component amount (same as subscriptions page)
const getComponentAmount = (component: {
  amount_cents?: number;
  per_unit_cents?: number;
  unit_cost_cents?: number;
}): number => {
  return (
    component.amount_cents ??
    component.per_unit_cents ??
    component.unit_cost_cents ??
    0
  );
};

// Helper function to calculate MRR contribution from subscription (returns cents)
const calculateMRRContribution = (subscription: SubscriptionForMRR): number => {
  if (!subscription.price?.pricingData?.components) return 0;

  let mrrCents = 0;
  for (const component of subscription.price.pricingData.components) {
    const amount = getComponentAmount(component);
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
      // actual seat usage data per customer in this list view)
      const minSeats =
        (component as PerUnitPriceComponentSchemaType).num_seats || 1;

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

// Helper function to get subscription status
const getSubscriptionStatus = (
  subscription: SubscriptionForMRR
): "active" | "ended" => {
  return subscription.endTimestamp ? "ended" : "active";
};

// Helper function to get customer status
const getCustomerStatus = (
  customer: CustomerWithSubscriptions
): "active" | "inactive" => {
  return customer.activeSubscriptionCount > 0 ? "active" : "inactive";
};

// Helper function to get status color
const getStatusColor = (status: string) => {
  switch (status.toLowerCase()) {
    case "active":
      return "bg-green-100 text-green-800 border-green-200 hover:bg-green-200";
    case "inactive":
      return "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200";
    default:
      return "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200";
  }
};

const CustomerActions = ({
  customer,
}: {
  customer: CustomerWithSubscriptions;
}) => {
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
            navigator.clipboard.writeText(customer.id);
          }}
        >
          Copy customer ID
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            href={`/customers/${customer.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            View customer
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link
            href={`/customers/${customer.id}?edit=true`}
            onClick={(e) => e.stopPropagation()}
          >
            Edit customer
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default function CustomersPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  router.prefetch(CREATE_CUSTOMER_ROUTE);

  const handleCreateCustomer = useCallback(() => {
    router.push(CREATE_CUSTOMER_ROUTE);
  }, [router]);

  const deleteCustomersMutation = useMutation({
    mutationFn: async (customerIds: string[]) => {
      const deletePromises = customerIds.map((id) =>
        apiClient.customers[":id"].$delete({
          param: { id },
        })
      );
      await Promise.all(deletePromises);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
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
        handleCreateCustomer();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleCreateCustomer]);

  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  );
  const [columnVisibility, setColumnVisibility] =
    React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState({});
  const [statusFilter, setStatusFilter] = React.useState<string>("all");
  const [countryFilter, setCountryFilter] = React.useState<string>("all");

  // Fetch customers with payment data
  const {
    data: customers,
    isPending,
    isError,
  } = useQuery({
    queryKey: ["customers"],
    queryFn: async () => {
      const response = await apiClient.customers.$get({
        query: { includePaymentData: "true" },
      });
      const data = await response.json();
      if (!data.customers) {
        throw new Error("No customers data received");
      }
      // Merge customers with the same ID (due to multiple currencies)
      const customerMap = new Map<
        string,
        Customer & {
          totalPaymentsCents: number;
          paymentCount: number;
          currency: string;
          currencies: Array<{
            currency: string;
            totalPaymentsCents: number;
            paymentCount: number;
          }>;
        }
      >();

      const customersFromApi = data.customers as Array<
        Omit<Customer, "createdAt" | "updatedAt" | "deletedAt"> & {
          createdAt: string;
          updatedAt: string;
          deletedAt: string | null;
          totalPaymentsCents?: number;
          paymentCount?: number;
          currency?: string;
        }
      >;

      customersFromApi.forEach((customer) => {
        const totalPaymentsCents = parseInt(
          customer.totalPaymentsCents?.toString() || "0",
          10
        );
        const paymentCount = parseInt(
          customer.paymentCount?.toString() || "0",
          10
        );
        const currency = customer.currency || "USD";

        if (customerMap.has(customer.id)) {
          // Merge with existing customer
          const existingCustomer = customerMap.get(customer.id)!;

          // Only add if there are actual payments in this currency
          if (totalPaymentsCents > 0 || paymentCount > 0) {
            existingCustomer.currencies.push({
              currency,
              totalPaymentsCents,
              paymentCount,
            });

            // Update totals
            existingCustomer.totalPaymentsCents += totalPaymentsCents;
            existingCustomer.paymentCount += paymentCount;
          }
        } else {
          // Create new customer entry
          const currencies =
            totalPaymentsCents > 0 || paymentCount > 0
              ? [
                  {
                    currency,
                    totalPaymentsCents,
                    paymentCount,
                  },
                ]
              : [];

          customerMap.set(customer.id, {
            ...customer,
            createdAt: new Date(customer.createdAt),
            updatedAt: new Date(customer.updatedAt),
            deletedAt: customer.deletedAt ? new Date(customer.deletedAt) : null,
            totalPaymentsCents,
            paymentCount,
            currency,
            currencies,
          });
        }
      });

      return Array.from(customerMap.values());
    },
  });

  // Fetch subscriptions for enriching customer data
  const { data: subscriptions } = useQuery({
    queryKey: ["subscriptions"],
    queryFn: async (): Promise<SubscriptionForMRR[]> => {
      const response = await apiClient.subscriptions.$get();
      const data = await response.json();
      if (!data.subscriptions) {
        return [];
      }
      return data.subscriptions.map((subscription: unknown) => {
        const sub = subscription as {
          id: string;
          customerId: string;
          createdAt: string;
          startTimestamp: string;
          endTimestamp: string | null;
          plan?: { planName: string };
          price: {
            currency: string;
            pricingData: {
              components: Array<{
                type: string;
                amount_cents?: number;
                recurrence_rule?: string;
              }>;
            };
          };
        };
        return {
          id: sub.id,
          customerId: sub.customerId,
          createdAt: new Date(sub.createdAt),
          startTimestamp: new Date(sub.startTimestamp),
          endTimestamp: sub.endTimestamp ? new Date(sub.endTimestamp) : null,
          plan: sub.plan,
          price: sub.price,
        } as SubscriptionForMRR;
      });
    },
  });

  // Enrich customers with subscription data
  const enrichedCustomers = React.useMemo(() => {
    if (!customers || !subscriptions) return [];

    return customers.map((customer): CustomerWithSubscriptions => {
      const customerSubscriptions = subscriptions.filter(
        (sub: SubscriptionForMRR) => sub.customerId === customer.id
      );

      const activeSubscriptions = customerSubscriptions.filter(
        (sub: SubscriptionForMRR) => getSubscriptionStatus(sub) === "active"
      );

      const totalMRRCents = activeSubscriptions.reduce(
        (sum: number, sub: SubscriptionForMRR) =>
          sum + calculateMRRContribution(sub),
        0
      );

      // Find the most recent subscription creation date as last activity
      const lastActivityDate =
        customerSubscriptions.length > 0
          ? new Date(
              Math.max(
                ...customerSubscriptions.map((sub: SubscriptionForMRR) =>
                  new Date(sub.createdAt || sub.startTimestamp).getTime()
                )
              )
            )
          : null;

      // Get current plan information from most recent active subscription
      const currentSubscription =
        activeSubscriptions.length > 0 ? activeSubscriptions[0] : null;
      const currentPlan = currentSubscription?.plan?.planName || null;

      // Calculate current plan price using the same logic as MRR calculation
      const currentPlanPrice = currentSubscription
        ? calculateMRRContribution(currentSubscription)
        : 0;

      // Get subscription start date
      const subscriptionStartDate = currentSubscription
        ? currentSubscription.startTimestamp
        : null;

      // Determine currency with fallback priority: plan -> merchant -> customer -> USD
      const currency =
        currentSubscription?.price?.currency ||
        session?.merchant?.defaultCurrency ||
        customer.preferredCurrency ||
        "USD";

      const enrichedCustomer: CustomerWithSubscriptions = {
        ...customer,
        subscriptionCount: customerSubscriptions.length,
        activeSubscriptionCount: activeSubscriptions.length,
        totalMRRCents,
        lastActivityDate,
        status: activeSubscriptions.length > 0 ? "active" : "inactive",
        currentPlan,
        currentPlanPrice,
        subscriptionStartDate,
        totalPaymentsCents: customer.totalPaymentsCents,
        paymentCount: customer.paymentCount,
        currency,
        currencies: customer.currencies || [],
      };

      return enrichedCustomer;
    });
  }, [customers, subscriptions, session?.merchant?.defaultCurrency]);

  // Apply filters
  const filteredData = React.useMemo(() => {
    if (!enrichedCustomers.length) return enrichedCustomers;

    return enrichedCustomers.filter((customer) => {
      const status = getCustomerStatus(customer);
      const country = customer.billingCountry || "Unknown";

      const statusMatch = statusFilter === "all" || status === statusFilter;
      const countryMatch = countryFilter === "all" || country === countryFilter;

      return statusMatch && countryMatch;
    });
  }, [enrichedCustomers, statusFilter, countryFilter]);

  // Get unique countries for filter dropdown
  const uniqueCountries = React.useMemo(() => {
    const countries = new Set(
      enrichedCustomers
        .map((customer) => customer.billingCountry || "Unknown")
        .filter(Boolean)
    );
    return Array.from(countries).sort();
  }, [enrichedCustomers]);

  // Define columns
  const columns: ColumnDef<CustomerWithSubscriptions>[] = React.useMemo(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && "indeterminate")
            }
            onCheckedChange={(value) =>
              table.toggleAllPageRowsSelected(!!value)
            }
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
        size: 50,
        minSize: 50,
        maxSize: 50,
      },
      {
        id: "customer",
        accessorFn: (row) => row.name || row.email || "Unknown",
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Customer
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const customer = row.original;
          return (
            <div className="space-y-1 min-w-0">
              <div className="font-medium truncate">
                {customer.name || "Unknown"}
              </div>
              <div className="text-sm text-muted-foreground truncate">
                {customer.email || "No email"}
              </div>
            </div>
          );
        },
        size: 280,
        minSize: 200,
      },
      {
        accessorKey: "currentPlan",
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Plan
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const plan = row.getValue("currentPlan") as string;
          return <div className="font-medium text-sm">{plan || "-"}</div>;
        },
        size: 150,
        minSize: 120,
      },
      {
        accessorKey: "currentPlanPrice",
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Plan Price
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const price = row.getValue("currentPlanPrice") as number;
          const currency = row.original.currency || "USD";
          return (
            <div className="font-medium text-sm">
              {price > 0
                ? safeFormatCurrency(Math.round(price), currency)
                : "-"}
            </div>
          );
        },
        size: 120,
        minSize: 100,
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Created Date
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const createdDate = row.getValue("createdAt") as Date;
          return <LocaleAwareDate date={createdDate} className="text-sm" />;
        },
        size: 120,
        minSize: 100,
      },
      {
        accessorKey: "totalPaymentsCents",
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Total Payments
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const customer = row.original;

          // If there are multiple currencies, show them separately
          if (customer.currencies && customer.currencies.length > 1) {
            const nonZeroPayments = customer.currencies.filter(
              (c) => c.totalPaymentsCents > 0
            );
            if (nonZeroPayments.length === 0) {
              return <div className="font-medium text-sm">-</div>;
            }

            return (
              <div className="font-medium text-sm">
                {nonZeroPayments.map((currencyData, index) => (
                  <span key={currencyData.currency}>
                    {safeFormatCurrency(
                      Math.round(currencyData.totalPaymentsCents),
                      currencyData.currency
                    )}
                    {index < nonZeroPayments.length - 1 && (
                      <span className="text-muted-foreground"> / </span>
                    )}
                  </span>
                ))}
              </div>
            );
          }

          // Single currency or no currencies
          const totalPayments = customer.totalPaymentsCents;
          const currency = customer.currency || "USD";
          return (
            <div className="font-medium text-sm">
              {totalPayments > 0
                ? safeFormatCurrency(Math.round(totalPayments), currency)
                : "-"}
            </div>
          );
        },
        size: 120,
        minSize: 100,
      },
      {
        accessorKey: "billingCountry",
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Country
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          return (
            <div className="font-medium text-sm">
              {(row.getValue("billingCountry") as string) || "Unknown"}
            </div>
          );
        },
        size: 100,
        minSize: 80,
      },
      {
        id: "status",
        accessorFn: (row) => row.status,
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Status
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const status = row.getValue("status") as string;
          return (
            <Badge className={getStatusColor(status)}>
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </Badge>
          );
        },
        size: 100,
        minSize: 80,
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => {
          const customer = row.original;
          return <CustomerActions customer={customer} />;
        },
        size: 60,
        minSize: 60,
        maxSize: 60,
      },
    ],
    []
  );

  const table = useReactTable({
    data: filteredData,
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
      const customer = row.original;
      const searchValue = filterValue.toLowerCase();
      return Boolean(
        customer.name?.toLowerCase().includes(searchValue) ||
          customer.email?.toLowerCase().includes(searchValue) ||
          customer.currentPlan?.toLowerCase().includes(searchValue) ||
          customer.billingCountry?.toLowerCase().includes(searchValue)
      );
    },
  });

  const handleDeleteSelected = () => {
    const selectedRows = table.getSelectedRowModel().rows;
    const customerIds = selectedRows.map((row) => row.original.id);
    deleteCustomersMutation.mutate(customerIds);
  };

  // Calculate summary statistics
  const summaryStats = React.useMemo(() => {
    if (!enrichedCustomers || enrichedCustomers.length === 0) {
      return {
        totalCustomers: 0,
        activeCustomers: 0,
        totalMRRCents: 0,
        averageMRRCents: 0,
      };
    }

    const activeCustomers = enrichedCustomers.filter(
      (customer) => customer.status === "active"
    );
    const totalMRRCents = enrichedCustomers.reduce(
      (sum, customer) => sum + customer.totalMRRCents,
      0
    );
    const averageMRRCents =
      activeCustomers.length > 0
        ? Math.round(totalMRRCents / activeCustomers.length)
        : 0;

    return {
      totalCustomers: enrichedCustomers.length,
      activeCustomers: activeCustomers.length,
      totalMRRCents,
      averageMRRCents,
    };
  }, [enrichedCustomers]);

  return (
    <PageContent
      title="Customers"
      description="Manage your customer base and view customer details"
      actions={
        <div className="flex gap-2">
          {table.getSelectedRowModel().rows.length > 0 && (
            <Button
              variant="destructive"
              onClick={handleDeleteSelected}
              disabled={deleteCustomersMutation.isPending}
            >
              {deleteCustomersMutation.isPending ? (
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
          )}
          <Link href="/customers/create">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create Customer
              <kbd className="ml-2 pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[14px] font-medium text-muted-foreground opacity-100">
                N
              </kbd>
            </Button>
          </Link>
        </div>
      }
    >
      <div className="w-full">
        {/* Summary Statistics */}
        {!isPending && !isError && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-card rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-muted-foreground">
                    Total Customers
                  </div>
                  <div className="text-2xl font-bold">
                    {summaryStats.totalCustomers}
                  </div>
                </div>
                <Users className="h-8 w-8 text-muted-foreground" />
              </div>
            </div>
            <div className="bg-card rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-muted-foreground">
                    Active Customers
                  </div>
                  <div className="text-2xl font-bold text-green-600">
                    {summaryStats.activeCustomers}
                  </div>
                </div>
                <UserCheck className="h-8 w-8 text-green-600" />
              </div>
            </div>
            <div className="bg-card rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-muted-foreground">Total MRR</div>
                  <div className="text-2xl font-bold">
                    {safeFormatCurrency(
                      Math.round(summaryStats.totalMRRCents),
                      enrichedCustomers?.[0]?.currencies?.[0]?.currency ||
                        subscriptions?.[0]?.price?.currency ||
                        session?.merchant?.defaultCurrency ||
                        "USD"
                    )}
                  </div>
                </div>
                <DollarSign className="h-8 w-8 text-muted-foreground" />
              </div>
            </div>
            <div className="bg-card rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-muted-foreground">
                    Average MRR
                  </div>
                  <div className="text-2xl font-bold">
                    {safeFormatCurrency(
                      Math.round(summaryStats.averageMRRCents),
                      enrichedCustomers?.[0]?.currencies?.[0]?.currency ||
                        subscriptions?.[0]?.price?.currency ||
                        session?.merchant?.defaultCurrency ||
                        "USD"
                    )}
                  </div>
                </div>
                <Activity className="h-8 w-8 text-muted-foreground" />
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center py-4 gap-4">
          <Input
            placeholder="Search by name, email, or country..."
            value={table.getState().globalFilter ?? ""}
            onChange={(event) => table.setGlobalFilter(event.target.value)}
            className="max-w-sm"
            disabled={isPending || isError}
          />

          {/* Status Filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={isPending || isError}>
                Status:{" "}
                {statusFilter === "all"
                  ? "All"
                  : statusFilter === "active"
                    ? "Active"
                    : "Inactive"}
                <ChevronDown className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setStatusFilter("all")}>
                All
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusFilter("active")}>
                Active
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusFilter("inactive")}>
                Inactive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Country Filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={isPending || isError}>
                Country: {countryFilter === "all" ? "All" : countryFilter}
                <ChevronDown className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setCountryFilter("all")}>
                All Countries
              </DropdownMenuItem>
              {uniqueCountries.map((country) => (
                <DropdownMenuItem
                  key={country}
                  onClick={() => setCountryFilter(country)}
                >
                  {country}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

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
                        onClick={() =>
                          router.push(`/customers/${row.original.id}`)
                        }
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
