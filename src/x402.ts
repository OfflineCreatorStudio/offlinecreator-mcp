/**
 * Optional x402 buyer wallet for the stdio MCP server and CLI.
 *
 * When X402_EVM_PRIVATE_KEY is set, Studio API calls transparently pay
 * x402 challenges (agent top-ups and pay-as-you-go generations) in USDC.
 * All x402 packages load lazily so remote Workers and wallet-less installs
 * never pull wallet code.
 */

const EVM_PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const DEFAULT_MAX_PAYMENT_USD = 50;
const USDC_DECIMALS = 6;

export type X402WalletOptions = {
  evmPrivateKey: `0x${string}`;
  /** Refuse any single payment above this USD amount. */
  maxPaymentUsd: number;
};

/**
 * Read wallet options from the environment. Returns null when no wallet is
 * configured. Never logs or echoes the private key.
 */
export function loadX402WalletOptions(
  env: NodeJS.ProcessEnv = process.env,
): X402WalletOptions | null {
  const evmPrivateKey = env.X402_EVM_PRIVATE_KEY?.trim();
  if (!evmPrivateKey) return null;
  if (!EVM_PRIVATE_KEY_RE.test(evmPrivateKey)) {
    throw new Error(
      "X402_EVM_PRIVATE_KEY looks invalid. Expected a 0x-prefixed 32-byte hex key.",
    );
  }

  let maxPaymentUsd = DEFAULT_MAX_PAYMENT_USD;
  const rawMax = env.OFFLINECREATOR_X402_MAX_USD?.trim();
  if (rawMax) {
    const parsed = Number(rawMax);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        "OFFLINECREATOR_X402_MAX_USD must be a positive number of US dollars.",
      );
    }
    maxPaymentUsd = parsed;
  }

  return { evmPrivateKey: evmPrivateKey as `0x${string}`, maxPaymentUsd };
}

/**
 * Build a fetch that settles x402 challenges from the Studio API.
 *
 * The wrapped fetch only engages when a 402 response carries a
 * PAYMENT-REQUIRED header; legacy JSON 402s (INSUFFICIENT_CREDITS without
 * x402 enabled) pass through untouched so existing error handling keeps
 * working. Payments above the spend cap are rejected before signing.
 */
export async function createX402Fetcher(
  options: X402WalletOptions,
  baseFetch: typeof fetch = fetch,
): Promise<typeof fetch> {
  const [
    { wrapFetchWithPayment, x402Client },
    { ExactEvmScheme },
    { privateKeyToAccount },
  ] = await Promise.all([
    import("@x402/fetch"),
    import("@x402/evm/exact/client"),
    import("viem/accounts"),
  ]);

  const signer = privateKeyToAccount(options.evmPrivateKey);
  const maxAtomic = BigInt(
    Math.round(options.maxPaymentUsd * 10 ** USDC_DECIMALS),
  );

  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(signer));
  // Spend cap runs before the wallet signs anything. Requirements above the
  // cap are dropped; when nothing remains the payment fails loudly instead
  // of silently overspending.
  client.registerPolicy((_version, requirements) =>
    requirements.filter((requirement) => {
      try {
        return BigInt(requirement.amount) <= maxAtomic;
      } catch {
        return false;
      }
    }),
  );

  const paidFetch = wrapFetchWithPayment(baseFetch, client);

  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (response.status !== 402 || !response.headers.get("PAYMENT-REQUIRED")) {
      return response;
    }
    // Re-run the request through the payment wrapper. The extra 402 round
    // trip is cheap and keeps non-x402 error paths byte-identical.
    return paidFetch(input, init);
  };
}
