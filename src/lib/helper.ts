import { spawn } from "child_process";
import { chmodSync, existsSync } from "fs";
import { join } from "path";

export class HelperError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/// Store and folder installs can drop the execute bit, so it is restored before every run.
export function runHelper(assetsPath: string, args: string[], input?: string, timeout = 5000): Promise<string> {
  const helper = join(assetsPath, "composer-helper");
  if (!existsSync(helper)) return Promise.reject(new HelperError("helper missing", null));
  try {
    chmodSync(helper, 0o755);
  } catch {
    // Read-only installs keep whatever mode they shipped with.
  }
  return new Promise((resolve, reject) => {
    const child = spawn(helper, args, { timeout });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer | string) => (stderr += chunk.toString()));
    child.on("error", (error: Error) => reject(new HelperError(error.message, null)));
    child.on("close", (code: number | null) => {
      if (code === 0) resolve(stdout);
      else reject(new HelperError(stderr.trim() || `helper exited with status ${code}`, code));
    });
    if (input !== undefined) child.stdin?.write(input);
    child.stdin?.end();
  });
}
