import assert from "node:assert/strict";
import test from "node:test";
import { createX402Fetcher, loadX402WalletOptions } from "./x402.js";

// Throwaway test key (never funded): any 32-byte hex works for offline signing.
const TEST_PRIVATE_KEY = `0x${"11".repeat(32)}` as const;

// USDC on Base Sepolia; extra carries the EIP-712 domain the signer needs.
const PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: { url: "https://studio.test/api/v1/generations" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "1000000",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ],
};

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

test("loadX402WalletOptions returns null without a key", () => {
  assert.equal(loadX402WalletOptions({} as NodeJS.ProcessEnv), null);
});

test("loadX402WalletOptions validates the key format", () => {
  assert.throws(() =>
    loadX402WalletOptions({
      X402_EVM_PRIVATE_KEY: "not-a-key",
    } as unknown as NodeJS.ProcessEnv),
  );
});

test("loadX402WalletOptions reads the spend cap", () => {
  const options = loadX402WalletOptions({
    X402_EVM_PRIVATE_KEY: TEST_PRIVATE_KEY,
    OFFLINECREATOR_X402_MAX_USD: "5",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(options?.maxPaymentUsd, 5);
});

test("loadX402WalletOptions rejects invalid spend caps", () => {
  assert.throws(() =>
    loadX402WalletOptions({
      X402_EVM_PRIVATE_KEY: TEST_PRIVATE_KEY,
      OFFLINECREATOR_X402_MAX_USD: "-1",
    } as unknown as NodeJS.ProcessEnv),
  );
});

test("fetcher passes through non-402 responses", async () => {
  let calls = 0;
  const fetcher = await createX402Fetcher(
    { evmPrivateKey: TEST_PRIVATE_KEY, maxPaymentUsd: 50 },
    (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
  );
  const response = await fetcher("https://studio.test/api/v1/models");
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

test("fetcher passes through legacy 402s without PAYMENT-REQUIRED", async () => {
  let calls = 0;
  const fetcher = await createX402Fetcher(
    { evmPrivateKey: TEST_PRIVATE_KEY, maxPaymentUsd: 50 },
    (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          error: "Not enough credits.",
          code: "INSUFFICIENT_CREDITS",
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  );
  const response = await fetcher("https://studio.test/api/v1/generations", {
    method: "POST",
    body: JSON.stringify({ modelId: "flux-schnell" }),
  });
  assert.equal(response.status, 402);
  // One initial call only: the payment wrapper never engages.
  assert.equal(calls, 1);
  const body = (await response.json()) as { code?: string };
  assert.equal(body.code, "INSUFFICIENT_CREDITS");
});

test("fetcher retries once with a payment header on an x402 402", async () => {
  const seen: { paymentHeader: string | null }[] = [];
  const baseFetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request = new Request(input, init);
    const paymentHeader = request.headers.get("PAYMENT-SIGNATURE");
    seen.push({ paymentHeader });
    if (!paymentHeader) {
      return new Response(JSON.stringify({ code: "PAYMENT_REQUIRED" }), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encode(PAYMENT_REQUIRED),
        },
      });
    }
    return new Response(JSON.stringify({ generationId: "test" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": encode({
          success: true,
          transaction: "0xtransaction",
          network: "eip155:84532",
          payer: "0xpayer",
        }),
      },
    });
  }) as typeof fetch;

  const fetcher = await createX402Fetcher(
    { evmPrivateKey: TEST_PRIVATE_KEY, maxPaymentUsd: 50 },
    baseFetch,
  );
  const response = await fetcher("https://studio.test/api/v1/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId: "flux-schnell", prompt: "a test prompt" }),
  });

  assert.equal(response.status, 200);
  // Initial passthrough 402, wrapper's own 402, then exactly one paid retry.
  assert.equal(seen.length, 3);
  assert.equal(seen[0]?.paymentHeader, null);
  assert.equal(seen[1]?.paymentHeader, null);
  assert.ok(seen[2]?.paymentHeader);

  const payload = JSON.parse(
    Buffer.from(seen[2]!.paymentHeader as string, "base64").toString("utf8"),
  ) as { accepted?: { amount?: string }; payload?: Record<string, unknown> };
  assert.equal(payload.accepted?.amount, "1000000");
  assert.ok(payload.payload);
});

test("fetcher refuses payments above the spend cap", async () => {
  const baseFetch = (async () =>
    new Response(JSON.stringify({ code: "PAYMENT_REQUIRED" }), {
      status: 402,
      headers: {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": encode(PAYMENT_REQUIRED),
      },
    })) as typeof fetch;

  // Cap of $0.50 is below the $1.00 requirement.
  const fetcher = await createX402Fetcher(
    { evmPrivateKey: TEST_PRIVATE_KEY, maxPaymentUsd: 0.5 },
    baseFetch,
  );
  await assert.rejects(
    fetcher("https://studio.test/api/v1/generations", { method: "POST" }),
  );
});
