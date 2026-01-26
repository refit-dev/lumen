# Publishing @getlumen/cli

## Before Publishing

1. Update version in `package.json`
2. Build the package: `npm run build`
3. Test locally (see below)

## Test Locally

In another React project:

```bash
# Link the package
cd /path/to/berlin-pay/packages/installer
npm link

# In your test project
npm link @getlumen/cli

# Run it
lumen add
```

## Publish to npm

```bash
# Login to npm (one time)
npm login

# Publish
npm publish --access public
```

## Usage After Publishing

Users can run:

```bash
npx lumen add
```

The `lumen` binary is automatically available via `npx` when the package is published.

## Update Checklist

When updating the pricing table component:

1. ✅ Run `bun run generate:components` to update standalone files
2. ✅ Deploy updated files to https://getlumen.dev/
3. ✅ Users automatically get latest version on next install

