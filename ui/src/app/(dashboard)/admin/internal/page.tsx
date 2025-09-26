"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { apiClient } from "@/lib/hono-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";

type InternalKVRow = {
  key: string;
  value: unknown;
  createdAt?: string;
  updatedAt?: string;
};

export default function InternalKeyValuesPage() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const isAdmin = session?.user?.role === "admin";

  const [rows, setRows] = useState<InternalKVRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editKey, setEditKey] = useState("");
  const [editValue, setEditValue] = useState("{}");

  const loadRows = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiClient.internal["internal-key-values"].$get();
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const message =
          (body as { error?: string })?.error ||
          "Failed to load internal key values";
        throw new Error(message);
      }
      const { items } = (await res.json()) as { items: InternalKVRow[] };
      setRows(items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isPending && !isAdmin) {
      router.push("/dashboard");
      return;
    }
    if (isAdmin) loadRows();
  }, [isPending, isAdmin, router, loadRows]);

  const startEdit = (row?: InternalKVRow) => {
    if (row) {
      setEditingKey(row.key);
      setEditKey(row.key);
      setEditValue(JSON.stringify(row.value, null, 2));
    } else {
      setEditingKey("");
      setEditKey("");
      setEditValue("{}");
    }
  };

  const saveEdit = async () => {
    try {
      setError(null);
      let parsed: unknown;
      try {
        parsed = JSON.parse(editValue || "null");
      } catch {
        throw new Error("Value must be valid JSON");
      }

      if (!editKey) throw new Error("Key is required");

      const res = await apiClient.internal["internal-key-values"][":key"].$put({
        param: { key: editKey },
        json: { value: parsed },
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const message =
          (body as { error?: string })?.error || "Failed to save value";
        throw new Error(message);
      }
      await loadRows();
      setEditingKey(null);
      setEditKey("");
      setEditValue("{}");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (isPending) return <div>Loading...</div>;
  if (!isAdmin) return null;

  return (
    <div className="container mx-auto p-6 space-y-8 max-w-5xl">
      <Card>
        <CardHeader>
          <CardTitle>Internal Key Values</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex items-center gap-2">
            <Button onClick={() => loadRows()} disabled={loading}>
              Refresh
            </Button>
            <Button variant="secondary" onClick={() => startEdit()}>
              New Key
            </Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-64">Key</TableHead>
                <TableHead>Value (JSON)</TableHead>
                <TableHead className="w-36">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="font-mono text-sm">{row.key}</TableCell>
                  <TableCell>
                    <pre className="whitespace-pre-wrap break-words text-xs bg-muted rounded p-2 max-h-48 overflow-auto">
                      {JSON.stringify(row.value, null, 2)}
                    </pre>
                  </TableCell>
                  <TableCell>
                    <Button size="sm" onClick={() => startEdit(row)}>
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && !loading && (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-center text-sm text-muted-foreground"
                  >
                    No keys found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {editingKey !== null && (
            <div className="space-y-3 border rounded p-4">
              <div className="flex gap-2 items-center">
                <label className="w-20 text-sm text-muted-foreground">
                  Key
                </label>
                <Input
                  value={editKey}
                  onChange={(e) => setEditKey(e.target.value)}
                  placeholder="yc-companies-placeholder.com"
                />
              </div>
              <div className="flex gap-2 items-start">
                <label className="w-20 text-sm text-muted-foreground pt-2">
                  Value
                </label>
                <Textarea
                  className="font-mono min-h-[160px]"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  placeholder={`{\n  \"example\": true\n}`}
                />
              </div>
              <div className="flex gap-2">
                <Button onClick={saveEdit}>Save</Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEditingKey(null);
                    setEditKey("");
                    setEditValue("{}");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
