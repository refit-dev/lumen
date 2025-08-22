"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/hono-client";
import { useSession } from "@/lib/auth-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Pencil, Trash2, Loader2, AlertCircle } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { CreateTaxRateDefinitionForm } from "@/components/dashboard/CreateTaxRateDefinitionForm";
import { EditTaxRateDefinitionForm } from "@/components/dashboard/EditTaxRateDefinitionForm";

interface TaxRateDefinition {
  id: string;
  merchantId: string;
  name: string;
  description: string | null;
  taxRate: string;
  jurisdiction: string | null;
  taxType: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function TaxRateDefinitionsManager() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingDefinition, setEditingDefinition] =
    useState<TaxRateDefinition | null>(null);

  const merchantId = session?.merchant?.id;

  // Fetch tax rate definitions
  const { data: taxRateDefinitions, isLoading } = useQuery({
    queryKey: ["tax-rate-definitions", merchantId],
    queryFn: async () => {
      if (!merchantId) return [];
      const response = await apiClient.tax["rate-definitions"].$get();
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error as string);
      }
      return data as TaxRateDefinition[];
    },
    enabled: !!merchantId,
  });

  // Deactivate tax rate definition
  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await apiClient.tax["rate-definitions"][":id"][
        "update"
      ].$post({
        param: { id },
        json: { isActive: false },
      });
      const data = await response.json();
      if ("error" in data) {
        throw new Error(data.error as string);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["tax-rate-definitions", merchantId],
      });
    },
  });

  const formatTaxRate = (taxRate: string) => {
    const rate = parseFloat(taxRate);
    return `${(rate * 100).toFixed(2)}%`;
  };

  const handleCreateSuccess = () => {
    setShowCreateForm(false);
    queryClient.invalidateQueries({
      queryKey: ["tax-rate-definitions", merchantId],
    });
  };

  const handleEditSuccess = () => {
    setEditingDefinition(null);
    queryClient.invalidateQueries({
      queryKey: ["tax-rate-definitions", merchantId],
    });
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Tax Rate Definitions</CardTitle>
              <p className="text-sm text-muted-foreground mt-3">
                Create reusable tax rate definitions that can be manually
                assigned to customers.
              </p>
            </div>
            <Button onClick={() => setShowCreateForm(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Tax Rate
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!taxRateDefinitions || taxRateDefinitions.length === 0 ? (
            <div className="text-center py-8">
              <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                No tax rate definitions
              </h3>
              <p className="text-sm text-muted-foreground mb-4">
                Create tax rate templates to standardize tax rates across
                customers
              </p>
              <Button onClick={() => setShowCreateForm(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create Your First Tax Rate
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Rate</TableHead>
                  <TableHead>Jurisdiction</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {taxRateDefinitions.map((definition) => (
                  <TableRow key={definition.id}>
                    <TableCell className="font-medium">
                      {definition.name}
                    </TableCell>
                    <TableCell>{formatTaxRate(definition.taxRate)}</TableCell>
                    <TableCell>
                      {definition.jurisdiction || (
                        <span className="text-muted-foreground">
                          Not specified
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={definition.isActive ? "default" : "secondary"}
                      >
                        {definition.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {definition.description || (
                        <span className="text-muted-foreground">
                          No description
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEditingDefinition(definition)}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        {definition.isActive && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="outline" size="sm">
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  Deactivate Tax Rate Definition
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  Are you sure you want to deactivate &quot;
                                  {definition.name}&quot;? This will prevent it
                                  from being assigned to new customers, but
                                  existing customers using this rate will be
                                  unaffected.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() =>
                                    deactivateMutation.mutate(definition.id)
                                  }
                                  className="bg-red-600 text-white hover:bg-red-700"
                                >
                                  Deactivate
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create Tax Rate Definition Modal */}
      {showCreateForm && (
        <CreateTaxRateDefinitionForm
          onSuccess={handleCreateSuccess}
          onCancel={() => setShowCreateForm(false)}
        />
      )}

      {/* Edit Tax Rate Definition Modal */}
      {editingDefinition && (
        <EditTaxRateDefinitionForm
          definition={editingDefinition}
          onSuccess={handleEditSuccess}
          onCancel={() => setEditingDefinition(null)}
        />
      )}
    </div>
  );
}
