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
  CreditCard,
  Filter,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiClient } from "@/lib/hono-client";
import { formatCurrency } from "@lumen/common/utils";
import { PageContent } from "@/components/dashboard/page-content";
import { FailedToLoadError } from "@/components/dashboard/failed-to-load-error";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";

// Define Payment type based on the API response
type Payment = {
  id: string;
  merchantId: string;
  invoiceId: string;
  paymentMethodId: string;
  externalPaymentId: string | null;
  amountCents: number;
  currency: string;
  status: string;
  errorMessage: string | null;
  refundedAmountCents: number | null;
  refundStatus: string | null;
  createdAt: string;
  updatedAt: string;
  // Related entity information
  customerInvoiceNumber: string | null;
  customerName: string | null;
  subscriptionId: string | null;
  subscriptionStableId: string | null;
  planId: string | null;
  planName: string | null;
};

// Response type for payments list
type PaymentsResponse = {
  payments: Payment[];
};

const PaymentActions = ({ payment }: { payment: Payment }) => {
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
            navigator.clipboard.writeText(payment.id);
          }}
        >
          Copy payment ID
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(payment.invoiceId);
          }}
        >
          Copy invoice ID
        </DropdownMenuItem>
        {payment.externalPaymentId && (
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard.writeText(payment.externalPaymentId!);
            }}
          >
            Copy external payment ID
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const getPaymentStatusColor = (status: string) => {
  switch (status) {
    case "succeeded":
      return "bg-green-100 text-green-800 border-green-200";
    case "pending":
      return "bg-yellow-100 text-yellow-800 border-yellow-200";
    case "failed":
      return "bg-red-100 text-red-800 border-red-200";
    case "canceled":
      return "bg-gray-100 text-gray-800 border-gray-200";
    default:
      return "bg-gray-100 text-gray-800 border-gray-200";
  }
};

