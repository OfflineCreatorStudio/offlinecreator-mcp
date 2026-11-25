import {
  StudioApiClient,
  StudioApiError,
  StudioApiTimeoutError,
} from "./client.js";
import type { McpConfig } from "./config.js";
import {
  ECOMMERCE_PRODUCT_IMAGE_INTENT,
  NORTH_STAR_OUTCOME_INTENT,
} from "./outcomes.js";
import { loadX402WalletOptions } from "./x402.js";

export function printHelp() {
  console.log(`OfflineCreator Studio MCP / CLI

Usage:
  offlinecreator-mcp                  Start MCP stdio server
  offlinecreator-mcp models
  offlinecreator-mcp balance
  offlinecreator-mcp topups
  offlinecreator-mcp topup --id topup-1000 [--stripe]
  offlinecreator-mcp quote --model <id> [--options '{"duration":8}']
  offlinecreator-mcp plan-outcome [--north-star | --ecommerce | --intent '{...}']
  offlinecreator-mcp quote-outcome [--north-star | --ecommerce | --intent '{...}']
  offlinecreator-mcp execute-outcome [--north-star | --ecommerce | --intent '{...}'] [--x402] [--wait]
  offlinecreator-mcp generate --model <id> [--prompt "…"] [--options '{"duration":8}'] [--wait]
  offlinecreator-mcp upload-asset --generation <uuid> --slot <slot> --file <path> [--position 0] [--submit]

Env:
  OFFLINECREATOR_API_KEY                 Required API key from Studio /settings
  OFFLINECREATOR_API_BASE                Optional API origin (default production)
  OFFLINECREATOR_UPLOAD_ROOT             Optional root for upload_input paths
  OFFLINECREATOR_ALLOW_INSECURE_API_BASE Set true only for private staging hosts
  X402_EVM_PRIVATE_KEY                   Optional wallet key; pays x402 (USDC)
                                         challenges for topup and generate
  OFFLINECREATOR_X402_MAX_USD            Optional per-payment cap (default 50)

With a wallet configured, "topup" pays over x402 automatically and "generate"
covers insufficient-credit 402s pay-as-you-go. Use --stripe to force a
Stripe Checkout URL instead.

plan-outcome, quote-outcome, and execute-outcome call /api/v1/outcomes with
the API key. Unauthenticated production returns NOT_LIVE. Plan is a preview
(no catalog jobs). Quote is payable against the credit ledger; it does not
generate. execute-outcome starts the workflow. --ecommerce is the two-step
product-image job. --x402 sets policy.prefer_rail=x402. --wait polls the
stored run. Hosted remote MCP cannot hold the wallet.
`);
}

