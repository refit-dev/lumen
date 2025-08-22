// bun run scripts/generate-shadcn-components.ts
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

async function updateComponentJson(componentName: string) {
  try {
    // Read the component .tsx file
    const componentPath = resolve(
      process.cwd(),
      `ui/src/components/ui/${componentName}.tsx`
    );
    const componentContent = readFileSync(componentPath, "utf-8");

    // Read the component .json file
    const componentJsonPath = resolve(
      process.cwd(),
      `ui/public/${componentName}.json`
    );
    const componentJsonContent = readFileSync(componentJsonPath, "utf-8");

    // Parse the JSON
    const componentJson = JSON.parse(componentJsonContent);

    // Update the content field with the stringified tsx content
    componentJson.files[0].content = componentContent;

    // Write the updated JSON back to the file
    writeFileSync(componentJsonPath, JSON.stringify(componentJson, null, 2));

    console.log(
      `✅ Successfully updated ${componentName}.json with the latest ${componentName}.tsx content`
    );
  } catch (error) {
    console.error(`❌ Error updating ${componentName}.json:`, error);
    process.exit(1);
  }
}

// Run the script for both components
async function main() {
  await updateComponentJson("pricing-table");
  await updateComponentJson("usage-badge");
}

main();
