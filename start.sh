#!/bin/sh
# Usage: ./start.sh           (external Cognee, or none)
#        ./start.sh cognee    (use the bundled Cognee services)
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ "$1" = "cognee" ]; then
  docker compose --profile cognee build
  docker compose --profile cognee up -d
else
  docker compose build
  docker compose up -d
fi
