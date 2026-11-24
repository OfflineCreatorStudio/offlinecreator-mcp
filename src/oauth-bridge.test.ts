import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createOAuthLoginHandoff,
  createTokenIntrospectionRequest,
  isOAuthAccessTokenShape,
  isOAuthLoginFlowId,
  parseTokenIntrospectionResponse,
  signOAuthBridgeRequest,
  verifyOAuthBridgeRequest,
  verifyOAuthLoginHandoff,
  verifyTokenIntrospectionRequest,
} from "./oauth-bridge.js";
import { verifyOAuthBridgeRequest as verifyWithStudio1f596af } from "./oauth-bridge-1f596af.test.js";

const secret = "test-secret-that-is-longer-than-thirty-two-bytes";
const identity = {
  userId: "123e4567-e89b-42d3-a456-426614174000",
  scopes: ["read", "models"],
};
const nonce = "n0nce-0123456789_ABCDEF";

/** A signature exactly as an OAuth Worker from before bridge nonces made it. */
async function signWithoutNonce(request: Request, nowSeconds: number) {
  const url = new URL(request.url);
  const body = await request.clone().arrayBuffer();
  const digest = Buffer.from(
    await crypto.subtle.digest("SHA-256", body),
  ).toString("base64url");
  const canonical = [
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    identity.userId,
    "models read",
    String(nowSeconds),
    digest,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonical),
  );
  return {
    "x-oc-oauth-user": identity.userId,
    "x-oc-oauth-scopes": "models read",
    "x-oc-oauth-timestamp": String(nowSeconds),
    "x-oc-oauth-signature": Buffer.from(signature).toString("base64url"),
  };
}

