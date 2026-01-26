// bun run scripts/generate-standalone-pricing-table.ts
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import ts from "typescript";

interface ComponentInfo {
  name: string;
  content: string;
  exports: string[];
}

/**
 * Extract component exports from a file content
 */
function extractExports(content: string): string[] {
  const exports: string[] = [];

  // Match: export { ComponentName, ... }
  const namedExportMatch = content.match(/export\s+\{([^}]+)\}/g);
  if (namedExportMatch) {
    namedExportMatch.forEach((match) => {
      const names = match
        .replace(/export\s+\{/, "")
        .replace(/\}/, "")
        .split(",")
        .map((n) => n.trim().split(" as ")[0]);
      exports.push(...names);
    });
  }

  // Match: export function ComponentName
  const functionExports = content.matchAll(
    /export\s+(?:async\s+)?function\s+(\w+)/g
  );
  for (const match of functionExports) {
    exports.push(match[1]);
  }

  // Match: export const componentName = ...
  const constExports = content.matchAll(/export\s+const\s+(\w+)/g);
  for (const match of constExports) {
    exports.push(match[1]);
  }

  return [...new Set(exports)];
}

/**
 * Parse import statements from content to find shadcn dependencies
 */
function parseShadcnImports(content: string): string[] {
  const imports: string[] = [];

  // Match imports from "./componentName"
  const importMatches = content.matchAll(
    /import\s+{[^}]+}\s+from\s+["']\.\/([^"']+)["']/g
  );
  for (const match of importMatches) {
    imports.push(match[1]);
  }

  return [...new Set(imports)];
}

/**
 * Read and process a shadcn component file
 */
function readShadcnComponent(componentName: string): ComponentInfo {
  const componentPath = resolve(
    process.cwd(),
    `ui/src/components/ui/${componentName}.tsx`
  );

  let content = readFileSync(componentPath, "utf-8");

  // Remove "use client" directives
  content = content.replace(/["']use client["'];?\n?/g, "");

  // Remove import of cn utility (we'll inline it)
  content = content.replace(
    /import\s+{\s*cn\s*}\s+from\s+["']@\/lib\/utils["'];?\n?/g,
    ""
  );

  // Remove any imports from other local shadcn components (we'll handle them separately)
  content = content.replace(
    /import\s+{[^}]+}\s+from\s+["']\.\/[^"']+["'];?\n?/g,
    ""
  );

  // Remove ALL import statements (we'll consolidate them at the top)
  content = content.replace(
    /import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:{[^}]+}|\*\s+as\s+\w+))?\s+from\s+["'][^"']+["'];?\n?/g,
    ""
  );

  const exports = extractExports(content);

  return {
    name: componentName,
    content: content.trim(),
    exports,
  };
}

/**
 * Get all external dependencies (non-shadcn imports)
 */
function extractExternalDependencies(content: string): Set<string> {
  const dependencies = new Set<string>();

  // Match all import statements
  const importMatches = content.matchAll(
    /import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:{[^}]+}|\*\s+as\s+\w+))?\s+from\s+["']([^"']+)["']/g
  );

  for (const match of importMatches) {
    const importPath = match[1];
    // Keep external dependencies (not local ./ imports and not @/lib/utils)
    if (!importPath.startsWith("./") && !importPath.startsWith("@/")) {
      dependencies.add(match[0]);
    }
  }

  return dependencies;
}

/**
 * Build the dependency graph for shadcn components
 */
function buildDependencyGraph(
  startComponent: string
): Map<string, ComponentInfo> {
  const components = new Map<string, ComponentInfo>();
  const queue: string[] = [startComponent];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    try {
      const componentInfo = readShadcnComponent(current);
      components.set(current, componentInfo);

      // Find shadcn dependencies in the original file before processing
      const originalPath = resolve(
        process.cwd(),
        `ui/src/components/ui/${current}.tsx`
      );
      const originalContent = readFileSync(originalPath, "utf-8");
      const deps = parseShadcnImports(originalContent);

      // Add dependencies to queue
      for (const dep of deps) {
        if (!visited.has(dep)) {
          queue.push(dep);
        }
      }
    } catch (error) {
      console.warn(`Warning: Could not read component ${current}:`, error);
    }
  }

  return components;
}

