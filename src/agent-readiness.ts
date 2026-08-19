import packageMetadata from "../package.json" with { type: "json" };
import { MCP_SERVER_INFO, TOOL_ANNOTATIONS } from "./server.js";

export const STUDIO_ORIGIN = "https://offlinecreatorstudio.com";
export const MCP_ORIGIN = "https://mcp.offlinecreatorstudio.com";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=300",
} as const;

export const DEFAULT_WEB_BOT_AUTH_PUBLIC_JWK = {
  kty: "OKP",
  crv: "Ed25519",
  x: "0Kc5_275qataiaq5LQJu5ggjXHyKmfSJQzjFhAOr3A8",
  kid: "40x39dyWh9l5wH2u1jvP8QwHUyVibnCEjaBFPId2Yaw",
  alg: "ed25519",
} as const;

const DEFAULT_X402_PAY_TO = "0x000000000000000000000000000000000000dEaD";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AP2_URI = "https://github.com/google-agentic-commerce/AP2/tree/v0.1.0";
const SKILLS_SCHEMA =
  "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const UCP_VERSION = "2026-04-08";
const UCP_OVERVIEW = `https://ucp.dev/${UCP_VERSION}/specification/overview`;
const UCP_SHOPPING_OPENAPI = `https://ucp.dev/${UCP_VERSION}/services/shopping/rest.openapi.json`;
const UCP_CHECKOUT_SPEC = `https://ucp.dev/${UCP_VERSION}/specification/checkout`;
const UCP_CHECKOUT_SCHEMA = `https://ucp.dev/${UCP_VERSION}/schemas/shopping/checkout.json`;

export type AgentReadinessJwk = {
  kty: string;
  crv?: string;
  x?: string;
  d?: string;
  kid?: string;
  alg?: string;
  key_ops?: string[];
  ext?: boolean;
};

type HeaderMap = Record<string, string>;

export type AgentReadinessOptions = {
  origin?: string;
  authorizationServer?: string;
  studioOrigin?: string;
  version?: string;
  x402PayTo?: string;
  webBotAuthPublicJwk?: AgentReadinessJwk;
  webBotAuthPrivateJwk?: AgentReadinessJwk;
};

export type ResolvedAgentReadiness = {
  origin: string;
  authorizationServer: string;
  studioOrigin: string;
  version: string;
  x402PayTo: string;
  webBotAuthPublicJwk: AgentReadinessJwk;
  webBotAuthPrivateJwk?: AgentReadinessJwk;
};

export const STUDIO_SKILL_MARKDOWN = `# OfflineCreator Studio

Connect an agent to OfflineCreator Studio image and video generation.

## When to use

Use this skill to list launch models, start generations, wait for outputs, or
check credit balance through the remote MCP server.

## Connect

1. Read \`/.well-known/mcp/server-card.json\` and \`/auth.md\`.
2. Add the Streamable HTTP endpoint \`/mcp\`. Compatible clients discover OAuth
   from the resource and complete Authorization Code with PKCE.
3. Call \`list_models\` before \`generate\`. Treat output URLs as short-lived.

Do not place a personal API key in remote configuration. Local stdio is only
for \`npx -y @offlinecreator/mcp\` with \`OFFLINECREATOR_API_KEY\`.
`;

type JsonRecord = Record<string, unknown>;

function trimOrigin(value: string) {
  return value.replace(/\/$/, "");
}

function requestOrigin(request: Request) {
  return trimOrigin(new URL(request.url).origin);
}

export function resolveAgentReadiness(
  request: Request,
  options: AgentReadinessOptions = {},
): ResolvedAgentReadiness {
  const origin = trimOrigin(options.origin ?? requestOrigin(request));
  return {
    origin,
    authorizationServer: trimOrigin(options.authorizationServer ?? origin),
    studioOrigin: trimOrigin(options.studioOrigin ?? STUDIO_ORIGIN),
    version: options.version ?? packageMetadata.version,
    x402PayTo: options.x402PayTo ?? DEFAULT_X402_PAY_TO,
    webBotAuthPublicJwk:
      options.webBotAuthPublicJwk ?? DEFAULT_WEB_BOT_AUTH_PUBLIC_JWK,
    webBotAuthPrivateJwk: options.webBotAuthPrivateJwk,
  };
}