describe("OAuth service bridge signatures", () => {
  it("verifies an intact request", async () => {
    const unsigned = new Request("https://studio.internal/api/v1/models", {
      method: "GET",
    });
    const signedHeaders = await signOAuthBridgeRequest({
      request: unsigned,
      secret,
      identity,
      nowSeconds: 1_000,
      nonce,
    });
    const signed = new Request(unsigned, { headers: signedHeaders });

    assert.deepEqual(
      await verifyOAuthBridgeRequest({
        request: signed,
        secret,
        nowSeconds: 1_030,
      }),
      { userId: identity.userId, scopes: ["models", "read"], nonce },
    );
  });

  it("signs a fresh nonce into every request", async () => {
    const unsigned = new Request("https://studio.internal/api/v1/models");
    const first: Record<string, string> = await signOAuthBridgeRequest({
      request: unsigned,
      secret,
      identity,
    });
    const second: Record<string, string> = await signOAuthBridgeRequest({
      request: unsigned,
      secret,
      identity,
    });

    assert.match(first["x-oc-oauth-nonce"] ?? "", /^[A-Za-z0-9_-]{22}$/);
    assert.match(second["x-oc-oauth-nonce"] ?? "", /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(first["x-oc-oauth-nonce"], second["x-oc-oauth-nonce"]);
    const verified: { nonce?: string } | null = await verifyOAuthBridgeRequest({
      request: new Request(unsigned, { headers: first }),
      secret,
    });
    assert.equal(verified?.nonce, first["x-oc-oauth-nonce"]);
  });

  it("binds the nonce into its own signature", async () => {
    const unsigned = new Request("https://studio.internal/api/v1/models");
    const signedHeaders: Record<string, string> = await signOAuthBridgeRequest({
      request: unsigned,
      secret,
      identity,
      nowSeconds: 1_000,
      nonce,
    });
    const swapped = { ...signedHeaders, "x-oc-oauth-nonce": `${nonce}x` };
    const nonceOnly = { ...signedHeaders };
    delete nonceOnly["x-oc-oauth-nonce-signature"];
    const signatureOnly = { ...signedHeaders };
    delete signatureOnly["x-oc-oauth-nonce"];
    // A bad nonce signature never falls back to the valid legacy signature.
    const forged = {
      ...signedHeaders,
      "x-oc-oauth-nonce-signature": signedHeaders["x-oc-oauth-signature"]!,
    };

    for (const headers of [swapped, nonceOnly, signatureOnly, forged]) {
      assert.equal(
        await verifyOAuthBridgeRequest({
          request: new Request(unsigned, { headers }),
          secret,
          nowSeconds: 1_000,
        }),
        null,
      );
    }
    await assert.rejects(
      signOAuthBridgeRequest({
        request: unsigned,
        secret,
        identity,
        nonce: "short",
      }),
    );
  });

  it("still verifies a nonce-less signature from an older Worker", async () => {
    const unsigned = new Request("https://studio.internal/api/v1/generations", {
      method: "POST",
      body: JSON.stringify({ modelId: "flux-schnell" }),
    });
    const legacy = await signWithoutNonce(unsigned.clone(), 1_000);

    assert.deepEqual(
      await verifyOAuthBridgeRequest({
        request: new Request(unsigned.clone(), { headers: legacy }),
        secret,
        nowSeconds: 1_010,
      }),
      { userId: identity.userId, scopes: ["models", "read"] },
    );
    assert.equal(
      await verifyOAuthBridgeRequest({
        request: new Request(unsigned.clone(), {
          headers: { ...legacy, "x-oc-oauth-nonce": nonce },
        }),
        secret,
        nowSeconds: 1_010,
      }),
      null,
    );
  });

  it("keeps the legacy signature verifiable by the 1f596af Studio verifier", async () => {
    // Studio deployed before bridge nonces rebuilds the canonical string
    // without a nonce line; a Worker that ships first must still pass there.
    for (const credentialId of [undefined, "oauth-client-1"]) {
      const unsigned = new Request(
        "https://studio.internal/api/v1/generations",
        {
          method: "POST",
          body: JSON.stringify({ modelId: "flux-schnell" }),
        },
      );
      const signedHeaders = await signOAuthBridgeRequest({
        request: unsigned.clone(),
        secret,
        identity: credentialId ? { ...identity, credentialId } : identity,
        nowSeconds: 1_000,
        nonce,
      });

      assert.deepEqual(
        await verifyWithStudio1f596af({
          request: new Request(unsigned.clone(), { headers: signedHeaders }),
          secret,
          nowSeconds: 1_010,
        }),
        {
          userId: identity.userId,
          scopes: ["models", "read"],
          ...(credentialId ? { credentialId } : {}),
        },
      );
    }
  });

  it("verifies a request stripped of both nonce headers as nonce-less", async () => {
    // The legacy signature alone proves identity but not freshness; Studio
    // decides with BRIDGE_NONCE_REQUIRED whether to still accept that.
    const unsigned = new Request("https://studio.internal/api/v1/models");
    const signedHeaders: Record<string, string> = await signOAuthBridgeRequest({
      request: unsigned,
      secret,
      identity,
      nowSeconds: 1_000,
      nonce,
    });
    const legacyOnly = { ...signedHeaders };
    delete legacyOnly["x-oc-oauth-nonce"];
    delete legacyOnly["x-oc-oauth-nonce-signature"];

    assert.deepEqual(
      await verifyOAuthBridgeRequest({
        request: new Request(unsigned, { headers: legacyOnly }),
        secret,
        nowSeconds: 1_000,
      }),
      { userId: identity.userId, scopes: ["models", "read"] },
    );
  });

  it("binds an optional credential id into the signed identity", async () => {
    const unsigned = new Request("https://studio.internal/api/v1/generations", {
      method: "POST",
      body: JSON.stringify({ modelId: "flux-schnell" }),
    });
    const signedHeaders = await signOAuthBridgeRequest({
      request: unsigned,
      secret,
      identity: { ...identity, credentialId: "oauth-client-1" },
      nowSeconds: 1_000,
      nonce,
    });
    const signed = new Request(unsigned.clone(), { headers: signedHeaders });

    assert.deepEqual(
      await verifyOAuthBridgeRequest({
        request: signed,
        secret,
        nowSeconds: 1_010,
      }),
      {
        userId: identity.userId,
        scopes: ["models", "read"],
        credentialId: "oauth-client-1",
        nonce,
      },
    );

    const swapped = new Request(unsigned.clone(), {
      headers: {
        ...signedHeaders,
        "x-oc-oauth-credential": "oauth-client-2",
      },
    });
    assert.equal(
      await verifyOAuthBridgeRequest({
        request: swapped,
        secret,
        nowSeconds: 1_010,
      }),
      null,
    );
  });

  it("rejects body tampering and expired signatures", async () => {
    const unsigned = new Request("https://studio.internal/api/v1/generations", {
      method: "POST",
      body: JSON.stringify({ prompt: "original" }),
    });
    const signedHeaders = await signOAuthBridgeRequest({
      request: unsigned,
      secret,
      identity,
      nowSeconds: 1_000,
    });
    const tampered = new Request(unsigned.url, {
      method: "POST",
      headers: signedHeaders,
      body: JSON.stringify({ prompt: "tampered" }),
    });

    assert.equal(
      await verifyOAuthBridgeRequest({
        request: tampered,
        secret,
        nowSeconds: 1_010,
      }),
      null,
    );

    const signed = new Request(unsigned, { headers: signedHeaders });
    assert.equal(
      await verifyOAuthBridgeRequest({
        request: signed,
        secret,
        nowSeconds: 1_061,
      }),
      null,
    );
  });
});

describe("OAuth login handoff tokens", () => {
  const flow = "A".repeat(20) + "b-_".repeat(7) + "z".repeat(2);
  const otherFlow = "B".repeat(43);
  const handoff = {
    secret,
    flow,
    userId: identity.userId,
    email: "alice@example.com",
  };

  it("recognizes only OAuth Worker flow identifiers", () => {
    assert.equal(flow.length, 43);
    assert.equal(isOAuthLoginFlowId(flow), true);
    assert.equal(isOAuthLoginFlowId(`${flow}x`), false);
    assert.equal(isOAuthLoginFlowId("a/b".padEnd(43, "c")), false);
    assert.equal(isOAuthLoginFlowId(""), false);
  });

  it("round-trips the signed-in identity for the same flow", async () => {
    const token = await createOAuthLoginHandoff({
      ...handoff,
      nowSeconds: 1_000,
    });

    assert.deepEqual(
      await verifyOAuthLoginHandoff({ secret, flow, token, nowSeconds: 1_060 }),
      { userId: identity.userId, email: "alice@example.com" },
    );
  });

  it("keeps the email address out of the token text", async () => {
    const token = await createOAuthLoginHandoff({
      ...handoff,
      nowSeconds: 1_000,
    });

    assert.equal(token.includes("alice"), false);
    assert.equal(
      Buffer.from(token.slice(3), "base64url")
        .toString("latin1")
        .includes("alice"),
      false,
    );
  });

  it("binds the token to one flow, one secret, and a short lifetime", async () => {
    const token = await createOAuthLoginHandoff({
      ...handoff,
      nowSeconds: 1_000,
    });

    assert.equal(
      await verifyOAuthLoginHandoff({
        secret,
        flow: otherFlow,
        token,
        nowSeconds: 1_010,
      }),
      null,
    );
    assert.equal(
      await verifyOAuthLoginHandoff({
        secret: "another-secret-that-is-longer-than-thirty-two-bytes",
        flow,
        token,
        nowSeconds: 1_010,
      }),
      null,
    );
    assert.equal(
      await verifyOAuthLoginHandoff({ secret, flow, token, nowSeconds: 1_121 }),
      null,
    );
  });

  it("rejects tampered and malformed tokens", async () => {
    const token = await createOAuthLoginHandoff({
      ...handoff,
      nowSeconds: 1_000,
    });
    // Flip one bit of a decoded byte: in the IV, the ciphertext, and the tag.
    // Editing the last base64url character instead can change only padding
    // bits that decoding drops, leaving the token valid about 1 run in 16.
    const sealed = Buffer.from(token.slice("v1.".length), "base64url");
    const flipped = (index: number) => {
      const bytes = Buffer.from(sealed);
      bytes[index] = bytes[index]! ^ 0x01;
      return `v1.${bytes.toString("base64url")}`;
    };

    for (const candidate of [
      flipped(0),
      flipped(Math.floor(sealed.length / 2)),
      flipped(sealed.length - 1),
      token.replace(/^v1\./, "v2."),
      "v1.",
      "not-a-token",
      "",
    ]) {
      assert.equal(
        await verifyOAuthLoginHandoff({
          secret,
          flow,
          token: candidate,
          nowSeconds: 1_010,
        }),
        null,
      );
    }
    assert.equal(
      await verifyOAuthLoginHandoff({
        secret: "short",
        flow,
        token,
        nowSeconds: 1_010,
      }),
      null,
    );
  });

  it("refuses to mint tokens for invalid users or flows", async () => {
    await assert.rejects(
      createOAuthLoginHandoff({ ...handoff, userId: "demo-user" }),
    );
    await assert.rejects(
      createOAuthLoginHandoff({ ...handoff, flow: "not-a-flow" }),
    );
    await assert.rejects(
      createOAuthLoginHandoff({ ...handoff, secret: "short" }),
    );
  });

  it("carries a missing email as null", async () => {
    const token = await createOAuthLoginHandoff({
      ...handoff,
      email: null,
      nowSeconds: 1_000,
    });

    assert.deepEqual(
      await verifyOAuthLoginHandoff({ secret, flow, token, nowSeconds: 1_000 }),
      { userId: identity.userId, email: null },
    );
  });
});

describe("OAuth access token introspection", () => {
  const token = `${identity.userId}:grant123:${"a".repeat(32)}`;

  it("tells Worker access tokens apart from Studio API keys", () => {
    assert.equal(isOAuthAccessTokenShape(token), true);
    assert.equal(isOAuthAccessTokenShape("oc_live_example"), false);
    assert.equal(
      isOAuthAccessTokenShape("oc_test_a:b:cccccccccccccccccccc"),
      false,
    );
    assert.equal(isOAuthAccessTokenShape("a:b"), false);
    assert.equal(isOAuthAccessTokenShape(`${identity.userId}:g:short`), false);
    assert.equal(isOAuthAccessTokenShape(`${token}:extra`), false);
  });

  it("verifies its own signature and returns the token", async () => {
    const request = await createTokenIntrospectionRequest({
      oauthOrigin: "https://mcp.test/",
      secret,
      token,
      nowSeconds: 1_000,
    });
    assert.equal(
      new URL(request.url).toString(),
      "https://mcp.test/oauth/introspect",
    );
    assert.equal(
      await verifyTokenIntrospectionRequest({
        request,
        secret,
        nowSeconds: 1_030,
      }),
      token,
    );
  });

  it("rejects a wrong secret, a stale timestamp, a changed body or another path", async () => {
    const make = () =>
      createTokenIntrospectionRequest({
        oauthOrigin: "https://mcp.test",
        secret,
        token,
        nowSeconds: 1_000,
      });
    assert.equal(
      await verifyTokenIntrospectionRequest({
        request: await make(),
        secret: "another-secret-that-is-longer-than-thirty-two",
        nowSeconds: 1_000,
      }),
      null,
    );
    assert.equal(
      await verifyTokenIntrospectionRequest({
        request: await make(),
        secret,
        nowSeconds: 1_061,
      }),
      null,
    );
    const original = await make();
    const swapped = new Request(original.url, {
      method: "POST",
      headers: original.headers,
      body: new URLSearchParams({ token: `${token}x` }).toString(),
    });
    assert.equal(
      await verifyTokenIntrospectionRequest({
        request: swapped,
        secret,
        nowSeconds: 1_000,
      }),
      null,
    );
    const moved = new Request("https://mcp.test/oauth/token", {
      method: "POST",
      headers: original.headers,
      body: await original.clone().text(),
    });
    assert.equal(
      await verifyTokenIntrospectionRequest({
        request: moved,
        secret,
        nowSeconds: 1_000,
      }),
      null,
    );
  });

  it("treats anything but a well-formed live answer as inactive", () => {
    const live = {
      active: true,
      sub: identity.userId,
      client_id: "client-1",
      scope: "openid models read",
      exp: 2_000,
    };
    assert.deepEqual(parseTokenIntrospectionResponse(live, 1_000), {
      active: true,
      userId: identity.userId,
      clientId: "client-1",
      scopes: ["openid", "models", "read"],
      expiresAt: 2_000,
      audience: [],
    });
    assert.deepEqual(
      parseTokenIntrospectionResponse(
        { ...live, aud: "https://mcp.test/mcp" },
        1_000,
      ),
      {
        ...parseTokenIntrospectionResponse(live, 1_000),
        audience: ["https://mcp.test/mcp"],
      },
    );
    for (const bad of [
      null,
      "active",
      { active: false },
      { ...live, active: "true" },
      { ...live, exp: 999 },
      { ...live, sub: "demo-user" },
      { ...live, client_id: "" },
      { ...live, scope: ["read"] },
    ]) {
      assert.deepEqual(parseTokenIntrospectionResponse(bad, 1_000), {
        active: false,
      });
    }
  });
});