/**
 * Strip TypeScript types from content to generate JavaScript version
 * Uses the TypeScript compiler API for accurate transpilation
 */
function stripTypeScript(content: string): string {
  const result = ts.transpileModule(content, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      removeComments: false,
    },
  });

  return result.outputText;
}

/**
 * Generate the standalone pricing table file
 */
function generateStandaloneFile(): void {
  console.log("🔨 Building standalone pricing table component...\n");

  // Read the main pricing-table component
  const pricingTablePath = resolve(
    process.cwd(),
    "ui/src/components/ui/pricing-table.tsx"
  );
  let pricingTableContent = readFileSync(pricingTablePath, "utf-8");

  // Collect all external dependencies
  const allExternalDeps = new Set<string>();

  // Get external dependencies from pricing-table
  const pricingTableDeps = extractExternalDependencies(pricingTableContent);
  pricingTableDeps.forEach((dep) => allExternalDeps.add(dep));

  // Find all shadcn component dependencies
  const shadcnImports = parseShadcnImports(pricingTableContent);
  console.log("📦 Found shadcn dependencies:", shadcnImports.join(", "));

  // Build dependency graph (includes transitive dependencies)
  const allComponents = new Map<string, ComponentInfo>();
  for (const importName of shadcnImports) {
    const deps = buildDependencyGraph(importName);
    deps.forEach((info, name) => {
      allComponents.set(name, info);
    });
  }

  // Collect external dependencies from all shadcn components
  allComponents.forEach((info) => {
    const componentPath = resolve(
      process.cwd(),
      `ui/src/components/ui/${info.name}.tsx`
    );
    const originalContent = readFileSync(componentPath, "utf-8");
    const componentDeps = extractExternalDependencies(originalContent);
    componentDeps.forEach((dep) => allExternalDeps.add(dep));
  });

  console.log(
    "📦 Total components (including transitive):",
    Array.from(allComponents.keys()).join(", ")
  );

  // Remove "use client" from pricing table
  pricingTableContent = pricingTableContent.replace(
    /["']use client["'];?\n?/g,
    ""
  );

  // Remove all shadcn imports from pricing table
  pricingTableContent = pricingTableContent.replace(
    /import\s+{[^}]+}\s+from\s+["']\.\/[^"']+["'];?\n?/g,
    ""
  );

  // Remove cn import from pricing table
  pricingTableContent = pricingTableContent.replace(
    /import\s+{\s*cn\s*}\s+from\s+["']@\/lib\/utils["'];?\n?/g,
    ""
  );

  // Remove inline cn utility function if it exists in pricing table
  // Match the exact pattern with proper brace handling
  pricingTableContent = pricingTableContent.replace(
    /\/\/ Utility function for merging class names\s*\nconst cn = \([^)]+\)[^{]*\{\s*return classes\.filter\(Boolean\)\.join\([^)]+\);\s*\};\s*\n?/g,
    ""
  );

  // Remove all other imports from pricing table (we've collected them)
  pricingTableContent = pricingTableContent.replace(
    /import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:{[^}]+}|\*\s+as\s+\w+))?\s+from\s+["'][^"']+["'];?\n?/g,
    ""
  );

  // Build the final file
  const lines: string[] = [];

  // Add header comment (TypeScript version only - JS gets it after transpilation)
  lines.push("/**");
  lines.push(" * Lumen Billing - Standalone Pricing Table Component");
  lines.push(" *");
  lines.push(
    " * Self-contained pricing table with all shadcn dependencies bundled."
  );
  lines.push(
    " * Compatible with any React + Tailwind setup (CRA, Vite, Next.js, etc.)"
  );
  lines.push(" *");
  lines.push(
    " * Setup: Update tailwind.config.js to scan this file, add CSS variables."
  );
  lines.push(" * See installation guide at: https://docs.getlumen.dev");
  lines.push(" *");
  lines.push(" * Generated automatically - do not edit directly");
  lines.push(" */");
  lines.push("");

  // Add all unique external imports
  lines.push("// External dependencies");
  const sortedDeps = Array.from(allExternalDeps).sort();
  sortedDeps.forEach((dep) => lines.push(dep));
  lines.push("");

  // Add cn utility inline
  lines.push(
    "// ----------------------------------------------------------------------------"
  );
  lines.push("// Utility: cn (class name merger)");
  lines.push(
    "// ----------------------------------------------------------------------------"
  );
  lines.push("");
  lines.push('import { clsx, type ClassValue } from "clsx";');
  lines.push('import { twMerge } from "tailwind-merge";');
  lines.push("");
  lines.push("function cn(...inputs: ClassValue[]) {");
  lines.push("  return twMerge(clsx(inputs));");
  lines.push("}");
  lines.push("");

  // Add all shadcn components
  lines.push(
    "// ----------------------------------------------------------------------------"
  );
  lines.push("// Shadcn UI Components (bundled)");
  lines.push(
    "// ----------------------------------------------------------------------------"
  );
  lines.push("");

  allComponents.forEach((info, name) => {
    lines.push(`// Component: ${name}`);
    lines.push(info.content);
    lines.push("");
  });

  // Add the main pricing table component
  lines.push(
    "// ----------------------------------------------------------------------------"
  );
  lines.push("// Main Pricing Table Component");
  lines.push(
    "// ----------------------------------------------------------------------------"
  );
  lines.push("");
  lines.push(pricingTableContent.trim());
  lines.push("");

  const finalContent = lines.join("\n");

  // Write TypeScript version to output file (in public folder for download)
  const tsOutputPath = resolve(
    process.cwd(),
    "ui/public/pricing-table-standalone.tsx"
  );
  writeFileSync(tsOutputPath, finalContent, "utf-8");

  console.log(
    "\n✅ Successfully generated standalone pricing table (TypeScript)!"
  );
  console.log(`📄 Output: ${tsOutputPath}`);
  console.log(`📊 File size: ${(finalContent.length / 1024).toFixed(2)} KB`);
  console.log(`🧩 Bundled ${allComponents.size} shadcn components`);

  // Generate JavaScript version
  let jsContent = stripTypeScript(finalContent);

  // Replace header comment with JS-safe version (avoid TS transpiler mangling)
  const jsHeader = `/**
 * Lumen Billing - Standalone Pricing Table Component
 *
 * Self-contained pricing table with all shadcn dependencies bundled.
 * Compatible with any React + Tailwind setup (CRA, Vite, Next.js, etc.)
 *
 * SETUP REQUIRED:
 * 1. Add to tailwind.config.js content array:
 *    './src/pricing-table-standalone.jsx'
 *
 * 2. Add to your main CSS file (index.css, App.css, etc.):
 *    See https://docs.getlumen.dev for CSS variables
 *
 * 3. Restart your dev server
 *
 * Generated automatically - do not edit directly
 */

`;

  // Replace the first comment block
  jsContent = jsContent.replace(/^\/\*\*[\s\S]*?\*\/\s*/, jsHeader);

  const jsOutputPath = resolve(
    process.cwd(),
    "ui/public/pricing-table-standalone.jsx"
  );
  writeFileSync(jsOutputPath, jsContent, "utf-8");

  console.log(
    "\n✅ Successfully generated standalone pricing table (JavaScript)!"
  );
  console.log(`📄 Output: ${jsOutputPath}`);
  console.log(`📊 File size: ${(jsContent.length / 1024).toFixed(2)} KB`);

  console.log("\n💡 Usage:");
  console.log("   TypeScript projects:");
  console.log(
    "     Download: https://getlumen.dev/pricing-table-standalone.tsx"
  );
  console.log(
    "     Import: import { PricingTable, CreditTopup } from './pricing-table-standalone'"
  );
  console.log("");
  console.log("   JavaScript projects:");
  console.log(
    "     Download: https://getlumen.dev/pricing-table-standalone.jsx"
  );
  console.log(
    "     Import: import { PricingTable, CreditTopup } from './pricing-table-standalone'"
  );
}

// Run the script
try {
  generateStandaloneFile();
} catch (error) {
  console.error("❌ Error generating standalone file:", error);
  process.exit(1);
}
