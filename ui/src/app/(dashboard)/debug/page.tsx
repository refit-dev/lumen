"use client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSession, useActiveOrganization } from "@/lib/auth-client";
import { useState } from "react";

export default function DashboardPage() {
  const { data: session, isPending } = useSession();
  const activeOrganization = useActiveOrganization();
  const [foo] = useState<string>("{}");

  // useEffect(() => {
  //   if (!isPending && session?.user?.id) {
  //     const getFoo = async () => {
  //       const response = await trpc.test.list.query();
  //       setFoo(JSON.stringify(response, null, 2));
  //     };
  //     getFoo();
  //   }
  // }, [session, isPending]);

  // Show loading state while session is being fetched
  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-lg">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">Debug cards</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Active Organization
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold break-all">
              {activeOrganization?.data?.name || "No active organization"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">User ID</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold break-all">
              {session?.user?.id || "No user ID"}
            </div>
          </CardContent>
        </Card>
        <Card className="md:col-span-2 lg:col-span-4">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Foo</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm font-mono whitespace-pre-wrap break-all bg-muted p-4 rounded-md">
              {JSON.stringify(JSON.parse(foo), null, 2)}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
