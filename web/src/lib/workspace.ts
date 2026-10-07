import os from "os";
import path from "path";

/**
 * The real folder behind opencode's /workspace — generated files, fsd-data.json,
 * artifacts, all of it. Defaults to the host-dev path (this web process running
 * directly on the same Mac as the opencode container, sharing its bind mount),
 * but override with WORKSPACE_ROOT when the web app runs inside its own
 * container instead — there, it only ever sees /workspace via its own mount,
 * never the host's actual home directory.
 */
export function workspaceRoot() {
  return process.env.WORKSPACE_ROOT ?? path.join(os.homedir(), "Documents", "MINDEF-POC");
}
