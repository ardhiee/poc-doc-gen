#!/bin/sh
# Usage: ./setup.sh <new-folder>
set -e

TARGET="$1"
if [ -z "$TARGET" ]; then
  echo "Usage: $0 <new-folder>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

mkdir -p "$TARGET/.opencode/agent"
chmod -R 755 "$TARGET"
cp "$SCRIPT_DIR"/agents/*.md "$TARGET/.opencode/agent/"

[ -f "$ENV_FILE" ] || cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"

# Prompts only for vars still unset or left at the .env.example placeholder.
prompt_if_unset() {
  key="$1"
  current=$(grep "^$key=" "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
  case "$current" in
    ""|http://changeme:4000|http://host.docker.internal:4000|sk-changeme|sk-your-litellm-key)
      printf "Enter %s: " "$key"
      read -r value
      tmp="$ENV_FILE.tmp"
      grep -v "^$key=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
      echo "$key=$value" >> "$tmp"
      mv "$tmp" "$ENV_FILE"
      ;;
  esac
}

prompt_if_unset LITELLM_BASE_URL
prompt_if_unset LITELLM_API_KEY

echo "Done. Set this in docker-compose.yml (both services):"
echo "  $TARGET:/workspace"
