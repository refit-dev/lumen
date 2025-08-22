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
  DownloadIcon,
  Calendar,
  AlertTriangle,
} from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
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
import { z } from "zod";
import { invoiceSelectSchemaAPI } from "@lumen/common/schema";
import { apiClient } from "@/lib/hono-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { useSession } from "@/lib/auth-client";
import { FailedToLoadError } from "@/components/dashboard/failed-to-load-error";
import { PageContent } from "@/components/dashboard/page-content";
import { formatCurrency } from "@lumen/common/utils";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";

// Define Invoice type based on the API schema
type Invoice = z.infer<typeof invoiceSelectSchemaAPI> & {
  customer?: {
    id: string;
    name: string;
    email: string;
  };
  subscription?: {
    id: string;
    stableSubscriptionId: string;
    plan: {
      id: string;
      planName: string;
      planDescription: string | null;
      stablePlanId: string;
      versionNumber: number;
    };
  } | null;
  lineItems: Array<{
    id: string;
    description: string;
    subtotalCents: number;
    currency: string;
  }>;
  hasPdf?: boolean;
};

// Response type for PDF download
type PdfResponse = {
  invoice: { id: string; customerInvoiceNumber: string | null };
  pdfUrl: string;
  expiresIn: number;
};

// Response type for invoices list
type InvoicesResponse = {
  invoices: Invoice[];
  pagination: { total: number; limit: number; offset: number };
};

const CREATE_INVOICE_ROUTE = "/invoices/create";

// Helper function to calculate days overdue
const getDaysOverdue = (dueDate: string | null): number => {
  if (!dueDate) return 0;
  const due = new Date(dueDate);
  const today = new Date();
  const diffTime = today.getTime() - due.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
};

// Helper function to get invoice status with overdue logic
const getInvoiceStatus = (
  invoice: Invoice
): "draft" | "pending" | "paid" | "overdue" => {
  const status = invoice.status.toLowerCase();

  if (status === "paid") return "paid";
  if (status === "draft") return "draft";

  // Check if pending invoice is overdue
  if (status === "pending") {
    const daysOverdue = getDaysOverdue(invoice.dueDate);
    return daysOverdue > 0 ? "overdue" : "pending";
  }

  return status as "draft" | "pending" | "paid" | "overdue";
};

// Helper function to get status badge colors
const getStatusBadgeStyle = (status: string) => {
  switch (status) {
    case "paid":
      return "bg-green-100 text-green-800 border-green-200 hover:bg-green-200";
    case "pending":
      return "bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-200";
    case "overdue":
      return "bg-red-100 text-red-800 border-red-200 hover:bg-red-200";
    case "draft":
      return "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200";
    default:
      return "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200";
  }
};

