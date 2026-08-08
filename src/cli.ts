import { StudioApiClient } from "./client.js";
import type { McpConfig } from "./config.js";

export function printHelp() {
  console.log(`OfflineCreator Studio MCP / CLI

Usage:
  offlinecreator-mcp                  Start MCP stdio server
  offlinecreator-mcp models
  offlinecreator-mcp balance
  offlinecreator-mcp generate --model <id> --prompt "…" [--wait]

Env:
  OFFLINECREATOR_API_KEY                 Required API key from Studio /settings
  OFFLINECREATOR_API_BASE                Optional API origin (default production)
  OFFLINECREATOR_UPLOAD_ROOT             Optional root for upload_input paths
`);
}

export async function runCli(args: string[], config: McpConfig) {
  const [command, ...rest] = args;
  const client = new StudioApiClient(config);

  switch (command) {
    case "models": {
      printJson(await client.listModels());
      return 0;
    }
    case "balance":
    case "credits": {
      printJson(await client.getCredits());
      return 0;
    }
    case "generate": {
      const options = parseFlags(rest);
      const modelId = options.model ?? options.modelId;
      const prompt = options.prompt;
      if (!modelId || !prompt) {
        console.error(
          "Usage: offlinecreator-mcp generate --model flux-schnell --prompt \"…\" [--wait]",
        );
        return 1;
      }
      const started = await client.generate({
        modelId,
        prompt,
        aspectRatio: asAspect(options.aspect ?? options.aspectRatio),
      });
      if (options.wait !== undefined && !started.uploadRequired) {
        printJson(
          await client.waitGeneration({
            generationId: String(started.generationId),
          }),
        );
      } else {
        printJson(client.withAbsoluteOutput(started));
      }
      return 0;
    }
    case "help":
    case "--help":
    case "-h": {
      printHelp();
      return 0;
    }
    default: {
      printHelp();
      return 1;
    }
  }
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function parseFlags(args: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function asAspect(value?: string): "16:9" | "9:16" | "1:1" | undefined {
  if (value === "16:9" || value === "9:16" || value === "1:1") return value;
  return undefined;
}
