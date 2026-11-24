#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { printHelp, runCli } from "./cli.js";
import { loadConfig, type McpConfig } from "./config.js";
import { describeUploadRoot, readSafeLocalImage } from "./safe-fs.js";
import { readSafeLocalAsset } from "./safe-asset.js";
import { createOfflineCreatorServer } from "./server.js";
import { createX402Fetcher, loadX402WalletOptions } from "./x402.js";

async function buildConfig(): Promise<McpConfig> {
  const config: McpConfig = {
    ...loadConfig(),
    readLocalImage: readSafeLocalImage,
    readLocalAsset: readSafeLocalAsset,
  };
  const wallet = loadX402WalletOptions();
  if (wallet) {
    config.fetcher = await createX402Fetcher(wallet);
    // MCP clients speak over stdin/stdout — keep logs off stdout.
    console.error(
      `offlinecreator-mcp: x402 wallet enabled (max $${wallet.maxPaymentUsd} per payment)`,
    );
  }
  return config;
}

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
    process.exitCode = await runCli(args, await buildConfig());
    return;
  }

  const config = await buildConfig();
  // MCP clients speak over stdin/stdout — keep logs off stdout.
  console.error(
    `offlinecreator-mcp: connected to ${config.apiBase} (stdio MCP)`,
  );
  console.error(`offlinecreator-mcp: ${describeUploadRoot(config.uploadRoot)}`);

  serveStdio(() => createOfflineCreatorServer(config));
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Failed to start offlinecreator-mcp",
  );
  process.exitCode = 1;
});
