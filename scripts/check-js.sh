#!/bin/bash
# Syntax check JavaScript files using node --check

FILES=("${@:-web/app.js}")

echo "Checking JavaScript syntax..."

errors=0
for file in "${FILES[@]}"; do
    if node --check "$file" 2>/dev/null; then
        echo "✓ $file"
    else
        echo "✗ $file has syntax errors"
        node --check "$file" 2>&1 || true
        errors=1
    fi
done

if [ $errors -eq 0 ]; then
    echo "All JS files passed syntax check"
else
    echo "Some files have errors"
    exit 1
fi