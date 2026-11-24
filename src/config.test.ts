import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertTrustedApiBase, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("requires an API key", () => {
    assert.throws(
      () => loadConfig({}),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /OFFLINECREATOR_API_KEY/);
        assert.match(
          error.message,
          /https:\/\/offlinecreatorstudio\.com\/auth\?next=\/settings/,
        );
        assert.match(error.message, /sign in or create an account/i);
        return true;
      },
    );
  });

  it("accepts oc_live_ and oc_test_ keys against the default host", () => {
    const live = loadConfig({
      OFFLINECREATOR_API_KEY: "oc_live_abc",
    });
    assert.equal(live.apiBase, "https://offlinecreatorstudio.com");
    assert.equal(live.apiKey, "oc_live_abc");

    const local = loadConfig({
      OFFLINECREATOR_API_KEY: "oc_test_abc",
      OFFLINECREATOR_API_BASE: "http://localhost:3000/",
    });
    assert.equal(local.apiBase, "http://localhost:3000");
  });

  it("rejects malformed keys", () => {
    assert.throws(
      () => loadConfig({ OFFLINECREATOR_API_KEY: "sk-bad" }),
      /invalid/i,
    );
  });

  it("rejects untrusted remote API bases by default", () => {
    assert.throws(
      () =>
        assertTrustedApiBase("https://evil.example", {
          OFFLINECREATOR_API_KEY: "oc_test_abc",
        }),
      /not trusted/i,
    );
  });

  it("rejects the retired studio.offlinecreator.com host", () => {
    assert.throws(
      () =>
        assertTrustedApiBase("https://studio.offlinecreator.com", {
          OFFLINECREATOR_API_KEY: "oc_test_abc",
        }),
      /not trusted/i,
    );
  });

  it("allows explicit insecure override for private staging", () => {
    const base = assertTrustedApiBase("https://staging.example", {
      OFFLINECREATOR_ALLOW_INSECURE_API_BASE: "true",
    });
    assert.equal(base, "https://staging.example");
  });
});
