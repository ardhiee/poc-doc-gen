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
# Only the tree we just created — not -R on the whole $TARGET, which can
# already contain pre-existing files (e.g. from a prior docker run) owned by
# a different user/root, and `set -e` would abort the whole script on the
# first one chmod can't touch.
chmod -R 755 "$TARGET/.opencode" 2>/dev/null || true
cp "$SCRIPT_DIR"/agents/*.md "$TARGET/.opencode/agent/"

[ -f "$ENV_FILE" ] || cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
# Existing .env from before LITELLM_MODEL existed.
grep -q "^LITELLM_MODEL=" "$ENV_FILE" || echo "LITELLM_MODEL=gemini-3.8-flash" >> "$ENV_FILE"

# Prompts for vars still unset / left at a placeholder. With a default (3rd
# arg), shows it in the prompt and pressing Enter keeps it instead of forcing
# input — for LITELLM_MODEL, where the default is usually already correct.
prompt_if_unset() {
  key="$1"
  default="$2"
  current=$(grep "^$key=" "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
  case "$current" in
    ""|http://changeme:4000|http://host.docker.internal:4000|sk-changeme|sk-your-litellm-key|gemini-3.8-flash)
      if [ -n "$default" ]; then
        printf "Enter %s [%s]: " "$key" "$default"
      else
        printf "Enter %s: " "$key"
      fi
      read -r value
      [ -z "$value" ] && value="$default"
      tmp="$ENV_FILE.tmp"
      grep -v "^$key=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
      echo "$key=$value" >> "$tmp"
      mv "$tmp" "$ENV_FILE"
      ;;
  esac
}

prompt_if_unset LITELLM_BASE_URL
prompt_if_unset LITELLM_API_KEY
prompt_if_unset LITELLM_MODEL gemini-3.8-flash

# Point both services' /workspace mount at the new folder. Anchored to end of
# line so it only touches "<path>:/workspace", never "./opencode.jsonc:/workspace/opencode.jsonc:ro".
sed -i.bak -E "s|^([[:space:]]*- ).*:/workspace\$|\1$TARGET:/workspace|" "$SCRIPT_DIR/docker-compose.yml"
rm -f "$SCRIPT_DIR/docker-compose.yml.bak"

echo "Done. docker-compose.yml now mounts $TARGET:/workspace."
