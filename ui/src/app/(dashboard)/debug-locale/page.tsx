"use client";

import { useDateFormatter, useLocaleContext } from "@/lib/locale-context";
import { formatDate } from "@/lib/locale";

export default function DebugLocalePage() {
  const dateFormatter = useDateFormatter();
  const localeContext = useLocaleContext();

  const testDate = new Date("2025-07-04"); // July 4th, 2025

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">Locale Debug Page</h1>

      <div className="bg-gray-50 p-4 rounded">
        <h2 className="font-semibold mb-2">Locale Context Info:</h2>
        <pre className="text-sm">{JSON.stringify(localeContext, null, 2)}</pre>
      </div>

      <div className="bg-blue-50 p-4 rounded">
        <h2 className="font-semibold mb-2">Test Date Formatting:</h2>
        <p>
          <strong>Test Date:</strong> July 4th, 2025
        </p>
        <p>
          <strong>Browser Default:</strong> {testDate.toLocaleDateString()}
        </p>
        <p>
          <strong>Browser w/ time:</strong> {testDate.toLocaleString()}
        </p>
        <p>
          <strong>Our formatDateLegacy:</strong>{" "}
          {dateFormatter.formatDateLegacy(testDate)}
        </p>
        <p>
          <strong>Our formatDate (short):</strong>{" "}
          {dateFormatter.formatDate(testDate, { style: "short" })}
        </p>
        <p>
          <strong>Our formatDate (medium):</strong>{" "}
          {dateFormatter.formatDate(testDate, { style: "medium" })}
        </p>
        <p>
          <strong>Our formatDate (long):</strong>{" "}
          {dateFormatter.formatDate(testDate, { style: "long" })}
        </p>
      </div>

      <div className="bg-green-50 p-4 rounded">
        <h2 className="font-semibold mb-2">Direct Utility Testing:</h2>
        <p>
          <strong>formatDate with DE:</strong>{" "}
          {formatDate(testDate, { merchantCountry: "DE", style: "medium" })}
        </p>
        <p>
          <strong>formatDate with US:</strong>{" "}
          {formatDate(testDate, { merchantCountry: "US", style: "medium" })}
        </p>
        <p>
          <strong>formatDate with JP:</strong>{" "}
          {formatDate(testDate, { merchantCountry: "JP", style: "medium" })}
        </p>
      </div>

      <div className="bg-yellow-50 p-4 rounded">
        <h2 className="font-semibold mb-2">Expected vs Actual:</h2>
        <p>
          <strong>German Expected:</strong> 04.07.2025
        </p>
        <p>
          <strong>US Expected:</strong> 7/4/2025
        </p>
        <p>
          <strong>Japanese Expected:</strong> 2025/07/04
        </p>
      </div>
    </div>
  );
}
