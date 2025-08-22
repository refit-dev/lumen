"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession, admin } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

import {
  AlertCircle,
  Users,
  Search,
  UserCheck,
  Crown,
  User as UserIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useRouter } from "next/navigation";
import { LocaleAwareDate } from "@/components/ui/locale-aware-date";

interface User {
  id: string;
  name: string;
  email: string;
  role?: string;
  banned?: boolean | null;
  banReason?: string | null;
  banExpires?: Date | string | null;
  createdAt: string | Date;
  emailVerified: boolean;
}

export default function AdminPanel() {
  const { data: session, isPending } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const [pagination, setPagination] = useState({
    total: 0,
    limit: 20,
    offset: 0,
  });
  const router = useRouter();

  // Check if user is admin
  const isAdmin = session?.user?.role === "admin";

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const result = await admin.listUsers({
        query: {
          limit: pagination.limit,
          offset: pagination.offset,
          ...(searchTerm && {
            searchValue: searchTerm,
            searchField: "email",
            searchOperator: "contains",
          }),
        },
      });

      if (result.error) {
        setError(result.error.message || "Failed to load users");
        return;
      }

      if (result.data) {
        setUsers(result.data.users);
        setPagination((prev) => ({
          ...prev,
          total: result.data.total,
        }));
      }
    } catch (err) {
      setError("Failed to load users");
      console.error("Error loading users:", err);
    } finally {
      setLoading(false);
    }
  }, [pagination.limit, pagination.offset, searchTerm]);

  useEffect(() => {
    if (!isPending && !isAdmin) {
      router.push("/dashboard");
      return;
    }

    if (isAdmin) {
      loadUsers();
    }
  }, [isPending, isAdmin, router, loadUsers]);

  const handleImpersonate = async (userId: string) => {
    try {
      setImpersonating(userId);
      const result = await admin.impersonateUser({ userId });

      if (result.error) {
        setError(`Failed to impersonate user: ${result.error.message}`);
        return;
      }

      // Refresh the page to get the new session
      window.location.href = "/dashboard";
    } catch (err) {
      setError("Failed to impersonate user");
      console.error("Error impersonating user:", err);
    } finally {
      setImpersonating(null);
    }
  };

  const handleSearch = () => {
    setPagination((prev) => ({ ...prev, offset: 0 }));
    loadUsers();
  };

  const handleNextPage = () => {
    setPagination((prev) => ({
      ...prev,
      offset: Math.min(prev.offset + prev.limit, prev.total - 1),
    }));
  };

  const handlePrevPage = () => {
    setPagination((prev) => ({
      ...prev,
      offset: Math.max(0, prev.offset - prev.limit),
    }));
  };

  useEffect(() => {
    if (pagination.offset > 0) {
      loadUsers();
    }
  }, [pagination.offset, loadUsers]);

  if (isPending) {
    return <div>Loading...</div>;
  }

  if (!isAdmin) {
    return null; // Will redirect
  }

  const currentPage = Math.floor(pagination.offset / pagination.limit) + 1;
  const totalPages = Math.ceil(pagination.total / pagination.limit);

  return (
    <div className="container mx-auto p-6 space-y-8 max-w-7xl">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Admin Panel</h1>
          <p className="text-muted-foreground text-lg">
            Manage users and perform administrative tasks
          </p>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-blue-100 p-3">
                <Users className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Total Users
                </p>
                <p className="text-2xl font-bold">{pagination.total}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-green-100 p-3">
                <UserCheck className="h-6 w-6 text-green-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Active Users
                </p>
                <p className="text-2xl font-bold">
                  {users.filter((u) => !u.banned).length}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-purple-100 p-3">
                <Crown className="h-6 w-6 text-purple-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Admins
                </p>
                <p className="text-2xl font-bold">
                  {users.filter((u) => u.role === "admin").length}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Search and Filters */}
      <Card>
        <CardContent className="p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-xl font-semibold">User Management</h2>
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1 md:w-80">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by email..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  className="pl-10"
                />
              </div>
              <Button onClick={handleSearch} size="default">
                Search
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Users Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Users ({pagination.total})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex flex-col items-center gap-3">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                <p className="text-muted-foreground">Loading users...</p>
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-md border-0">
                <Table>
                  <TableHeader>
                    <TableRow className="border-b bg-muted/50">
                      <TableHead className="h-12 px-6 font-semibold">
                        User
                      </TableHead>
                      <TableHead className="h-12 px-6 font-semibold">
                        Role
                      </TableHead>
                      <TableHead className="h-12 px-6 font-semibold">
                        Status
                      </TableHead>
                      <TableHead className="h-12 px-6 font-semibold">
                        Joined
                      </TableHead>
                      <TableHead className="h-12 px-6 font-semibold text-right">
                        Actions
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((user) => (
                      <TableRow
                        key={user.id}
                        className="border-b hover:bg-muted/20"
                      >
                        <TableCell className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-white font-semibold text-sm">
                              {user.name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <p className="font-medium">{user.name}</p>
                              <p className="text-sm text-muted-foreground">
                                {user.email}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="px-6 py-4">
                          <Badge
                            variant={
                              user.role === "admin" ? "default" : "secondary"
                            }
                            className={`${
                              user.role === "admin"
                                ? "bg-gradient-to-r from-purple-600 to-blue-600 text-white"
                                : "bg-gray-100 text-gray-700"
                            }`}
                          >
                            {user.role === "admin" && (
                              <Crown className="h-3 w-3 mr-1" />
                            )}
                            {user.role === "admin" ? "Admin" : "Owner"}
                          </Badge>
                        </TableCell>
                        <TableCell className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            {user.banned === true ? (
                              <Badge variant="destructive" className="gap-1">
                                <AlertCircle className="h-3 w-3" />
                                Banned
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="border-green-200 bg-green-50 text-green-700 gap-1"
                              >
                                <div className="h-2 w-2 rounded-full bg-green-500"></div>
                                Active
                              </Badge>
                            )}
                            {user.emailVerified && (
                              <UserCheck className="h-4 w-4 text-green-500" />
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="px-6 py-4 text-muted-foreground">
                          <LocaleAwareDate
                            date={
                              user.createdAt instanceof Date
                                ? user.createdAt
                                : new Date(user.createdAt)
                            }
                            style="medium"
                            className="text-sm text-muted-foreground"
                          />
                        </TableCell>
                        <TableCell className="px-6 py-4 text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleImpersonate(user.id)}
                            disabled={
                              impersonating === user.id ||
                              user.id === session?.user?.id
                            }
                            className="gap-1"
                          >
                            {impersonating === user.id ? (
                              <>
                                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-current"></div>
                                Impersonating...
                              </>
                            ) : (
                              <>
                                <UserIcon className="h-3 w-3" />
                                Impersonate
                              </>
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {users.length === 0 && !loading && (
                <div className="flex flex-col items-center justify-center py-12">
                  <div className="rounded-full bg-muted p-4 mb-4">
                    <Users className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2">No users found</h3>
                  <p className="text-muted-foreground text-center max-w-md">
                    {searchTerm
                      ? "No users match your search criteria. Try adjusting your search terms."
                      : "There are no users in the system yet."}
                  </p>
                </div>
              )}

              {totalPages > 1 && (
                <div className="flex items-center justify-between p-6 border-t bg-muted/20">
                  <p className="text-sm text-muted-foreground">
                    Showing {pagination.offset + 1} to{" "}
                    {Math.min(
                      pagination.offset + pagination.limit,
                      pagination.total
                    )}{" "}
                    of {pagination.total} users
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handlePrevPage}
                      disabled={pagination.offset === 0}
                    >
                      Previous
                    </Button>
                    <div className="flex items-center gap-1 px-3 py-1 text-sm bg-muted rounded-md">
                      Page {currentPage} of {totalPages}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleNextPage}
                      disabled={
                        pagination.offset + pagination.limit >= pagination.total
                      }
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
