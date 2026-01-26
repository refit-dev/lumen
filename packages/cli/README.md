# @getlumen/cli

CLI tool to install Lumen Billing components into your React project.

## Usage

### Interactive Mode (Recommended)
```bash
npx lumen add
```

### Non-Interactive Mode
```bash
# Download TypeScript version to custom path
npx lumen add --language tsx --path src/components/pricing.tsx --yes

# Download JavaScript version
npx lumen add --language jsx --path src/pricing-table.jsx --yes

# Configure existing component (auto-detects location)
npx lumen add --no-download
```

## What it does

1. ✅ Downloads the pricing table component (TypeScript or JavaScript)
2. ✅ Updates your `tailwind.config.js` to scan the component
3. ✅ Adds required CSS variables to your stylesheet
4. ✅ Configures Tailwind theme colors

## Requirements

- React project
- Tailwind CSS installed

## Options

### Flags
- `-l, --language <type>` - Language: `tsx` or `jsx`
- `-p, --path <path>` - Component install path
- `-y, --yes` - Skip prompts and use provided flags
- `--no-download` - Skip download, auto-detect and configure existing component

### Interactive Prompts (if flags not provided)
- **Language**: TypeScript or JavaScript
- **Path**: Where to install the component (default: `src/components/pricing-table.[tsx|jsx]`)

## Examples

### Interactive Installation
```bash
$ npx lumen add

🌟 Lumen Billing Component Installer

? TypeScript or JavaScript? › TypeScript
? Where should we install the component? › src/components/pricing-table.tsx

✔ Component downloaded
✔ Tailwind config updated
✔ CSS variables added

✅ Installation complete!
```

### Non-Interactive Installation
```bash
# For tutorials/automation - download JS version
$ npx lumen add -l jsx -p src/pricing.jsx -y

# Auto-configure existing component (scans for file automatically)
$ npx lumen add --no-download
⏭️ Found existing component: src/pricing-table-standalone.jsx
⏭️ Skipping download, will configure Tailwind & CSS
✔ Tailwind config updated
✔ CSS variables added
```

Then use it in your app:

```tsx
import { PricingTable } from './components/pricing-table';

function App() {
  return (
    <PricingTable
      lumenPublishableKey={process.env.REACT_APP_LUMEN_PUBLISHABLE_KEY}
      loginRedirectUrl="/login"
    />
  );
}
```

