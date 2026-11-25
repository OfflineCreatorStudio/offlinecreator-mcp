import type { SafeImageData } from "./safe-image.js";
import type { SafeAssetData } from "./asset-data.js";

export type McpConfig = {
  apiKey?: string;
  apiBase: string;
  /** Optional transport override for trusted Worker service bindings. */
  fetcher?: typeof fetch;
  /** Local filesystem root for upload_input filePath (stdio only). */
  uploadRoot?: string;
  /** Injected only by the stdio entrypoint; omitted by remote Workers. */
  readLocalImage?: (input: {
    filePath: string;
    maxBytes?: number;
    rootDir?: string;
  }) => Promise<SafeImageData>;
  /** Injected only by the stdio entrypoint for multimodal asset uploads. */
  readLocalAsset?: (input: {
    filePath: string;
    maxBytes?: number;
    rootDir?: string;
  }) => Promise<SafeAssetData>;
};

const DEFAULT_API_BASE = "https://offlinecreatorstudio.com";

const TRUSTED_API_HOSTS = new Set([
  "offlinecreatorstudio.com",
  "offlinecreator-studio-staging.offlinecreator.workers.dev",
]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const apiKey = env.OFFLINECREATOR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      [
        "OFFLINECREATOR_API_KEY is required.",
        "Sign in or create an account: https://offlinecreatorstudio.com/auth?next=/settings",
        "Then create an API key in Settings and set OFFLINECREATOR_API_KEY.",
      ].join("\n"),
    );
  }

  if (!apiKey.startsWith("oc_live_") && !apiKey.startsWith("oc_test_")) {
    throw new Error(
      "OFFLINECREATOR_API_KEY looks invalid. Expected a key starting with oc_live_ or oc_test_.",
    );
  }

  const apiBase = assertTrustedApiBase(
    (env.OFFLINECREATOR_API_BASE?.trim() || DEFAULT_API_BASE).replace(
      /\/$/,
      "",
    ),
    env,
  );

  const uploadRoot = env.OFFLINECREATOR_UPLOAD_ROOT?.trim() || process.cwd();

  return { apiKey, apiBase, uploadRoot };
}

export function assertTrustedApiBase(
  apiBase: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    throw new Error("OFFLINECREATOR_API_BASE must be a valid absolute URL.");
  }

  if (url.username || url.password) {
    throw new Error("OFFLINECREATOR_API_BASE must not include credentials.");
  }

  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1";
  const allowInsecure =
    env.OFFLINECREATOR_ALLOW_INSECURE_API_BASE === "true" || isLoopback;

  if (url.protocol === "http:") {
    if (!allowInsecure) {
      throw new Error(
        "OFFLINECREATOR_API_BASE must use https unless it is localhost or OFFLINECREATOR_ALLOW_INSECURE_API_BASE=true.",
      );
    }
  } else if (url.protocol !== "https:") {
    throw new Error("OFFLINECREATOR_API_BASE must use http or https.");
  }

  if (!isLoopback && !TRUSTED_API_HOSTS.has(host) && !allowInsecure) {
    throw new Error(
      `OFFLINECREATOR_API_BASE host "${host}" is not trusted. Use an OfflineCreator host, localhost, or set OFFLINECREATOR_ALLOW_INSECURE_API_BASE=true for private staging.`,
    );
  }

  return apiBase.replace(/\/$/, "");
}
