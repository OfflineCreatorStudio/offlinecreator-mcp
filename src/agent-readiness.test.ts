import assert from "node:assert/strict";
import { describe, it } from "node:test";
import packageMetadata from "../package.json" with { type: "json" };
import {
  DEFAULT_WEB_BOT_AUTH_PUBLIC_JWK,
  STUDIO_SKILL_MARKDOWN,
  handleAgentReadinessRequest,
  signWebBotAuthHeaders,
  type AgentReadinessJwk,
} from "./agent-readiness.js";

const ORIGIN = "https://mcp.offlinecreatorstudio.com";

async function get(path: string, headers?: Record<string, string>) {
  const response = await handleAgentReadinessRequest(
    new Request(`${ORIGIN}${path}`, { headers }),
  );
  assert.ok(response, `expected a response for ${path}`);
  return response;
}

async function readJson(path: string) {
  const response = await get(path);
  assert.equal(response.status, 200);
  return response.json() as Promise<Record<string, unknown>>;
}

describe("agent readiness discovery", () => {
  it("serves OAuth and OpenID discovery with required fields", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]) {
      const body = await readJson(path);
      assert.equal(body.issuer, ORIGIN);
      assert.equal(body.authorization_endpoint, `${ORIGIN}/authorize`);
      assert.equal(body.token_endpoint, `${ORIGIN}/oauth/token`);
      assert.equal(body.jwks_uri, `${ORIGIN}/.well-known/jwks.json`);
      assert.deepEqual(body.grant_types_supported, [
        "authorization_code",
        "refresh_token",
      ]);
      assert.deepEqual(body.response_types_supported, ["code"]);
      const agentAuth = body.agent_auth as Record<string, unknown>;
      assert.equal(agentAuth.skill, `${ORIGIN}/auth.md`);
      assert.equal(agentAuth.register_uri, `${ORIGIN}/oauth/register`);
      assert.ok(Array.isArray(agentAuth.methods));
      assert.ok((agentAuth.methods as unknown[]).length >= 1);
    }
  });

  it("publishes origin-matching protected resource metadata", async () => {
    const origin = await readJson("/.well-known/oauth-protected-resource");
    assert.equal(origin.resource, ORIGIN);
    assert.deepEqual(origin.authorization_servers, [ORIGIN]);
    assert.deepEqual(origin.scopes_supported, ["models", "read", "generate"]);
    assert.deepEqual(origin.bearer_methods_supported, ["header"]);

    const mcp = await readJson("/.well-known/oauth-protected-resource/mcp");
    assert.equal(mcp.resource, `${ORIGIN}/mcp`);
  });

  it("serves auth.md with the required heading", async () => {
    const response = await get("/auth.md");
    const text = await response.text();
    assert.match(response.headers.get("content-type") ?? "", /text\/markdown/);
    assert.match(text, /^# auth\.md/m);
    assert.match(text, /register/i);
  });

  it("publishes A2A, MCP, skills, and API catalog documents", async () => {
    const agentCard = await readJson("/.well-known/agent-card.json");
    assert.equal(agentCard.name, "OfflineCreator Studio");
    assert.equal(agentCard.version, packageMetadata.version);
    assert.ok(typeof agentCard.description === "string");
    const interfaces = agentCard.supportedInterfaces as Array<
      Record<string, string>
    >;
    assert.ok(interfaces.length >= 1);
    assert.ok(interfaces[0]?.url);
    assert.ok(interfaces[0]?.protocolBinding);
    const capabilities = agentCard.capabilities as {
      extensions: Array<{
        uri: string;
        required: boolean;
        params: { roles: string[] };
      }>;
    };
    assert.equal(
      capabilities.extensions[0]?.uri,
      "https://github.com/google-agentic-commerce/AP2/tree/v0.1.0",
    );
    assert.equal(capabilities.extensions[0]?.required, true);
    assert.deepEqual(capabilities.extensions[0]?.params.roles, ["merchant"]);
    const skills = agentCard.skills as Array<Record<string, string>>;
    assert.ok(
      skills.some((skill) => skill.id && skill.name && skill.description),
    );

    const serverCard = await readJson("/.well-known/mcp/server-card.json");
    const serverInfo = serverCard.serverInfo as Record<string, string>;
    assert.equal(serverInfo.name, "offlinecreator-studio");
    assert.equal(serverInfo.version, packageMetadata.version);
    assert.equal(serverCard.endpoint, `${ORIGIN}/mcp`);
    assert.deepEqual(serverCard.capabilities, {
      tools: true,
      resources: false,
      prompts: false,
    });

    const index = await readJson("/.well-known/agent-skills/index.json");
    assert.equal(
      index.$schema,
      "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    );
    const skill = (index.skills as Array<Record<string, string>>)[0];
    assert.equal(skill.name, "offlinecreator-studio");
    assert.equal(skill.type, "skill-md");
    assert.match(skill.digest, /^sha256:[0-9a-f]{64}$/);
    const artifact = await get(
      "/.well-known/agent-skills/offlinecreator-studio/SKILL.md",
    );
    assert.equal(await artifact.text(), STUDIO_SKILL_MARKDOWN);

    const catalogResponse = await get("/.well-known/api-catalog");
    assert.match(
      catalogResponse.headers.get("content-type") ?? "",
      /application\/linkset\+json/,
    );
    const catalog = (await catalogResponse.json()) as {
      linkset: Array<Record<string, unknown>>;
    };
    assert.ok(catalog.linkset[0]?.anchor);
    assert.ok(catalog.linkset[0]?.["service-desc"]);
    assert.ok(catalog.linkset[0]?.["service-doc"]);
  });

  it("publishes commerce discovery and a 402 payment challenge", async () => {
    const acp = await readJson("/.well-known/acp.json");
    const protocol = acp.protocol as Record<string, string>;
    assert.equal(protocol.name, "acp");
    assert.ok(protocol.version);
    assert.match(String(acp.api_base_url), /^https:\/\//);
    assert.ok(Array.isArray(acp.transports) && acp.transports.length > 0);
    const acpCapabilities = acp.capabilities as { services: string[] };
    assert.ok(acpCapabilities.services.length > 0);

    const ucp = await readJson("/.well-known/ucp");
    assert.equal(ucp.protocol_version, "2026-04-08");
    assert.ok(ucp.services);
    assert.ok(ucp.capabilities);
    assert.ok(ucp.endpoints);

    const openapi = await readJson("/openapi.json");
    const payment = (
      openapi.paths as {
        "/x402/credits": {
          post: { "x-payment-info": Record<string, unknown> };
        };
      }
    )["/x402/credits"].post["x-payment-info"];
    assert.equal(payment.intent, "charge");
    assert.equal(payment.method, "card");
    assert.equal(payment.amount, 5);

    const paid = await handleAgentReadinessRequest(
      new Request(`${ORIGIN}/x402/credits`, { method: "POST" }),
    );
    assert.ok(paid);
    assert.equal(paid.status, 402);
    const challenge = (await paid.json()) as { x402Version: number };
    assert.equal(challenge.x402Version, 1);
  });

  it("exposes WebMCP, markdown negotiation, Link headers, and Content Signals", async () => {
    const html = await get("/");
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);
    assert.match(html.headers.get("link") ?? "", /rel="api-catalog"/);
    assert.match(html.headers.get("link") ?? "", /rel="service-desc"/);
    assert.match(html.headers.get("link") ?? "", /rel="service-doc"/);
    assert.match(html.headers.get("link") ?? "", /rel="describedby"/);
    const page = await html.text();
    assert.match(page, /navigator\.modelContext\.registerTool/);
    assert.match(page, /AbortController/);
    assert.match(page, /inputSchema/);

    const markdown = await get("/", { accept: "text/markdown" });
    assert.match(markdown.headers.get("content-type") ?? "", /text\/markdown/);
    assert.ok(Number(markdown.headers.get("x-markdown-tokens")) > 0);
    assert.match(await markdown.text(), /# OfflineCreator Studio MCP/);

    const robots = await (await get("/robots.txt")).text();
    assert.match(robots, /User-agent: \*/);
    assert.match(
      robots,
      /Content-Signal: ai-train=no, search=yes, ai-input=yes/,
    );
  });

  it("publishes a Web Bot Auth JWKS directory and can sign requests", async () => {
    const response = await get(
      "/.well-known/http-message-signatures-directory",
    );
    assert.match(
      response.headers.get("content-type") ?? "",
      /http-message-signatures-directory\+json/,
    );
    const body = (await response.json()) as {
      keys: Array<{ kty: string; x?: string }>;
    };
    assert.equal(body.keys[0]?.kty, "OKP");
    assert.equal(body.keys[0]?.x, DEFAULT_WEB_BOT_AUTH_PUBLIC_JWK.x);

    const pair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as never as {
      privateKey: never;
      publicKey: never;
    };
    const privateJwk = (await crypto.subtle.exportKey(
      "jwk",
      pair.privateKey,
    )) as AgentReadinessJwk;
    const publicJwk = (await crypto.subtle.exportKey(
      "jwk",
      pair.publicKey,
    )) as AgentReadinessJwk;
    const request = new Request(`${ORIGIN}/mcp`);
    const headers = await signWebBotAuthHeaders({
      request,
      origin: ORIGIN,
      privateJwk,
      publicJwk: { ...publicJwk, kid: "test-key" },
      nowSeconds: 1_700_000_000,
    });
    assert.match(headers.Signature, /^sig1=:/);
    assert.match(headers["Signature-Input"], /tag="web-bot-auth"/);
    assert.equal(headers["Signature-Agent"], `"${ORIGIN}"`);
  });

  it("leaves non-discovery routes for the existing Worker", async () => {
    assert.equal(
      await handleAgentReadinessRequest(new Request(`${ORIGIN}/mcp`)),
      null,
    );
    assert.equal(
      await handleAgentReadinessRequest(new Request(`${ORIGIN}/authorize`)),
      null,
    );
  });
});