const InvoiceActions = ({ invoice }: { invoice: Invoice }) => {
  const downloadPdfMutation = useMutation({
    mutationFn: async (invoiceId: string) => {
      const response = await apiClient.invoices[":id"].pdf.$get({
        param: { id: invoiceId },
      });
      const data = (await response.json()) as PdfResponse;
      return data.pdfUrl;
    },
    onSuccess: (pdfUrl) => {
      window.open(pdfUrl, "_blank");
    },
  });

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
            navigator.clipboard.writeText(invoice.id);
          }}
        >
          Copy invoice ID
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            href={`/invoices/${invoice.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            View invoice
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            if (invoice.hasPdf) {
              downloadPdfMutation.mutate(invoice.id);
            }
          }}
          disabled={!invoice.hasPdf || downloadPdfMutation.isPending}
        >
          {downloadPdfMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Downloading...
            </>
          ) : (
            <>
              <DownloadIcon className="mr-2 h-4 w-4" />
              Download PDF
            </>
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default function InvoicesPage() {
  const router = useRouter();
  const { data: session } = useSession();
  router.prefetch(CREATE_INVOICE_ROUTE);

  const handleCreateInvoice = useCallback(() => {
    router.push(CREATE_INVOICE_ROUTE);
  }, [router]);

  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  );
  const [columnVisibility, setColumnVisibility] =
    React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState({});
  const [statusFilter, setStatusFilter] = React.useState<string>("all");
  const [typeFilter, setTypeFilter] = React.useState<string>("all");

  const { data, isPending, isError } = useQuery<InvoicesResponse>({
    queryKey: ["invoices"],
    queryFn: async () => {
      const response = await apiClient.invoices.$get();
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error || "Failed to fetch invoices");
      }
      if (!data.invoices) {
        throw new Error("No invoices data received");
      }

      // Adapt the API response to match the Invoice type
      const adaptedInvoices = data.invoices.map((invoice) => {
        // Add currency to each line item since it's now at the invoice level
        const adaptedLineItems = invoice.lineItems.map((item) => ({
          ...item,
          currency: invoice.currency,
        }));

        return {
          ...invoice,
          lineItems: adaptedLineItems,
        };
      });

      return {
        invoices: adaptedInvoices,
        pagination: data.pagination,
      } as InvoicesResponse;
    },
  });

  // Only initialize the table if we have data and no error
  const invoices = React.useMemo(() => data?.invoices || [], [data?.invoices]);
  const tableData = React.useMemo(
    () => (isError ? [] : invoices),
    [isError, invoices]
  );

  // Apply status and type filters
  const filteredData = React.useMemo(() => {
    if (!tableData.length) return tableData;

    return tableData.filter((invoice) => {
      const status = getInvoiceStatus(invoice);
      const type = invoice.subscription ? "subscription" : "one-off";

      const statusMatch = statusFilter === "all" || status === statusFilter;
      const typeMatch = typeFilter === "all" || type === typeFilter;

      return statusMatch && typeMatch;
    });
  }, [tableData, statusFilter, typeFilter]);

  // Calculate summary statistics
  const summaryStats = React.useMemo(() => {
    if (!invoices || invoices.length === 0) {
      return {
        totalInvoices: 0,
        outstandingAmountCents: 0,
        totalRevenueCents: 0,
        overdueCount: 0,
        subscriptionInvoices: 0,
        currency: session?.merchant?.defaultCurrency || "USD",
      };
    }

    const paidInvoices = invoices.filter(
      (inv) => getInvoiceStatus(inv) === "paid"
    );
    const unpaidInvoices = invoices.filter((inv) =>
      ["pending", "overdue"].includes(getInvoiceStatus(inv))
    );
    const overdueInvoices = invoices.filter(
      (inv) => getInvoiceStatus(inv) === "overdue"
    );
    const subscriptionInvoices = invoices.filter((inv) => inv.subscription);

    const totalRevenueCents = paidInvoices.reduce(
      (sum, inv) => sum + inv.totalAmountCents,
      0
    );
    const outstandingAmountCents = unpaidInvoices.reduce(
      (sum, inv) => sum + inv.totalAmountCents,
      0
    );
    const currency =
      invoices[0]?.currency || session?.merchant?.defaultCurrency || "USD";

    return {
      totalInvoices: invoices.length,
      outstandingAmountCents,
      totalRevenueCents,
      overdueCount: overdueInvoices.length,
      subscriptionInvoices: subscriptionInvoices.length,
      currency,
    };
  }, [invoices, session?.merchant?.defaultCurrency]);

  const columns: ColumnDef<Invoice>[] = React.useMemo(
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
        accessorKey: "customerInvoiceNumber",
        header: ({ column }) => (
          <div
            className="flex items-center cursor-pointer hover:text-foreground font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Invoice #
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </div>
        ),
        cell: ({ row }) => (
          <div className="font-medium">
            {row.getValue("customerInvoiceNumber") || "—"}
          </div>
        ),
        size: 120,
        minSize: 100,
      },
      {
        id: "customer",
        accessorFn: (row) =>
          row.customer?.name || row.customer?.email || "Unknown",
        header: ({ column }) => (
          <div
            className="flex items-center cursor-pointer hover:text-foreground font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Customer
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </div>
        ),
        cell: ({ row }) => {
          const customer = row.original.customer;
          return (
            <div className="space-y-1 min-w-0">
              <div className="font-medium truncate">
                {customer?.name || "Unknown"}
              </div>
              <div className="text-sm text-muted-foreground truncate">
                {customer?.email || "No email"}
              </div>
            </div>
          );
        },
        size: 280,
        minSize: 200,
      },
      {
        id: "subscription",
        accessorFn: (row) => row.subscription?.plan.planName || null,
        header: ({ column }) => (
          <div
            className="flex items-center cursor-pointer hover:text-foreground font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Subscription
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </div>
        ),
        cell: ({ row }) => {
          const subscription = row.original.subscription;
          if (!subscription) {
            return (
              <div className="text-sm text-muted-foreground italic">
                One-off invoice
              </div>
            );
          }
          return (
            <div className="space-y-1 min-w-0">
              <div className="font-medium truncate">
                {subscription.plan.planName}
              </div>
              {subscription.plan.planDescription && (
                <div className="text-sm text-muted-foreground truncate">
                  {subscription.plan.planDescription}
                </div>
              )}
            </div>
          );
        },
        size: 200,
        minSize: 150,
      },
      {
        accessorKey: "totalAmountCents",
        header: ({ column }) => (
          <div
            className="flex items-center cursor-pointer hover:text-foreground font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Amount
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </div>
        ),
        cell: ({ row }) => (
          <div className="font-medium">
            {formatCurrency(
              row.original.totalAmountCents,
              row.original.currency ||
                session?.merchant?.defaultCurrency ||
                "USD"
            )}
          </div>
        ),
        size: 120,
        minSize: 100,
      },
      {
        id: "status",
        accessorFn: (row) => getInvoiceStatus(row),
        header: ({ column }) => (
          <div
            className="flex items-center cursor-pointer hover:text-foreground font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Status
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </div>
        ),
        cell: ({ row }) => {
          const status = getInvoiceStatus(row.original);
          const daysOverdue =
            status === "overdue" ? getDaysOverdue(row.original.dueDate) : 0;

          return (
            <div className="flex items-center gap-2">
              <Badge className={getStatusBadgeStyle(status)}>
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </Badge>
              {status === "overdue" && daysOverdue > 0 && (
                <div className="flex items-center text-red-600 text-xs">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  {daysOverdue}d
                </div>
              )}
            </div>
          );
        },
        size: 140,
        minSize: 120,
      },
      {
        accessorKey: "issueDate",
        header: ({ column }) => (
          <div
            className="flex items-center cursor-pointer hover:text-foreground font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            <Calendar className="mr-1 h-4 w-4" />
            Issued
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </div>
        ),
        cell: ({ row }) => {
          const value = row.getValue("issueDate") as string | null;
          return (
            <LocaleAwareDate date={value} fallback="—" className="text-sm" />
          );
        },
        size: 120,
        minSize: 100,
      },
      {
        accessorKey: "dueDate",
        header: ({ column }) => (
          <div
            className="flex items-center cursor-pointer hover:text-foreground font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            <Calendar className="mr-1 h-4 w-4" />
            Due
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </div>
        ),
        cell: ({ row }) => {
          const value = row.getValue("dueDate") as string | null;
          const status = getInvoiceStatus(row.original);
          const isOverdue = status === "overdue";

          return (
            <LocaleAwareDate
              date={value}
              fallback="—"
              className={`text-sm ${isOverdue ? "text-red-600 font-medium" : ""}`}
            />
          );
        },
        size: 120,
        minSize: 100,
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => {
          const invoice = row.original;
          return <InvoiceActions invoice={invoice} />;
        },
        size: 60,
        minSize: 60,
        maxSize: 60,
      },
    ],
    [session?.merchant?.defaultCurrency]
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
      const customerName = row.original.customer?.name || "";
      const customerEmail = row.original.customer?.email || "";
      const invoiceNumber =
        (row.getValue("customerInvoiceNumber") as string) || "";
      const planName = row.original.subscription?.plan.planName || "";
      const searchValue = filterValue.toLowerCase();
      return (
        customerName.toLowerCase().includes(searchValue) ||
        customerEmail.toLowerCase().includes(searchValue) ||
        invoiceNumber.toLowerCase().includes(searchValue) ||
        planName.toLowerCase().includes(searchValue)
      );
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
        handleCreateInvoice();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleCreateInvoice]);

  return (
    <PageContent
      title="Invoices"
      actions={
        <div className="flex gap-2">
          {table.getSelectedRowModel().rows.length > 0 && (
            <Button
              variant="destructive"
              onClick={() => {
                alert("Delete functionality not implemented yet");
              }}
              disabled={true}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete Selected
            </Button>
          )}
          <Link href="/invoices/create">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create Invoice
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
              <div className="text-sm text-muted-foreground">
                Total Invoices
              </div>
              <div className="text-2xl font-bold">
                {summaryStats.totalInvoices}
              </div>
            </div>
            <div className="bg-card rounded-lg border p-4">
              <div className="text-sm text-muted-foreground">Outstanding</div>
              <div className="text-2xl font-bold text-yellow-600">
                {summaryStats.outstandingAmountCents > 0
                  ? formatCurrency(
                      summaryStats.outstandingAmountCents,
                      summaryStats.currency
                    )
                  : formatCurrency(0, summaryStats.currency)}
              </div>
            </div>
            <div className="bg-card rounded-lg border p-4">
              <div className="text-sm text-muted-foreground">Total Revenue</div>
              <div className="text-2xl font-bold text-green-600">
                {summaryStats.totalRevenueCents > 0
                  ? formatCurrency(
                      summaryStats.totalRevenueCents,
                      summaryStats.currency
                    )
                  : formatCurrency(0, summaryStats.currency)}
              </div>
            </div>
            <div className="bg-card rounded-lg border p-4">
              <div className="text-sm text-muted-foreground">
                Subscription Invoices
              </div>
              <div className="text-2xl font-bold text-blue-600">
                {summaryStats.subscriptionInvoices}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {summaryStats.overdueCount} overdue
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center py-4 gap-4">
          <Input
            placeholder="Search by invoice number, customer, email, or plan..."
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
                  : statusFilter.charAt(0).toUpperCase() +
                    statusFilter.slice(1)}
                <ChevronDown className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setStatusFilter("all")}>
                All
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusFilter("draft")}>
                Draft
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusFilter("pending")}>
                Pending
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusFilter("paid")}>
                Paid
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusFilter("overdue")}>
                Overdue
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Type Filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={isPending || isError}>
                Type:{" "}
                {typeFilter === "all"
                  ? "All"
                  : typeFilter === "subscription"
                    ? "Subscription"
                    : "One-off"}
                <ChevronDown className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setTypeFilter("all")}>
                All
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTypeFilter("subscription")}>
                Subscription
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTypeFilter("one-off")}>
                One-off
              </DropdownMenuItem>
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
                .map((column) => (
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
                ))}
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
                      {headerGroup.headers.map((header) => (
                        <TableHead key={header.id}>
                          {header.isPlaceholder
                            ? null
                            : flexRender(
                                header.column.columnDef.header,
                                header.getContext()
                              )}
                        </TableHead>
                      ))}
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
                          router.push(`/invoices/${row.original.id}`)
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
