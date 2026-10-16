import { spawn, ChildProcess } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/// A GUI app inherits no login shell, and the native installer lands outside Tinycast's search list.
export function claudeCandidates(home: string): string[] {
  return [
    join(home, ".local/bin/claude"),
    join(home, ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(home, ".bun/bin/claude"),
    join(home, ".npm-global/bin/claude"),
  ];
}

export function resolveClaude(configured: string | undefined): string | undefined {
  const home = homedir();
  const custom = configured?.trim().replace(/^~(?=\/)/, home);
  if (custom) return existsSync(custom) ? custom : undefined;
  return claudeCandidates(home).find((candidate) => existsSync(candidate));
}

export interface ClaudeOptions {
  executable: string;
  model: string;
  effort?: string;
  workspace: string;
  prompt: string;
  systemPrompt: string;
}

export function claudeArguments(options: ClaudeOptions): string[] {
  const args = [
    "-p",
    // Keeps the user's CLAUDE.md, hooks and plugins away from email text; sign-in still works.
    "--safe-mode",
    "--model", options.model,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--tools", "",
    "--no-chrome",
    "--system-prompt", options.systemPrompt,
    "--disallowedTools", "*",
    "--max-turns", "1",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
  ];
  if (options.effort) args.push("--effort", options.effort);
  return args;
}

/// API-key variables would silently move billing off the signed-in Claude subscription.
export function claudeEnvironment(inherited: Record<string, string | undefined>, executable: string) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined || name === "ANTHROPIC_API_KEY" || name === "ANTHROPIC_AUTH_TOKEN") continue;
    env[name] = value;
  }
  const directory = executable.slice(0, executable.lastIndexOf("/"));
  const path = [directory, env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  env.PATH = path.filter(Boolean).join(":");
  env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  return env;
}

export type StreamEvent = { kind: "delta"; text: string } | { kind: "result"; text: string } | { kind: "error"; message: string };

/// Reads one `stream-json` line; anything unrecognised is skipped rather than fatal.
export function parseStreamLine(line: string): StreamEvent | undefined {
  let value: any;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (value?.type === "stream_event") {
    const delta = value.event?.delta;
    if (value.event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
      return { kind: "delta", text: delta.text };
    }
    return undefined;
  }
  if (value?.type === "result") {
    if (value.is_error || value.subtype !== "success") {
      const message = typeof value.result === "string" && value.result ? value.result : `Claude failed (${value.subtype})`;
      return { kind: "error", message };
    }
    return { kind: "result", text: typeof value.result === "string" ? value.result : "" };
  }
  return undefined;
}

export interface ClaudeRun {
  promise: Promise<string>;
  cancel: () => void;
}

export function runClaude(options: ClaudeOptions, onText: (text: string) => void): ClaudeRun {
  mkdirSync(options.workspace, { recursive: true });
  let child: ChildProcess | undefined;
  let cancelled = false;
  const promise = new Promise<string>((resolve, reject) => {
    child = spawn(options.executable, claudeArguments(options), {
      cwd: options.workspace,
      env: claudeEnvironment(process.env, options.executable),
    });
    let buffer = "";
    let streamed = "";
    let finalText: string | undefined;
    let failure: string | undefined;
    let stderr = "";
    const consume = (line: string) => {
      const event = parseStreamLine(line);
      if (!event) return;
      if (event.kind === "delta") {
        streamed += event.text;
        onText(streamed);
      } else if (event.kind === "result") {
        finalText = event.text;
      } else {
        failure = event.message;
      }
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        consume(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: Error) => reject(error));
    child.on("close", (code: number | null) => {
      if (buffer.trim()) consume(buffer.trim());
      if (cancelled) return reject(new Error("Stopped"));
      if (failure) return reject(new Error(failure));
      const text = finalText ?? streamed;
      if (code === 0 && text.trim()) return resolve(text);
      if (stderr.includes("unknown option '--")) {
        return reject(new Error("This Claude Code is too old for Composer. Run `claude update` in Terminal."));
      }
      const detail = stderr.trim().split("\n").slice(-3).join(" ");
      reject(new Error(detail || `claude exited with status ${code}`));
    });
    child.stdin?.write(options.prompt);
    child.stdin?.end();
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      child?.kill();
    },
  };
}
