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
   - **Use the bundled one (this repo)**: in `opencode.jsonc`, set `mcp.cognee.url` to `http://cognee-mcp:8000/sse`; in `docker-compose.yml`, remove the `docgen-net` network from the `opencode` service. Start with `docker compose --profile cognee up -d` instead of `./start.sh`.
   - **Use an existing external one**: deploy the `doc-generation` stack there too, so network `doc-generation_docgen-net` exists.
   - **Don't use Cognee**: in `docker-compose.yml`, remove the `docgen-net` network (both the `opencode` service's reference and the top-level `networks:` block); in `opencode.jsonc`, remove the `mcp.cognee` block.
3. Ensure reachable: LiteLLM proxy.
4. Run:
   ```
   ./start.sh
   ```
   (skip this and use `docker compose --profile cognee up -d` instead if you picked the bundled Cognee option above)
5. Open `http://<host>:3200`.
