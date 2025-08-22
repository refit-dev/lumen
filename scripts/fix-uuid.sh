#!/bin/bash

# Script to replace UUID imports and usages with nanoid equivalents
# Use this script to migrate from UUID-based IDs to nanoid-based IDs

echo "Starting UUID to nanoid migration for test files..."

# Find files with UUID imports
files_with_uuid=$(grep -l -r "import.*uuid\|randomUUID" --include="*.ts" --include="*.tsx" /Users/prasoon/work/lumen/api/tests)

# Counter for modified files
modified_count=0

for file in $files_with_uuid; do
  echo "Processing $file..."
  
  # Replace import statements
  sed -i '' 's/import { v4 as uuidv4 } from "uuid";/import { createId, createPrefixedId, ID_PREFIXES } from "@lumen\/common";/g' "$file"
  sed -i '' 's/import { randomUUID } from "crypto";/import { createId, createPrefixedId, ID_PREFIXES } from "@lumen\/common";/g' "$file"
  
  # Replace UUID usage patterns
  sed -i '' 's/randomUUID()/createId()/g' "$file"
  sed -i '' 's/uuidv4()/createId()/g' "$file"
  
  # Count modified files
  modified_count=$((modified_count + 1))
done

echo "UUID migration complete. Modified $modified_count files."
echo "You may still need to manually check for complex UUID usage patterns."