#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { printHelp, runCli } from "./cli.js";
import { loadConfig } from "./config.js";
import { readSafeLocalImage } from "./safe-fs.js";
import { createOfflineCreatorServer } from "./server.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  // CLI subcommands need a key; bare invocation starts MCP stdio.
  // Use exitCode instead of process.exit(): hard exits while undici keep-alive
  // sockets are open crash libuv on Windows (async.c assertion) and can
  // truncate piped stdout.
  if (command) {
    const config = loadConfig();
    process.exitCode = await runCli(args, config);
    return;
  }

  const config = {
    ...loadConfig(),
    readLocalImage: readSafeLocalImage,
  };
  // MCP clients speak over stdin/stdout — keep logs off stdout.
  console.error(
    `offlinecreator-mcp: connected to ${config.apiBase} (stdio MCP)`,
  );

  serveStdio(() => createOfflineCreatorServer(config));
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Failed to start offlinecreator-mcp",
  );
  process.exitCode = 1;
});
