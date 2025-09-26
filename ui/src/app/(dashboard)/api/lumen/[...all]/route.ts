import { NextRequest, NextResponse } from "next/server";
import { apiClient } from "@/lib/auth-client";
import { lumenNextHandler } from "@getlumen/server";

const handler = async (request: NextRequest) => {
  const response = await apiClient.get("/v1/lumen/user", {
    headers: request.headers,
  });
  if (!response.ok) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { user } = await response.json();

  return NextResponse.json(
    await lumenNextHandler({
      request,
      userId: user.id,
    })
  );
};

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as DELETE,
  handler as PATCH,
  handler as OPTIONS,
  handler as HEAD,
};
