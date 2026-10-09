#!/bin/sh
# Start the opencodez-free local server on Linux/macOS.
# Requires Node.js >= 22.18 (native TypeScript support).
set -e
cd "$(dirname "$0")/.."
exec node src/index.ts "$@"
