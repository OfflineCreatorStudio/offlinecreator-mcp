import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PUBLISHED_MCP_RELEASE } from "./server.js";
import {
  DEFAULT_WEB_BOT_AUTH_PUBLIC_JWK,
  STUDIO_SKILL_MARKDOWN,
  contentDigestHeader,
  handleAgentReadinessRequest,
  isAuthMdDiscoveryPath,
  jwkThumbprint,
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
      assert.equal(body.registration_endpoint, `${ORIGIN}/oauth/register`);
      assert.equal(body.jwks_uri, `${ORIGIN}/.well-known/jwks.json`);
      assert.equal(body.revocation_endpoint, undefined);
      assert.deepEqual(body.grant_types_supported, [
        "authorization_code",
        "refresh_token",
      ]);
      assert.deepEqual(body.response_types_supported, ["code"]);
      const agentAuth = body.agent_auth as Record<string, unknown>;
      assert.equal(agentAuth.skill, `${ORIGIN}/auth.md`);
      assert.equal(agentAuth.register_uri, `${ORIGIN}/oauth/register`);
      assert.deepEqual(agentAuth.methods, [
        {
          type: "oauth_dynamic_client_registration",
          register_uri: `${ORIGIN}/oauth/register`,
        },
        {
          type: "authorization_code_pkce",
          authorization_endpoint: `${ORIGIN}/authorize`,
          token_endpoint: `${ORIGIN}/oauth/token`,
          code_challenge_methods_supported: ["S256"],
        },
      ]);
      assert.equal(agentAuth.identity_types_supported, undefined);
      assert.equal(agentAuth.identity_assertion, undefined);
      assert.equal(agentAuth.anonymous, undefined);
      assert.equal(agentAuth.events_supported, undefined);
      assert.equal(agentAuth.revocation_uri, undefined);
      assert.equal(agentAuth.claim_uri, undefined);
    }
    const oidc = await readJson("/.well-known/openid-configuration");
    assert.equal(oidc.jwks_uri, `${ORIGIN}/.well-known/jwks.json`);
    assert.equal(oidc.userinfo_endpoint, `${ORIGIN}/userinfo`);
    assert.deepEqual(oidc.id_token_signing_alg_values_supported, ["RS256"]);
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
    // The cards describe the hosted server: the published release.
    assert.equal(agentCard.version, PUBLISHED_MCP_RELEASE.version);
    assert.ok(typeof agentCard.description === "string");
    const interfaces = agentCard.supportedInterfaces as Array<
      Record<string, string>
    >;
    assert.equal(interfaces.length, 1);
    assert.equal(interfaces[0]?.url, `${ORIGIN}/mcp/a2a`);
    assert.equal(interfaces[0]?.protocolBinding, "JSONRPC");
    assert.equal(interfaces[0]?.protocolVersion, "1.0");
    const capabilities = agentCard.capabilities as {
      streaming: boolean;
      pushNotifications: boolean;
      extendedAgentCard: boolean;
    };
    assert.equal(capabilities.streaming, false);
    assert.equal(capabilities.pushNotifications, false);
    assert.equal(capabilities.extendedAgentCard, false);
    const skills = agentCard.skills as Array<Record<string, string>>;
    assert.ok(
      skills.some((skill) => skill.id && skill.name && skill.description),
    );
    assert.ok(
      skills.some((skill) => skill.id === "offlinecreator.list-models.v1"),
    );
    assert.ok(
      skills.some((skill) => skill.id === "offlinecreator.generate-media.v1"),
    );

    const serverCard = await readJson("/.well-known/mcp/server-card.json");
    const serverInfo = serverCard.serverInfo as Record<string, string>;
    assert.equal(serverInfo.name, "offlinecreator-studio");
    assert.equal(serverInfo.version, PUBLISHED_MCP_RELEASE.version);
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

  it("publishes commerce discovery pointing at live Studio routes", async () => {
    const acp = await readJson("/.well-known/acp.json");
    const protocol = acp.protocol as Record<string, string>;
    assert.equal(protocol.name, "acp");
    assert.ok(protocol.version);
    assert.match(String(acp.api_base_url), /^https:\/\//);
    assert.ok(Array.isArray(acp.transports) && acp.transports.length > 0);
    const acpCapabilities = acp.capabilities as { services: string[] };
    assert.ok(acpCapabilities.services.length > 0);
    assert.match(String(acp.api_base_url), /\/api\/acp$/);

    const ucp = await readJson("/.well-known/ucp");
    assert.equal(ucp.protocol_version, "2026-04-08");
    assert.ok(ucp.services);
    assert.ok(ucp.capabilities);
    assert.ok(ucp.endpoints);

    const openapi = await readJson("/openapi.json");
    const payment = (
      openapi.paths as {
        "/api/v1/generations": {
          post: { "x-payment-info": Record<string, unknown> };
        };
      }
    )["/api/v1/generations"].post["x-payment-info"];
    assert.equal(payment.intent, "charge");
    assert.equal(payment.method, "stripe");
    assert.equal(payment.amount, null);
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
    assert.match(headers["Signature-Input"], /expires=/);
    assert.match(headers["Signature-Input"], /"signature-agent"/);
    assert.equal(headers["Signature-Agent"], `"${ORIGIN}"`);

    const directoryBody = new TextEncoder().encode(
      JSON.stringify({ keys: [publicJwk] }),
    );
    const digest = await contentDigestHeader(directoryBody);
    const signedDirectory = await signWebBotAuthHeaders({
      request: new Request(
        `${ORIGIN}/.well-known/http-message-signatures-directory`,
      ),
      origin: ORIGIN,
      privateJwk,
      publicJwk: { ...publicJwk, kid: await jwkThumbprint(publicJwk) },
      nowSeconds: 1_700_000_000,
      tag: "http-message-signatures-directory",
      contentDigest: digest,
    });
    assert.match(signedDirectory["Signature-Input"], /"content-digest"/);
    assert.equal(signedDirectory["Content-Digest"], digest);
    const tampered = await contentDigestHeader(
      new TextEncoder().encode("tampered"),
    );
    assert.notEqual(tampered, digest);
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
    assert.equal(
      await handleAgentReadinessRequest(
        new Request(`${ORIGIN}/agent/auth`, { method: "POST" }),
      ),
      null,
    );
    assert.equal(isAuthMdDiscoveryPath("/auth.md"), true);
    assert.equal(
      isAuthMdDiscoveryPath("/.well-known/oauth-authorization-server/"),
      true,
    );
    assert.equal(isAuthMdDiscoveryPath("/authorize"), false);
    assert.equal(isAuthMdDiscoveryPath("/agent/auth"), false);
  });

  it("publishes an ARD capability manifest referencing the served cards", async () => {
    const body = await readJson("/.well-known/ai-catalog.json");
    assert.equal(body.specVersion, "1.0");
    // The host identifier must equal the publisher segment of the entry URNs,
    // or trust-manifest verification cannot line up.
    const host = body.host as Record<string, unknown>;
    assert.equal(host.displayName, "OfflineCreator Studio");
    assert.equal(host.identifier, "mcp.offlinecreatorstudio.com");

    const entries = body.entries as Array<Record<string, unknown>>;
    assert.ok(entries.length >= 3);
    for (const entry of entries) {
      // urn:ai:<domain>:<namespace>:<name> per the ARD identifier format.
      assert.match(
        String(entry.identifier),
        /^urn:ai:mcp\.offlinecreatorstudio\.com:[a-z0-9-]+:[a-z0-9-]+$/,
      );
      // Exactly one of url or data, per the ARD schema's oneOf.
      assert.equal(typeof entry.url, "string");
      assert.equal(entry.data, undefined);
      assert.ok(String(entry.url).startsWith(`${ORIGIN}/`));
      assert.equal(entry.mediaType, entry.type);
      const queries = entry.representativeQueries as string[];
      assert.ok(queries.length >= 2 && queries.length <= 5);
    }

    const urls = entries.map((entry) => String(entry.url));
    assert.ok(urls.includes(`${ORIGIN}/.well-known/mcp/server-card.json`));
    assert.ok(urls.includes(`${ORIGIN}/.well-known/agent-card.json`));
    assert.ok(
      urls.includes(
        `${ORIGIN}/.well-known/agent-skills/offlinecreator-studio/SKILL.md`,
      ),
    );
  });
});