export default function PaymentsPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  );
  const [columnVisibility, setColumnVisibility] =
    React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState({});

  // Fetch payments data
  const {
    data: paymentsData,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["payments"],
    queryFn: async () => {
      const response = await apiClient.payments.$get();
      if (!response.ok) {
        throw new Error("Failed to fetch payments");
      }
      return (await response.json()) as PaymentsResponse;
    },
  });

  // Define columns
  const columns: ColumnDef<Payment>[] = React.useMemo(
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
      },

      {
        accessorKey: "amountCents",
        header: ({ column }) => {
          return (
            <div
              className="flex items-center cursor-pointer hover:text-foreground font-semibold"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Amount
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const amount = row.getValue("amountCents") as number;
          const currency =
            row.original.currency ||
            session?.merchant?.defaultCurrency ||
            "USD";
          return (
            <div className="font-semibold">
              {formatCurrency(amount, currency)}
            </div>
          );
        },
      },
      {
        accessorKey: "status",
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
          const isRefunded = (row.original.refundedAmountCents || 0) > 0;
          return isRefunded ? (
            <Badge
              variant="outline"
              className="bg-purple-100 text-purple-800 border-purple-200"
            >
              {row.original.refundStatus && row.original.refundStatus !== "full"
                ? "partially refunded"
                : "refunded"}
            </Badge>
          ) : (
            <Badge variant="outline" className={getPaymentStatusColor(status)}>
              {status}
            </Badge>
          );
        },
      },
      {
        accessorKey: "customerName",
        header: "Customer",
        cell: ({ row }) => (
          <div className="text-sm">
            {row.getValue("customerName") || "Unknown"}
          </div>
        ),
      },

      {
        accessorKey: "planName",
        header: "Plan",
        cell: ({ row }) => {
          const planName = row.getValue("planName") as string;
          return (
            <div className="text-sm">
              {planName ? (
                planName
              ) : (
                <span className="text-gray-500 font-mono text-xs">N/A</span>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: "invoiceId",
        header: "Invoice",
        cell: ({ row }) => {
          const invoiceId = row.getValue("invoiceId") as string;
          const invoiceNumber = row.original.customerInvoiceNumber;
          return (
            <div className="text-sm">
              {invoiceNumber && invoiceNumber !== "N/A" && invoiceId ? (
                <a
                  href={`/invoices/${invoiceId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block px-2 py-1 text-xs font-semibold font-mono text-gray-700 bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 hover:border-gray-400 transition-colors"
                >
                  {invoiceNumber}
                </a>
              ) : (
                <span className="text-gray-500 font-mono text-xs">N/A</span>
              )}
            </div>
          );
        },
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
              Created
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </div>
          );
        },
        cell: ({ row }) => {
          const value = row.getValue("createdAt");
          return (
            <LocaleAwareDate
              date={value as string | Date | null}
              fallback="-"
              className="text-sm"
            />
          );
        },
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => <PaymentActions payment={row.original} />,
      },
    ],
    [session?.merchant?.defaultCurrency]
  );

  const table = useReactTable({
    data: paymentsData?.payments || [],
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
  });

  if (isError) {
    return (
      <PageContent title="Payments">
        <FailedToLoadError />
      </PageContent>
    );
  }

  // Calculate summary stats
  const totalPayments = paymentsData?.payments?.length || 0;
  const succeededPayments =
    paymentsData?.payments?.filter((p) => p.status === "succeeded").length || 0;
  const totalAmount =
    paymentsData?.payments?.reduce((sum, p) => sum + p.amountCents, 0) || 0;
  const succeededAmount =
    paymentsData?.payments
      ?.filter((p) => p.status === "succeeded")
      .reduce((sum, p) => sum + p.amountCents, 0) || 0;

  return (
    <PageContent title="Payments">
      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Total Payments
            </CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalPayments}</div>
            <p className="text-xs text-muted-foreground">
              {succeededPayments} successful
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Volume</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(
                totalAmount,
                paymentsData?.payments?.[0]?.currency ||
                  session?.merchant?.defaultCurrency ||
                  "USD"
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {formatCurrency(
                succeededAmount,
                paymentsData?.payments?.[0]?.currency ||
                  session?.merchant?.defaultCurrency ||
                  "USD"
              )}{" "}
              successful
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {totalPayments > 0
                ? Math.round((succeededPayments / totalPayments) * 100)
                : 0}
              %
            </div>
            <p className="text-xs text-muted-foreground">
              Payment success rate
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg. Amount</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(
                totalPayments > 0 ? Math.round(totalAmount / totalPayments) : 0,
                paymentsData?.payments?.[0]?.currency ||
                  session?.merchant?.defaultCurrency ||
                  "USD"
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Average payment amount
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Payments Table */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Input
              placeholder="Search by customer..."
              value={
                (table.getColumn("customerName")?.getFilterValue() as string) ??
                ""
              }
              onChange={(event) =>
                table
                  .getColumn("customerName")
                  ?.setFilterValue(event.target.value)
              }
              className="max-w-sm"
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="ml-auto">
                  <Filter className="mr-2 h-4 w-4" />
                  Status
                  <ChevronDown className="ml-2 h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {["succeeded", "pending", "failed", "canceled"].map(
                  (status) => (
                    <DropdownMenuCheckboxItem
                      key={status}
                      className="capitalize"
                      checked={
                        table.getColumn("status")?.getFilterValue() === status
                      }
                      onCheckedChange={(value) =>
                        table
                          .getColumn("status")
                          ?.setFilterValue(value ? status : "")
                      }
                    >
                      {status}
                    </DropdownMenuCheckboxItem>
                  )
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="ml-auto">
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
              {isLoading ? (
                Array.from({ length: 10 }).map((_, index) => (
                  <TableRow key={index}>
                    {columns.map((_, cellIndex) => (
                      <TableCell key={cellIndex}>
                        <Skeleton className="h-4 w-full" />
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
                    onClick={() => router.push(`/payments/${row.original.id}`)}
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
                    <div className="flex flex-col items-center justify-center space-y-2">
                      <CreditCard className="h-12 w-12 text-muted-foreground" />
                      <p className="text-lg font-medium">No payments found</p>
                      <p className="text-sm text-muted-foreground">
                        Payments will appear here once customers start making
                        payments
                      </p>
                    </div>
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
      </div>
    </PageContent>
  );
}
