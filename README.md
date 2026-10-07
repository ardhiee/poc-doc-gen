# poc-doc-gen setup

`<new-folder>` = a path you pick on the new machine for shared data (e.g. `/home/user/MINDEF-POC`).

1. Run:
   ```
   chmod +x setup.sh start.sh
   ./setup.sh <new-folder>
   ```
   Prompts for `LITELLM_BASE_URL` / `LITELLM_API_KEY` if not already set in `.env`, and points
   `docker-compose.yml`'s `/workspace` mount (both services) at `<new-folder>`.
2. Cognee (knowledge-base search) — pick one:
   - **None / decide later**: do nothing. `./start.sh` works as-is, Cognee search just won't be available.
   - **Bundled (this repo)**: in `opencode.jsonc`, set `mcp.cognee.url` to `http://cognee-mcp:8000/sse`.
     Start with `./start.sh cognee` instead of `./start.sh`.
   - **External (already running elsewhere)**: create `docker-compose.override.yml` (not committed,
     machine-specific) attaching the `backend` service to that network — see the one on this Mac for
     an example.
3. Ensure reachable: LiteLLM proxy.
4. Run:
   ```
   ./start.sh          # or: ./start.sh cognee
   ```
5. Open `http://<host>:3200`.