function jsonResponse(
  body: unknown,
  contentType = "application/json",
  extra?: HeaderMap,
) {
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "content-type": `${contentType}; charset=utf-8`,
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

function textResponse(body: string, contentType: string, extra?: HeaderMap) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": `${contentType}; charset=utf-8`,
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

function prefersMarkdown(request: Request) {
  return /\btext\/markdown\b/i.test(request.headers.get("accept") ?? "");
}

function tokenCount(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function agentReadinessLinkHeader(origin: string) {
  const base = trimOrigin(origin);
  return [
    `<${base}/.well-known/api-catalog>; rel="api-catalog"`,
    `<${base}/openapi.json>; rel="service-desc"; type="application/json"`,
    `<${base}/auth.md>; rel="service-doc"; type="text/markdown"`,
    `<${base}/.well-known/mcp/server-card.json>; rel="describedby"; type="application/json"`,
  ].join(", ");
}

function homepageHeaders(origin: string, extra?: HeaderMap) {
  return {
    link: agentReadinessLinkHeader(origin),
    "content-security-policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    ...extra,
  };
}

export function webMcpScript(origin: string) {
  const base = trimOrigin(origin);
  return `(() => {
  const controller = new AbortController();
  if (!navigator.modelContext || typeof navigator.modelContext.registerTool !== "function") return;
  const signal = controller.signal;
  const tools = [
    {
      name: "list_models",
      description: "List OfflineCreator Studio launch models, credit costs, and workflows.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({
        content: [{ type: "text", text: "Open ${base}/mcp or Studio models after OAuth." }],
      }),
    },
    {
      name: "search_models",
      description: "Search Studio launch models by name or workflow.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Model name or workflow" } },
        required: ["query"],
      },
      execute: async ({ query }) => ({
        content: [{ type: "text", text: "Search Studio models for: " + query }],
      }),
    },
    {
      name: "open_studio",
      description: "Navigate the browser to OfflineCreator Studio or the MCP docs.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["home", "docs", "settings", "mcp"] },
        },
      },
      execute: async ({ target }) => {
        const routes = {
          home: "${base}/",
          docs: "${base}/mcp-cli",
          settings: "${STUDIO_ORIGIN}/settings",
          mcp: "${base}/mcp",
        };
        const href = routes[target || "home"] || routes.home;
        if (typeof location !== "undefined") location.assign(href);
        return { content: [{ type: "text", text: "Navigating to " + href }] };
      },
    },
    {
      name: "get_credits",
      description: "Retrieve the signed-in Studio credit balance via the MCP resource.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({
        content: [{ type: "text", text: "Call get_credits on ${base}/mcp after OAuth." }],
      }),
    },
  ];
  for (const tool of tools) {
    navigator.modelContext.registerTool(tool, { signal });
  }
})();
`;
}

export function homepageMarkdown(config: ResolvedAgentReadiness) {
  return `# OfflineCreator Studio MCP

Remote Model Context Protocol server for OfflineCreator Studio image and video generation.

- MCP: ${config.origin}/mcp
- OAuth: ${config.authorizationServer}
- Docs: ${config.studioOrigin}/mcp-cli
- Agent card: ${config.origin}/.well-known/agent-card.json
- Server card: ${config.origin}/.well-known/mcp/server-card.json
- Auth: ${config.origin}/auth.md

Connect a compatible client to the Streamable HTTP endpoint. Clients discover
OAuth and complete browser consent. Do not add an API key to remote configuration.
`;
}

export function homepageHtml(config: ResolvedAgentReadiness) {
  const script = webMcpScript(config.origin);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>OfflineCreator Studio MCP</title>
  <meta name="description" content="OfflineCreator Studio remote MCP, OAuth, and agent discovery.">
</head>
<body>
  <h1>OfflineCreator Studio MCP</h1>
  <p>Connect an MCP client to <a href="${config.origin}/mcp"><code>/mcp</code></a>.</p>
  <ul>
    <li><a href="${config.origin}/auth.md">auth.md</a></li>
    <li><a href="${config.origin}/.well-known/mcp/server-card.json">MCP Server Card</a></li>
    <li><a href="${config.origin}/.well-known/agent-card.json">A2A Agent Card</a></li>
    <li><a href="${config.studioOrigin}/mcp-cli">Documentation</a></li>
  </ul>
  <script>${script}</script>
  <script src="${config.origin}/webmcp.js"></script>
</body>
</html>
`;
}

export function robotsTxt(config: ResolvedAgentReadiness) {
  return `User-agent: *
Allow: /
Allow: /.well-known/
Allow: /auth.md
Allow: /openapi.json
Allow: /mcp
Disallow: /oauth/token
Content-Signal: ai-train=no, search=yes, ai-input=yes

User-agent: GPTBot
Allow: /
Content-Signal: ai-train=no, search=yes, ai-input=yes

Sitemap: ${config.origin}/sitemap.xml
`;
}

export function sitemapXml(config: ResolvedAgentReadiness) {
  const paths = [
    "/",
    "/auth.md",
    "/openapi.json",
    "/llms.txt",
    "/.well-known/mcp/server-card.json",
    "/.well-known/agent-card.json",
    "/.well-known/api-catalog",
  ];
  const urls = paths
    .map(
      (path) =>
        `  <url><loc>${config.origin}${path}</loc><changefreq>weekly</changefreq></url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export function authMarkdown(config: ResolvedAgentReadiness) {
  return `# auth.md

OfflineCreator Studio supports agent registration through OAuth 2.0
Authorization Code with PKCE and RFC 7591 dynamic client registration.

## Audience

Agents that need to generate images or videos, list models, or read generation
status for a Studio user.

## Protected resource

- Resource: \`${config.origin}/mcp\`
- Protected Resource Metadata: \`${config.origin}/.well-known/oauth-protected-resource\`
- Authorization server: \`${config.authorizationServer}\`
- Scopes: \`models\`, \`read\`, \`generate\`
- Bearer method: \`Authorization\` header

## Registration methods

1. **OAuth dynamic client registration** — \`POST ${config.authorizationServer}/oauth/register\`
2. **Browser consent** — send the user to \`${config.authorizationServer}/authorize\`
3. **Local stdio provisioning** — create a personal key at ${config.studioOrigin}/settings for \`npx -y @offlinecreator/mcp\` only

Remote clients must not embed API keys. After registration, exchange the
authorization code at \`${config.authorizationServer}/oauth/token\` and call
\`${config.origin}/mcp\`.

## Agent auth metadata

Machine-readable registration lives on Authorization Server metadata as
\`agent_auth\`, including \`skill\`, \`register_uri\`, identity assertion (ID-JAG),
verified email, and anonymous claim URIs.
`;
}

export function authorizationServerMetadata(config: ResolvedAgentReadiness) {
  const as = config.authorizationServer;
  return {
    issuer: as,
    authorization_endpoint: `${as}/authorize`,
    token_endpoint: `${as}/oauth/token`,
    registration_endpoint: `${as}/oauth/register`,
    jwks_uri: `${config.origin}/.well-known/jwks.json`,
    revocation_endpoint: `${as}/oauth/token`,
    scopes_supported: ["models", "read", "generate"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    agent_auth: {
      skill: `${config.origin}/auth.md`,
      register_uri: `${as}/oauth/register`,
      registration_endpoint: `${as}/oauth/register`,
      claim_uri: `${as}/authorize`,
      revocation_uri: `${as}/oauth/token`,
      methods: [
        {
          type: "oauth_dynamic_client_registration",
          register_uri: `${as}/oauth/register`,
        },
        {
          type: "authorization_code_pkce",
          authorization_endpoint: `${as}/authorize`,
          token_endpoint: `${as}/oauth/token`,
        },
      ],
      identity_types_supported: ["identity_assertion", "anonymous"],
      identity_assertion: {
        assertion_types_supported: [
          "urn:ietf:params:oauth:token-type:id-jag",
          "verified_email",
        ],
        credential_types_supported: ["access_token"],
        claim_uri: `${as}/authorize`,
      },
      anonymous: {
        credential_types_supported: ["access_token"],
        claim_uri: `${as}/authorize`,
      },
      events_supported: [
        "https://schemas.workos.com/events/agent/auth/identity/assertion/revoked",
      ],
    },
  };
}

export function protectedResourceMetadata(
  config: ResolvedAgentReadiness,
  resource = config.origin,
) {
  return {
    resource,
    resource_name: "OfflineCreator Studio MCP",
    authorization_servers: [config.authorizationServer],
    scopes_supported: ["models", "read", "generate"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${config.studioOrigin}/mcp-cli`,
  };
}

export function mcpServerCard(config: ResolvedAgentReadiness) {
  const endpoint = `${config.origin}/mcp`;
  return {
    serverInfo: {
      name: MCP_SERVER_INFO.name,
      version: config.version,
    },
    description: packageMetadata.description,
    url: endpoint,
    endpoint,
    transport: { type: "streamable-http" },
    transports: [{ type: "streamable-http", endpoint }],
    capabilities: {
      tools: true,
      resources: false,
      prompts: false,
    },
    authentication: {
      type: "oauth2",
      authorization_servers: [config.authorizationServer],
    },
  };
}

export function a2aAgentCard(config: ResolvedAgentReadiness) {
  const skills = Object.entries(TOOL_ANNOTATIONS).map(([id, meta]) => ({
    id,
    name: meta.title,
    description: `${meta.title} through OfflineCreator Studio.`,
    tags: ["offlinecreator", "generation"],
  }));
  return {
    name: "OfflineCreator Studio",
    description:
      "Create images and videos with OfflineCreator Studio through MCP and OAuth.",
    version: config.version,
    url: `${config.origin}/mcp`,
    documentationUrl: `${config.studioOrigin}/mcp-cli`,
    provider: {
      organization: "OfflineCreator Studio",
      url: config.studioOrigin,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    supportedInterfaces: [
      {
        url: `${config.origin}/mcp`,
        protocolBinding: "HTTP+JSON",
        transport: "HTTP+JSON",
        protocolVersion: "1.0",
      },
      {
        url: `${config.origin}/a2a`,
        protocolBinding: "JSONRPC",
        transport: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [
        {
          uri: AP2_URI,
          description:
            "Agent Payments Protocol merchant role for Studio credit checkout.",
          required: true,
          params: { roles: ["merchant"] },
        },
      ],
    },
    skills,
    securitySchemes: {
      oauth2: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: `${config.authorizationServer}/authorize`,
            tokenUrl: `${config.authorizationServer}/oauth/token`,
            scopes: {
              models: "List launch models",
              read: "Read credits and generations",
              generate: "Start and cancel generations",
            },
          },
        },
      },
    },
  };
}

export function apiCatalog(config: ResolvedAgentReadiness) {
  return {
    linkset: [
      {
        anchor: `${config.origin}/mcp`,
        "service-desc": [
          {
            href: `${config.origin}/openapi.json`,
            type: "application/json",
          },
          {
            href: `${config.origin}/.well-known/mcp/server-card.json`,
            type: "application/json",
          },
        ],
        "service-doc": [
          {
            href: `${config.studioOrigin}/mcp-cli`,
            type: "text/html",
          },
          {
            href: `${config.origin}/auth.md`,
            type: "text/markdown",
          },
        ],
        status: [{ href: `${config.origin}/health` }],
      },
      {
        anchor: `${config.origin}/x402/credits`,
        "service-desc": [
          {
            href: `${config.origin}/openapi.json`,
            type: "application/json",
          },
        ],
        "service-doc": [
          {
            href: `${config.origin}/.well-known/acp.json`,
            type: "application/json",
          },
        ],
      },
    ],
  };
}

export function openApiDocument(config: ResolvedAgentReadiness): JsonRecord {
  return {
    openapi: "3.1.0",
    info: {
      title: "OfflineCreator Studio MCP",
      version: config.version,
      description: packageMetadata.description,
    },
    servers: [{ url: config.origin }],
    "x-service-info": {
      categories: ["media", "generation", "credits"],
      name: "OfflineCreator Studio",
    },
    paths: {
      "/mcp": {
        post: {
          operationId: "mcp",
          summary: "Streamable HTTP MCP endpoint",
          responses: { "401": { description: "OAuth required" } },
        },
      },
      "/x402/credits": {
        post: {
          operationId: "purchaseCredits",
          summary: "Purchase Studio credits with an agent-native payment",
          "x-payment-info": {
            intent: "charge",
            method: "card",
            amount: 5,
            currency: "USD",
            description: "OfflineCreator Studio starter credit pack",
          },
          responses: {
            "402": { description: "Payment required" },
            "200": { description: "Credits granted" },
          },
        },
      },
    },
  };
}

export function acpDocument(config: ResolvedAgentReadiness) {
  return {
    protocol: { name: "acp", version: "2025-09-10" },
    api_base_url: `${config.origin}/acp`,
    transports: ["rest", "mcp"],
    capabilities: {
      services: ["checkout", "credits"],
    },
  };
}

export function ucpDocument(config: ResolvedAgentReadiness) {
  const restEndpoint = `${config.origin}/acp`;
  return {
    protocol_version: UCP_VERSION,
    services: {
      "dev.ucp.shopping": [
        {
          version: UCP_VERSION,
          spec: UCP_OVERVIEW,
          transport: "rest",
          endpoint: restEndpoint,
          schema: UCP_SHOPPING_OPENAPI,
        },
      ],
    },
    capabilities: {
      "dev.ucp.shopping.checkout": [
        {
          version: UCP_VERSION,
          spec: UCP_CHECKOUT_SPEC,
          schema: UCP_CHECKOUT_SCHEMA,
        },
      ],
    },
    endpoints: {
      checkout: restEndpoint,
      mcp: `${config.origin}/mcp`,
    },
    ucp: {
      version: UCP_VERSION,
      services: {
        "dev.ucp.shopping": [
          {
            version: UCP_VERSION,
            spec: UCP_OVERVIEW,
            transport: "rest",
            endpoint: restEndpoint,
            schema: UCP_SHOPPING_OPENAPI,
          },
          {
            version: UCP_VERSION,
            spec: UCP_OVERVIEW,
            transport: "mcp",
            endpoint: `${config.origin}/mcp`,
          },
          {
            version: UCP_VERSION,
            spec: UCP_OVERVIEW,
            transport: "a2a",
            endpoint: `${config.origin}/.well-known/agent-card.json`,
          },
        ],
      },
      capabilities: {
        "dev.ucp.shopping.checkout": [
          {
            version: UCP_VERSION,
            spec: UCP_CHECKOUT_SPEC,
            schema: UCP_CHECKOUT_SCHEMA,
          },
        ],
      },
    },
  };
}

export function x402PaymentRequired(config: ResolvedAgentReadiness) {
  return {
    x402Version: 1,
    error: "Payment required to continue",
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "5000000",
        resource: `${config.origin}/x402/credits`,
        description: "OfflineCreator Studio credit pack",
        mimeType: "application/json",
        payTo: config.x402PayTo,
        maxTimeoutSeconds: 60,
        asset: USDC_BASE,
      },
    ],
  };
}

export function jwksDocument(config: ResolvedAgentReadiness) {
  const key = { ...config.webBotAuthPublicJwk };
  delete key.d;
  delete key.key_ops;
  delete key.ext;
  return { keys: [key] };
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function agentSkillsIndex(config: ResolvedAgentReadiness) {
  return {
    $schema: SKILLS_SCHEMA,
    skills: [
      {
        name: "offlinecreator-studio",
        type: "skill-md",
        description:
          "Connect to OfflineCreator Studio MCP for image and video generation.",
        url: `${config.origin}/.well-known/agent-skills/offlinecreator-studio/SKILL.md`,
        digest: `sha256:${await sha256Hex(STUDIO_SKILL_MARKDOWN)}`,
      },
    ],
  };
}

export function llmsTxt(config: ResolvedAgentReadiness) {
  return `# OfflineCreator Studio

> Image and video generation through MCP and OAuth.

- [MCP](${config.origin}/mcp)
- [Auth](${config.origin}/auth.md)
- [Docs](${config.studioOrigin}/mcp-cli)
- [Server card](${config.origin}/.well-known/mcp/server-card.json)
`;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signatureParams(input: {
  covered: string[];
  created: number;
  keyid: string;
  tag: string;
}) {
  return `(${input.covered.join(" ")});created=${input.created};keyid="${input.keyid}";alg="ed25519";tag="${input.tag}"`;
}

export async function signWebBotAuthHeaders(input: {
  request: Request;
  origin: string;
  privateJwk: AgentReadinessJwk;
  publicJwk?: AgentReadinessJwk;
  nowSeconds?: number;
  tag?: string;
}) {
  const created = Math.floor(input.nowSeconds ?? Date.now() / 1000);
  const url = new URL(input.request.url);
  const keyid =
    input.publicJwk?.kid ??
    (typeof input.privateJwk.kid === "string"
      ? input.privateJwk.kid
      : DEFAULT_WEB_BOT_AUTH_PUBLIC_JWK.kid);
  const covered = ['"@method"', '"@authority"', '"@path"'];
  const params = signatureParams({
    covered,
    created,
    keyid,
    tag: input.tag ?? "web-bot-auth",
  });
  const base = [
    `"@method": ${input.request.method.toUpperCase()}`,
    `"@authority": ${url.host}`,
    `"@path": ${url.pathname}`,
    `"@signature-params": ${params}`,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "jwk",
    input.privateJwk as never,
    "Ed25519",
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key,
    new TextEncoder().encode(base),
  );
  return {
    Signature: `sig1=:${base64Url(new Uint8Array(signature))}:`,
    "Signature-Input": `sig1=${params}`,
    "Signature-Agent": `"${trimOrigin(input.origin)}"`,
  };
}

async function maybeSignDirectory(
  request: Request,
  response: Response,
  config: ResolvedAgentReadiness,
) {
  if (!config.webBotAuthPrivateJwk) return response;
  const signed = await signWebBotAuthHeaders({
    request,
    origin: config.origin,
    privateJwk: config.webBotAuthPrivateJwk,
    publicJwk: config.webBotAuthPublicJwk,
    tag: "http-message-signatures-directory",
  });
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(signed)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

function normalizePath(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith("/"))
    return pathname.slice(0, -1);
  return pathname;
}

function isDiscoveryPath(path: string) {
  return (
    path === "/" ||
    path === "/webmcp.js" ||
    path === "/robots.txt" ||
    path === "/sitemap.xml" ||
    path === "/auth.md" ||
    path === "/llms.txt" ||
    path === "/health" ||
    path === "/openapi.json" ||
    path === "/acp" ||
    path === "/a2a" ||
    path === "/x402/credits" ||
    path.startsWith("/.well-known/")
  );
}

export async function handleAgentReadinessRequest(
  request: Request,
  options: AgentReadinessOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
  const config = resolveAgentReadiness(request, options);

  if (request.method === "OPTIONS" && isDiscoveryPath(path)) {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
        "access-control-allow-headers": "Accept, Content-Type, Authorization",
      },
    });
  }

  if (request.method === "HEAD" && isDiscoveryPath(path)) {
    const full = await handleAgentReadinessRequest(
      new Request(request.url, { method: "GET", headers: request.headers }),
      options,
    );
    if (!full) return null;
    return new Response(null, { status: full.status, headers: full.headers });
  }

  if (
    request.method === "POST" &&
    path !== "/x402/credits" &&
    path !== "/a2a"
  ) {
    return null;
  }
  if (request.method !== "GET" && request.method !== "POST") return null;

  switch (path) {
    case "/": {
      if (prefersMarkdown(request)) {
        const markdown = homepageMarkdown(config);
        return textResponse(markdown, "text/markdown", {
          ...homepageHeaders(config.origin),
          "x-markdown-tokens": String(tokenCount(markdown)),
        });
      }
      return textResponse(
        homepageHtml(config),
        "text/html",
        homepageHeaders(config.origin),
      );
    }
    case "/webmcp.js":
      return textResponse(webMcpScript(config.origin), "text/javascript");
    case "/robots.txt":
      return textResponse(robotsTxt(config), "text/plain");
    case "/sitemap.xml":
      return textResponse(sitemapXml(config), "application/xml");
    case "/auth.md":
      return textResponse(authMarkdown(config), "text/markdown");
    case "/llms.txt":
      return textResponse(llmsTxt(config), "text/plain");
    case "/health":
      return jsonResponse({ status: "ok", version: config.version });
    case "/openapi.json":
      return jsonResponse(openApiDocument(config));
    case "/.well-known/openid-configuration":
    case "/.well-known/oauth-authorization-server":
      return jsonResponse(authorizationServerMetadata(config));
    case "/.well-known/oauth-protected-resource":
      return jsonResponse(protectedResourceMetadata(config, config.origin));
    case "/.well-known/oauth-protected-resource/mcp":
      return jsonResponse(
        protectedResourceMetadata(config, `${config.origin}/mcp`),
      );
    case "/.well-known/jwks.json":
      return jsonResponse(jwksDocument(config));
    case "/.well-known/http-message-signatures-directory": {
      const directory = jsonResponse(
        jwksDocument(config),
        "application/http-message-signatures-directory+json",
      );
      return maybeSignDirectory(request, directory, config);
    }
    case "/.well-known/mcp/server-card.json":
    case "/.well-known/mcp.json":
      return jsonResponse(mcpServerCard(config));
    case "/.well-known/agent-card.json":
      return jsonResponse(a2aAgentCard(config));
    case "/.well-known/agent-skills/index.json":
      return jsonResponse(await agentSkillsIndex(config));
    case "/.well-known/agent-skills/offlinecreator-studio/SKILL.md":
      return textResponse(STUDIO_SKILL_MARKDOWN, "text/markdown");
    case "/.well-known/api-catalog":
      return jsonResponse(apiCatalog(config), "application/linkset+json");
    case "/.well-known/acp.json":
      return jsonResponse(acpDocument(config));
    case "/.well-known/ucp":
      return jsonResponse(ucpDocument(config));
    case "/acp":
      return jsonResponse({
        protocol: { name: "acp", version: "2025-09-10" },
        checkout: `${config.origin}/x402/credits`,
      });
    case "/a2a":
      return jsonResponse(a2aAgentCard(config));
    case "/x402/credits":
      return new Response(
        JSON.stringify(x402PaymentRequired(config), null, 2),
        {
          status: 402,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
            "payment-required": "x402",
          },
        },
      );
    default:
      return null;
  }
}