export async function runCli(args: string[], config: McpConfig) {
  try {
    return await runCliCommand(args, config);
  } catch (error) {
    if (error instanceof StudioApiTimeoutError) {
      // A timeout on a paid call is not a clean failure: say so, exit non-zero.
      console.error(`offlinecreator-mcp: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function runCliCommand(args: string[], config: McpConfig) {
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
    case "topups": {
      printJson(await client.listTopUps());
      return 0;
    }
    case "topup": {
      const options = parseFlags(rest);
      const topUpId = options.id ?? options.topUpId;
      if (topUpId !== "topup-1000" && topUpId !== "topup-3000") {
        console.error(
          "Usage: offlinecreator-mcp topup --id topup-1000|topup-3000 [--stripe]",
        );
        return 1;
      }
      const wallet =
        options.stripe === undefined ? loadX402WalletOptions() : null;
      if (wallet && config.fetcher) {
        try {
          printJson(await client.createX402TopUp(topUpId));
          return 0;
        } catch (error) {
          if (!isX402Unavailable(error)) throw error;
          console.error(
            "x402 payments are not enabled on the server; falling back to Stripe Checkout.",
          );
        }
      }
      printJson(await client.createTopUpCheckout(topUpId));
      return 0;
    }
    case "generate": {
      const options = parseFlags(rest);
      const modelId = options.model ?? options.modelId;
      const prompt = options.prompt;
      if (!modelId) {
        console.error(
          'Usage: offlinecreator-mcp generate --model <id> [--prompt "…"] [--options \'{"duration":8}\'] [--wait]',
        );
        return 1;
      }
      const started = await client.generate({
        modelId,
        prompt,
        aspectRatio: asAspect(options.aspect ?? options.aspectRatio),
        options: parseModelOptions(options.options),
        quoteToken: options.quoteToken ?? options.quote,
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
    case "quote": {
      const options = parseFlags(rest);
      const modelId = options.model ?? options.modelId;
      if (!modelId) {
        console.error(
          "Usage: offlinecreator-mcp quote --model <id> [--options '{\"duration\":8}']",
        );
        return 1;
      }
      printJson(
        await client.quoteGeneration({
          modelId,
          aspectRatio: asAspect(options.aspect ?? options.aspectRatio),
          options: parseModelOptions(options.options),
        }),
      );
      return 0;
    }
    case "plan-outcome": {
      const intent = parseOutcomeIntent(parseFlags(rest));
      if (!intent) {
        console.error(
          "Usage: offlinecreator-mcp plan-outcome --north-star | --ecommerce | --intent '{...}'",
        );
        return 1;
      }
      printJson(await client.planOutcome(intent));
      return 0;
    }
    case "quote-outcome": {
      const intent = parseOutcomeIntent(parseFlags(rest));
      if (!intent) {
        console.error(
          "Usage: offlinecreator-mcp quote-outcome --north-star | --ecommerce | --intent '{...}'",
        );
        return 1;
      }
      printJson(await client.quoteOutcome(intent));
      return 0;
    }
    case "execute-outcome": {
      const flags = parseFlags(rest);
      const intent = parseOutcomeIntent(flags);
      if (!intent) {
        console.error(
          "Usage: offlinecreator-mcp execute-outcome --north-star | --ecommerce | --intent '{...}' [--x402] [--wait]",
        );
        return 1;
      }
      if (flags.x402 !== undefined) {
        const policy =
          intent.policy &&
          typeof intent.policy === "object" &&
          !Array.isArray(intent.policy)
            ? intent.policy
            : {};
        intent.policy = { ...policy, prefer_rail: "x402" };
      }
      const executed = await client.executeOutcome(intent);
      if (flags.wait !== undefined) {
        const hash = outcomeHashFrom(executed);
        const generationId = reservationGenerationId(executed);
        const generation = generationId
          ? await client.waitGeneration({
              generationId,
              timeoutSeconds: 180,
            })
          : null;
        const receipt = hash
          ? generationId
            ? await client.getReceipt(hash)
            : await client.waitOutcome({ hash, timeoutSeconds: 180 })
          : null;
        printJson({ executed, generation, receipt });
      } else {
        printJson(executed);
      }
      return 0;
    }
    case "upload-asset": {
      const options = parseFlags(rest);
      const generationId = options.generation ?? options.generationId;
      const slot = options.slot;
      const filePath = options.file ?? options.filePath;
      if (!generationId || !slot || !filePath) {
        console.error(
          "Usage: offlinecreator-mcp upload-asset --generation <uuid> --slot <slot> --file <path> [--position 0] [--submit]",
        );
        return 1;
      }
      const uploaded = await client.uploadAsset({
        generationId,
        slot,
        filePath,
        position: options.position ? Number(options.position) : 0,
      });
      if (options.submit !== undefined) {
        const submitted = await client.submitGeneration(
          generationId,
          asAspect(options.aspect ?? options.aspectRatio) ?? "16:9",
        );
        if (options.wait !== undefined) {
          printJson({
            uploaded,
            submitted,
            result: await client.waitGeneration({
              generationId,
              timeoutSeconds: 600,
            }),
          });
        } else {
          printJson({ uploaded, submitted });
        }
      } else {
        printJson(uploaded);
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

function isX402Unavailable(error: unknown) {
  return (
    error instanceof StudioApiError &&
    error.status === 503 &&
    typeof error.body === "object" &&
    error.body !== null &&
    (error.body as { code?: unknown }).code === "X402_UNAVAILABLE"
  );
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

function asAspect(
  value?: string,
): "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | undefined {
  if (
    value === "21:9" ||
    value === "16:9" ||
    value === "4:3" ||
    value === "1:1" ||
    value === "3:4" ||
    value === "9:16"
  ) {
    return value;
  }
  return undefined;
}

function parseModelOptions(value?: string) {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--options must be a JSON object.");
  }
  for (const option of Object.values(parsed)) {
    if (!["string", "number", "boolean"].includes(typeof option)) {
      throw new Error(
        "--options values must be strings, numbers, or booleans.",
      );
    }
  }
  return parsed as Record<string, string | number | boolean>;
}

function parseOutcomeIntent(options: Record<string, string>) {
  if (options["north-star"] !== undefined || options.northStar !== undefined) {
    return { ...NORTH_STAR_OUTCOME_INTENT } as Record<string, unknown>;
  }
  if (options.ecommerce !== undefined) {
    return { ...ECOMMERCE_PRODUCT_IMAGE_INTENT } as Record<string, unknown>;
  }
  if (!options.intent) return null;
  const parsed = JSON.parse(options.intent) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--intent must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function reservationGenerationId(
  payload: Record<string, unknown>,
): string | null {
  const run = payload.run;
  if (!run || typeof run !== "object") return null;
  const reservations = (run as { reservations?: unknown }).reservations;
  if (!Array.isArray(reservations)) return null;
  for (const row of reservations) {
    if (!row || typeof row !== "object") continue;
    const id = (row as { generation_id?: unknown }).generation_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function outcomeHashFrom(payload: Record<string, unknown>): string | null {
  const quote = payload.quote;
  if (quote && typeof quote === "object") {
    const attestation = (quote as { attestation?: { hash?: unknown } })
      .attestation;
    if (attestation && typeof attestation.hash === "string") {
      return attestation.hash;
    }
  }
  const run = payload.run;
  if (
    run &&
    typeof run === "object" &&
    typeof (run as { hash?: unknown }).hash === "string"
  ) {
    return (run as { hash: string }).hash;
  }
  return null;
}
