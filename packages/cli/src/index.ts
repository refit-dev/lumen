#!/usr/bin/env node

import { Command } from "commander";
import prompts from "prompts";
import chalk from "chalk";
import ora from "ora";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import fetch from "node-fetch";

const program = new Command();

const COMPONENT_URLS = {
  tsx: "https://getlumen.dev/pricing-table-standalone.tsx",
  jsx: "https://getlumen.dev/pricing-table-standalone.jsx",
};

const CSS_VARIABLES = `
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 0 0% 3.9%;
    --card: 0 0% 100%;
    --card-foreground: 0 0% 3.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 0 0% 3.9%;
    --primary: 0 0% 9%;
    --primary-foreground: 0 0% 98%;
    --secondary: 0 0% 96.1%;
    --secondary-foreground: 0 0% 9%;
    --muted: 0 0% 96.1%;
    --muted-foreground: 0 0% 45.1%;
    --accent: 0 0% 96.1%;
    --accent-foreground: 0 0% 9%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 0 0% 98%;
    --border: 0 0% 89.8%;
    --input: 0 0% 89.8%;
    --ring: 0 0% 3.9%;
    --radius: 0.5rem;
  }
}
`;

const TAILWIND_THEME = `
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
`;

async function downloadComponent(url: string, destination: string) {
  const spinner = ora(`Downloading component...`).start();
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.statusText}`);
    }
    const content = await response.text();
    writeFileSync(destination, content, "utf-8");
    spinner.succeed("Component downloaded");
  } catch (error) {
    spinner.fail("Failed to download component");
    throw error;
  }
}

function updateTailwindConfig(projectPath: string, componentPath: string) {
  const spinner = ora("Updating Tailwind config...").start();

  const configPaths = [
    join(projectPath, "tailwind.config.js"),
    join(projectPath, "tailwind.config.ts"),
    join(projectPath, "tailwind.config.cjs"),
  ];

  let configPath = configPaths.find((p) => existsSync(p));

  if (!configPath) {
    spinner.warn(
      "No Tailwind config found - you'll need to set it up manually"
    );
    console.log(chalk.yellow("\nAdd this to your tailwind.config.js:"));
    console.log(
      chalk.gray(`
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "${componentPath}",
  ],
  theme: {
    extend: {
${TAILWIND_THEME}
    }
  }
    `)
    );
    return;
  }

  try {
    let config = readFileSync(configPath, "utf-8");

    // Add component to content array
    const contentRegex = /content:\s*\[([\s\S]*?)\]/;
    const match = config.match(contentRegex);

    if (match && !config.includes(componentPath)) {
      const contentArray = match[1];
      const newContent = `content: [\n${contentArray.trim()},\n    "${componentPath}",\n  ]`;
      config = config.replace(contentRegex, newContent);
    }

    // Add theme configuration if not already present
    if (!config.includes("hsl(var(--primary))")) {
      // Try to find theme.extend
      const themeExtendRegex = /theme:\s*\{\s*extend:\s*\{/;
      if (config.match(themeExtendRegex)) {
        config = config.replace(
          themeExtendRegex,
          `theme: {\n    extend: {\n${TAILWIND_THEME}`
        );
      }
    }

    writeFileSync(configPath, config, "utf-8");
    spinner.succeed("Tailwind config updated");
  } catch (error) {
    spinner.fail("Failed to update Tailwind config");
    console.log(chalk.yellow("Please update manually"));
  }
}

function updateCssFile(projectPath: string) {
  const spinner = ora("Adding CSS variables...").start();

  const cssPaths = [
    join(projectPath, "src", "index.css"),
    join(projectPath, "src", "App.css"),
    join(projectPath, "src", "styles", "globals.css"),
    join(projectPath, "styles", "globals.css"),
  ];

  let cssPath = cssPaths.find((p) => existsSync(p));

  if (!cssPath) {
    spinner.warn("No CSS file found");
    console.log(chalk.yellow("\nAdd this to your main CSS file:"));
    console.log(chalk.gray(CSS_VARIABLES));
    return;
  }

  try {
    let css = readFileSync(cssPath, "utf-8");

    // Check if variables already exist
    if (css.includes("--primary")) {
      spinner.info("CSS variables already present");
      return;
    }

    // Add variables after @tailwind directives
    const tailwindRegex = /(@tailwind\s+utilities;)/;
    if (css.match(tailwindRegex)) {
      css = css.replace(tailwindRegex, `$1\n${CSS_VARIABLES}`);
    } else {
      css = CSS_VARIABLES + "\n" + css;
    }

    writeFileSync(cssPath, css, "utf-8");
    spinner.succeed("CSS variables added");
  } catch (error) {
    spinner.fail("Failed to update CSS file");
    console.log(chalk.yellow("Please add variables manually"));
  }
}

function findPricingTableFile(cwd: string): string | null {
  const possiblePaths = [
    "src/pricing-table-standalone.tsx",
    "src/pricing-table-standalone.jsx",
    "src/components/pricing-table-standalone.tsx",
    "src/components/pricing-table-standalone.jsx",
    "src/components/pricing-table.tsx",
    "src/components/pricing-table.jsx",
    "src/pricing-table.tsx",
    "src/pricing-table.jsx",
  ];

  for (const path of possiblePaths) {
    if (existsSync(join(cwd, path))) {
      return path;
    }
  }
  return null;
}

program
  .name("lumen")
  .description("Install Lumen Billing components")
  .version("0.1.0");

program
  .command("add")
  .description("Add Lumen pricing table to your project")
  .option(
    "--no-download",
    "Skip downloading component (use if file already exists)"
  )
  .option("-l, --language <type>", "Language: tsx or jsx")
  .option("-p, --path <path>", "Component install path")
  .option("-y, --yes", "Skip prompts and use defaults")
  .action(async (options) => {
    console.log(chalk.bold.blue("\n🌟 Lumen Billing Component Installer\n"));

    const cwd = process.cwd();

    // Check if project has package.json
    if (!existsSync(join(cwd, "package.json"))) {
      console.log(
        chalk.red("❌ No package.json found. Are you in a React project?")
      );
      process.exit(1);
    }

    let language: string;
    let path: string;

    // If --no-download, try to auto-detect the component
    if (options.download === false) {
      const foundPath = findPricingTableFile(cwd);
      if (foundPath) {
        path = foundPath;
        language = foundPath.endsWith(".tsx") ? "tsx" : "jsx";
        console.log(chalk.blue(`⏭️  Found existing component: ${foundPath}`));
        console.log(
          chalk.blue("⏭️  Skipping download, will configure Tailwind & CSS\n")
        );
      } else if (options.path) {
        // Use provided path
        path = options.path;
        language = options.language || (path.endsWith(".tsx") ? "tsx" : "jsx");
        if (!existsSync(join(cwd, path))) {
          console.log(chalk.red(`\n❌ File not found: ${path}`));
          console.log(chalk.yellow("Please check the path and try again"));
          process.exit(1);
        }
      } else {
        console.log(
          chalk.red("❌ No pricing table component found in common locations")
        );
        console.log(
          chalk.yellow("Please specify --path or remove --no-download flag")
        );
        process.exit(1);
      }
    } else {
      // Interactive or flag-based mode
      if (options.yes && options.language && options.path) {
        // Non-interactive: use flags
        language = options.language;
        path = options.path;
      } else if (options.language && options.path) {
        // Flags provided but no --yes
        language = options.language;
        path = options.path;
      } else {
        // Interactive mode
        const response = await prompts([
          {
            type: "select",
            name: "language",
            message: "TypeScript or JavaScript?",
            choices: [
              { title: "TypeScript", value: "tsx" },
              { title: "JavaScript", value: "jsx" },
            ],
            initial: 0,
          },
          {
            type: "text",
            name: "path",
            message: "Where should we install the component?",
            initial: (prev: string) => `src/components/pricing-table.${prev}`,
          },
        ]);

        if (!response.language || !response.path) {
          console.log(chalk.red("\n❌ Installation cancelled"));
          process.exit(0);
        }

        language = response.language;
        path = response.path;
      }
    }

    const fullPath = join(cwd, path);
    const url = COMPONENT_URLS[language as keyof typeof COMPONENT_URLS];

    try {
      // Download component (unless --no-download flag is set)
      if (options.download !== false) {
        await downloadComponent(url, fullPath);
      }

      // Update Tailwind config
      updateTailwindConfig(cwd, path);

      // Update CSS file
      updateCssFile(cwd);

      console.log(chalk.bold.green("\n✅ Installation complete!\n"));
      console.log(chalk.white("Next steps:"));
      console.log(chalk.gray("1. Restart your dev server"));
      console.log(
        chalk.gray(
          `2. Import: ${chalk.cyan(`import { PricingTable, CreditTopup } from './${path.replace(/\\/g, "/").replace("src/", "")}'`)}`
        )
      );
      console.log(
        chalk.gray(
          "3. Set your API key: REACT_APP_LUMEN_PUBLISHABLE_KEY or NEXT_PUBLIC_LUMEN_PUBLISHABLE_KEY\n"
        )
      );
    } catch (error) {
      console.log(chalk.red(`\n❌ Installation failed: ${error}`));
      process.exit(1);
    }
  });

program.parse();
