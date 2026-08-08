import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  signOAuthBridgeRequest,
  verifyOAuthBridgeRequest,
} from "./oauth-bridge.js";

const secret = "test-secret-that-is-longer-than-thirty-two-bytes";
const identity = {
  userId: "123e4567-e89b-42d3-a456-426614174000",
  scopes: ["read", "models"],
};

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
    });
    const signed = new Request(unsigned, { headers: signedHeaders });

    assert.deepEqual(
      await verifyOAuthBridgeRequest({
        request: signed,
        secret,
        nowSeconds: 1_030,
      }),
      { userId: identity.userId, scopes: ["models", "read"] },
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
