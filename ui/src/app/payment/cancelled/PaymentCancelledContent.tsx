"use client";

import { useSearchParams } from "next/navigation";

export default function PaymentCancelledContent() {
  const searchParams = useSearchParams();
  const invoiceId = searchParams.get("invoice");

  return (
    <>
      {invoiceId && (
        <p className="text-sm text-gray-500">Invoice ID: {invoiceId}</p>
      )}
    </>
  );
}
