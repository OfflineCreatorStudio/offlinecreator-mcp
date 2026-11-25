import packageMetadata from "../package.json" with { type: "json" };
import {
  MCP_SERVER_INFO,
  PUBLISHED_MCP_RELEASE,
  TOOL_ANNOTATIONS,
} from "./server.js";

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
  oidcPublicJwks?: AgentReadinessJwk[];
};

export type ResolvedAgentReadiness = {
  origin: string;
  authorizationServer: string;
  studioOrigin: string;
  version: string;
  x402PayTo: string;
  webBotAuthPublicJwk: AgentReadinessJwk;
  webBotAuthPrivateJwk?: AgentReadinessJwk;
  oidcPublicJwks: AgentReadinessJwk[];
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
    // The cards describe the hosted remote server: the published release.
    version: options.version ?? PUBLISHED_MCP_RELEASE.version,
    x402PayTo: options.x402PayTo ?? DEFAULT_X402_PAY_TO,
    webBotAuthPublicJwk:
      options.webBotAuthPublicJwk ?? DEFAULT_WEB_BOT_AUTH_PUBLIC_JWK,
    webBotAuthPrivateJwk: options.webBotAuthPrivateJwk,
    oidcPublicJwks: options.oidcPublicJwks ?? [],
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
    `<${base}${AI_CATALOG_PATH}>; rel="ai-catalog"; type="${AI_CATALOG_MEDIA_TYPE}"`,
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
  <link rel="ai-catalog" type="${AI_CATALOG_MEDIA_TYPE}" href="${config.origin}${AI_CATALOG_PATH}">
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
Agentmap: ${config.origin}${AI_CATALOG_PATH}
`;
}

export const AI_CATALOG_PATH = "/.well-known/ai-catalog.json";
export const AI_CATALOG_MEDIA_TYPE = "application/ai-catalog+json";
export const MCP_SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";
export const A2A_AGENT_CARD_MEDIA_TYPE = "application/a2a-agent-card+json";

/**
 * Agentic Resource Discovery (ARD) AI Catalog.
 *
 * The base ai-catalog spec names the media-type field `mediaType`; the ARD
 * layer names it `type`. Both are emitted with the same value so the document
 * validates under either, and both specs require consumers to preserve unknown
 * keys.
 *
 * Published unsigned on purpose. A `trustManifest.signature` whose verifying
 * JWK Set lives on this same origin is circular: anyone able to rewrite the
 * catalog can rewrite the key that vouches for it. TLS already proves the bytes
 * came from this domain.
 *
 * Only capabilities that actually resolve are listed.
 */
export function aiCatalog(config: ResolvedAgentReadiness) {
  const host = new URL(config.origin).host;
  const entry = (input: {
    kind: string;
    name: string;
    displayName: string;
    mediaType: string;
    path: string;
    description: string;
    capabilities?: string[];
    representativeQueries?: string[];
  }) => ({
    identifier: `urn:ai:${host}:${input.kind}:${input.name}`,
    displayName: input.displayName,
    mediaType: input.mediaType,
    type: input.mediaType,
    url: `${config.origin}${input.path}`,
    description: input.description,
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    ...(input.representativeQueries
      ? { representativeQueries: input.representativeQueries }
      : {}),
  });

  return {
    specVersion: "1.0",
    host: {
      displayName: "OfflineCreator Studio",
      // Bare domain, matching the publisher segment of every entry URN.
      identifier: host,
      documentationUrl: `${config.studioOrigin}/mcp-cli`,
    },
    entries: [
      entry({
        kind: "mcp",
        name: "offlinecreator-studio",
        displayName: "OfflineCreator Studio MCP server",
        mediaType: MCP_SERVER_CARD_MEDIA_TYPE,
        path: "/.well-known/mcp/server-card.json",
        description:
          "Streamable HTTP MCP server for image, video, and 3D generation with OAuth 2.1 and PKCE.",
        capabilities: ["image-generation", "video-generation", "model-catalog"],
        representativeQueries: [
          "Generate a product photograph with an AI image model",
          "Which AI video models are available and what do they cost?",
        ],
      }),
      entry({
        kind: "agent",
        name: "offlinecreator-studio",
        displayName: "OfflineCreator Studio A2A agent",
        mediaType: A2A_AGENT_CARD_MEDIA_TYPE,
        path: "/.well-known/agent-card.json",
        description:
          "A2A JSON-RPC agent that lists generation models and creates durable image or video generation tasks.",
        capabilities: ["image-generation", "video-generation", "task-tracking"],
        representativeQueries: [
          "Create a 16:9 image generation task and track it to completion",
          "List the generation models this agent can run",
        ],
      }),
      entry({
        kind: "skill",
        name: "offlinecreator-studio",
        displayName: "OfflineCreator Studio Agent Skill",
        // Served as markdown, not application/agentskill+zip: declare what
        // actually resolves at this URL.
        mediaType: "text/markdown",
        path: "/.well-known/agent-skills/offlinecreator-studio/SKILL.md",
        description:
          "Agent Skill describing how to connect an agent to OfflineCreator Studio generation over MCP and OAuth.",
        representativeQueries: [
          "How do I connect my agent to OfflineCreator Studio?",
          "What scopes does OfflineCreator Studio generation need?",
        ],
      }),
    ],
  };
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
    AI_CATALOG_PATH,
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

export const AUTH_MD_DISCOVERY_PATHS = [
  "/auth.md",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
] as const;

export const PUBLIC_DISCOVERY_PATHS = [
  ...AUTH_MD_DISCOVERY_PATHS,
  "/",
  "/webmcp.js",
  "/robots.txt",
  "/sitemap.xml",
  "/llms.txt",
  "/openapi.json",
  "/.well-known/openid-configuration",
  "/.well-known/jwks.json",
  "/.well-known/http-message-signatures-directory",
  "/.well-known/mcp/server-card.json",
  "/.well-known/mcp.json",
  "/.well-known/agent-card.json",
  "/.well-known/agent-skills/index.json",
  "/.well-known/agent-skills/offlinecreator-studio/SKILL.md",
  "/.well-known/api-catalog",
  "/.well-known/ai-catalog.json",
  "/.well-known/acp.json",
  "/.well-known/ucp",
] as const;

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
\`agent_auth\`, including \`skill\`, \`register_uri\`, and the implemented
dynamic client registration and Authorization Code + PKCE methods.
`;
}

function oauthCoreMetadata(config: ResolvedAgentReadiness) {
  const as = config.authorizationServer;
  return {
    issuer: as,
    authorization_endpoint: `${as}/authorize`,
    token_endpoint: `${as}/oauth/token`,
    registration_endpoint: `${as}/oauth/register`,
    jwks_uri: `${as}/.well-known/jwks.json`,
    scopes_supported: [
      "openid",
      "profile",
      "email",
      "models",
      "read",
      "generate",
    ],
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
  };
}

function agentAuthMetadata(config: ResolvedAgentReadiness) {
  const as = config.authorizationServer;
  return {
    skill: `${config.origin}/auth.md`,
    register_uri: `${as}/oauth/register`,
    registration_endpoint: `${as}/oauth/register`,
    methods: [
      {
        type: "oauth_dynamic_client_registration",
        register_uri: `${as}/oauth/register`,
      },
      {
        type: "authorization_code_pkce",
        authorization_endpoint: `${as}/authorize`,
        token_endpoint: `${as}/oauth/token`,
        code_challenge_methods_supported: ["S256"],
      },
    ],
    /*
     * No identity_types_supported, identity_assertion, or anonymous block.
     * The scanner appears to detect Auth.md flows by those shapes, so omitting
     * them costs the authMd check — but this server implements neither ID-JAG
     * token exchange nor anonymous credentials, and an agent that saw them
     * advertised would attempt a flow that does not exist.
     */
  };
}

export function authorizationServerMetadata(config: ResolvedAgentReadiness) {
  return {
    ...oauthCoreMetadata(config),
    agent_auth: agentAuthMetadata(config),
  };
}

export function openIdProviderMetadata(config: ResolvedAgentReadiness) {
  const as = config.authorizationServer;
  return {
    ...oauthCoreMetadata(config),
    userinfo_endpoint: `${as}/userinfo`,
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_signing_alg_values_supported: ["RS256"],
    claims_supported: [
      "iss",
      "sub",
      "aud",
      "exp",
      "iat",
      "nonce",
      "email",
      "email_verified",
      "name",
    ],
    claim_types_supported: ["normal"],
    agent_auth: agentAuthMetadata(config),
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
  const endpoint = `${config.origin}/mcp/a2a`;
  return {
    name: "OfflineCreator Studio",
    description:
      "Lists OfflineCreator Studio models and creates durable image or video generation tasks.",
    version: config.version,
    documentationUrl: `${config.studioOrigin}/mcp-cli`,
    provider: {
      organization: "OfflineCreator Studio",
      url: config.studioOrigin,
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    supportedInterfaces: [
      {
        url: endpoint,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    skills: [
      {
        id: "offlinecreator.list-models.v1",
        name: "List generation models",
        description:
          "Returns launch models, supported workflows, options, input requirements, and published credit costs.",
        tags: ["models", "image-generation", "video-generation"],
        examples: ['{"operation":"list_models"}'],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        securityRequirements: [
          { schemes: { studioOAuth: { list: ["models"] } } },
        ],
      },
      {
        id: "offlinecreator.generate-media.v1",
        name: "Generate media",
        description:
          "Creates and tracks text-initiated image or video generations. File-upload model inputs are not accepted in this A2A release.",
        tags: ["image-generation", "video-generation", "generative-media"],
        examples: [
          '{"operation":"generate","modelId":"flux-schnell","prompt":"A product photograph","aspectRatio":"16:9"}',
        ],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        securityRequirements: [
          {
            schemes: {
              studioOAuth: { list: ["models", "read", "generate"] },
            },
          },
        ],
      },
    ],
    securitySchemes: {
      studioOAuth: {
        oauth2SecurityScheme: {
          description:
            "OfflineCreator Studio OAuth with Authorization Code and PKCE.",
          oauth2MetadataUrl: `${config.authorizationServer}/.well-known/oauth-authorization-server`,
          flows: {
            authorizationCode: {
              authorizationUrl: `${config.authorizationServer}/authorize`,
              tokenUrl: `${config.authorizationServer}/oauth/token`,
              scopes: {
                models: "List available generation models",
                read: "Read generation task status and outputs",
                generate: "Create and cancel generation tasks",
              },
              pkceRequired: true,
            },
          },
        },
      },
    },
    securityRequirements: [{ schemes: { studioOAuth: { list: [] } } }],
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
        anchor: `${config.studioOrigin}/api/v1/generations`,
        "service-desc": [
          {
            href: `${config.origin}/openapi.json`,
            type: "application/json",
          },
        ],
        "service-doc": [
          {
            href: `${config.studioOrigin}/.well-known/acp.json`,
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
    servers: [{ url: config.studioOrigin }],
    "x-service-info": {
      categories: ["media", "generation", "compute"],
      name: "OfflineCreator Studio",
    },
    paths: {
      "/api/v1/generations": {
        post: {
          operationId: "startGeneration",
          summary: "Start a priced generation on Studio",
          "x-payment-info": {
            intent: "charge",
            method: "stripe",
            amount: null,
            currency: "usd",
            description:
              "Dynamic per-model generation price. Runtime 402 is authoritative.",
          },
          responses: {
            "402": { description: "Payment required" },
            "200": { description: "Generation reserved or queued" },
          },
        },
      },
      "/mcp": {
        post: {
          operationId: "mcp",
          summary: "Streamable HTTP MCP endpoint",
          responses: { "401": { description: "OAuth required" } },
        },
      },
    },
  };
}

/**
 * Agentic Resource Discovery capability manifest.
 * https://agenticresourcediscovery.org/ — entries reference the cards this
 * origin already serves. `host.identifier` is omitted because a did:web claim
 * would need a DID document that is not published here.
 */
export function aiCatalogDocument(config: ResolvedAgentReadiness) {
  const publisher = config.origin.replace(/^https?:\/\//, "").split("/")[0];
  return {
    specVersion: "1.0",
    host: { displayName: "OfflineCreator Studio" },
    entries: [
      {
        identifier: `urn:air:${publisher}:mcp:studio`,
        displayName: "OfflineCreator Studio MCP",
        // ARD names this `type`; the base ai-catalog spec names it `mediaType`.
        type: "application/mcp-server-card+json",
        mediaType: "application/mcp-server-card+json",
        url: `${config.origin}/.well-known/mcp/server-card.json`,
        description:
          "Streamable HTTP MCP server for image and video generation, model listing, quoting, and credit balance.",
        capabilities: ["list_models", "generate", "get_credits"],
        representativeQueries: [
          "generate a product photo for my store listing",
          "make a five second video from this image",
          "what does an image generation cost in credits",
        ],
        tags: ["mcp", "image-generation", "video-generation"],
      },
      {
        identifier: `urn:air:${publisher}:a2a:studio`,
        displayName: "OfflineCreator Studio Agent",
        type: "application/a2a-agent-card+json",
        mediaType: "application/a2a-agent-card+json",
        url: `${config.origin}/.well-known/agent-card.json`,
        description:
          "A2A agent card for creative generation outcomes, including accepted payment rails.",
        representativeQueries: [
          "create marketing images for a product launch",
          "quote a creative job before running it",
        ],
        tags: ["a2a", "creative", "commerce"],
      },
      {
        identifier: `urn:air:${publisher}:skill:offlinecreator-studio`,
        displayName: "offlinecreator-studio",
        type: "application/ai-skill+md",
        mediaType: "application/ai-skill+md",
        url: `${config.origin}/.well-known/agent-skills/offlinecreator-studio/SKILL.md`,
        description:
          "Skill describing how to connect an agent to OfflineCreator Studio and run generations.",
        representativeQueries: [
          "connect my agent to OfflineCreator Studio",
          "how do I authenticate against the Studio MCP server",
        ],
        tags: ["skill", "onboarding"],
      },
    ],
  };
}

export function acpDocument(config: ResolvedAgentReadiness) {
  return {
    protocol: {
      name: "acp",
      version: "2026-04-17",
      supported_versions: ["2026-04-17"],
    },
    api_base_url: `${config.studioOrigin}/api/acp`,
    transports: ["rest"],
    capabilities: {
      services: ["checkout", "orders", "carts"],
    },
  };
}

export function ucpDocument(config: ResolvedAgentReadiness) {
  const restEndpoint = `${config.studioOrigin}/api/ucp`;
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
      checkout: `${restEndpoint}/checkout`,
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
            endpoint: `${config.studioOrigin}/.well-known/agent-card.json`,
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

function publicJwk(key: AgentReadinessJwk) {
  const published = { ...key };
  delete published.d;
  delete published.key_ops;
  delete published.ext;
  return published;
}

export function jwksDocument(config: ResolvedAgentReadiness) {
  return { keys: config.oidcPublicJwks.map(publicJwk) };
}

export function webBotAuthDirectory(config: ResolvedAgentReadiness) {
  return { keys: [publicJwk(config.webBotAuthPublicJwk)] };
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
  expires: number;
  keyid: string;
  tag: string;
  nonce?: string;
}) {
  const nonce = input.nonce ? `;nonce="${input.nonce}"` : "";
  return `(${input.covered.join(" ")});created=${input.created};expires=${input.expires};keyid="${input.keyid}";alg="ed25519"${nonce};tag="${input.tag}"`;
}

export async function contentDigestHeader(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha-256=:${base64Url(new Uint8Array(digest))}:`;
}

export async function jwkThumbprint(jwk: AgentReadinessJwk) {
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return base64Url(new Uint8Array(digest));
}

export async function signWebBotAuthHeaders(input: {
  request: Request;
  origin: string;
  privateJwk: AgentReadinessJwk;
  publicJwk?: AgentReadinessJwk;
  nowSeconds?: number;
  tag?: string;
  contentDigest?: string;
}) {
  const created = Math.floor(input.nowSeconds ?? Date.now() / 1000);
  const expires = created + 60;
  const url = new URL(input.request.url);
  const keyid =
    input.publicJwk?.kid ??
    (typeof input.privateJwk.kid === "string"
      ? input.privateJwk.kid
      : DEFAULT_WEB_BOT_AUTH_PUBLIC_JWK.kid);
  const origin = trimOrigin(input.origin);
  const covered = ['"@method"', '"@authority"', '"@path"', '"signature-agent"'];
  if (input.contentDigest) covered.push('"content-digest"');
  const params = signatureParams({
    covered,
    created,
    expires,
    keyid,
    tag: input.tag ?? "web-bot-auth",
  });
  const base = [
    `"@method": ${input.request.method.toUpperCase()}`,
    `"@authority": ${url.host}`,
    `"@path": ${url.pathname}`,
    `"signature-agent": "${origin}"`,
    ...(input.contentDigest
      ? [`"content-digest": ${input.contentDigest}`]
      : []),
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
    ...(input.contentDigest ? { "Content-Digest": input.contentDigest } : {}),
  };
}

export async function signWebBotAuthRequest(input: {
  request: Request;
  origin: string;
  privateJwk: AgentReadinessJwk;
  publicJwk?: AgentReadinessJwk;
  nowSeconds?: number;
}) {
  const headers = new Headers(input.request.headers);
  const method = input.request.method.toUpperCase();
  let contentDigest: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const body = new Uint8Array(await input.request.clone().arrayBuffer());
    if (body.byteLength > 0) {
      contentDigest = await contentDigestHeader(body);
      headers.set("Content-Digest", contentDigest);
    }
  }
  const signed = await signWebBotAuthHeaders({
    ...input,
    contentDigest,
  });
  for (const [name, value] of Object.entries(signed)) headers.set(name, value);
  return new Request(input.request, { headers });
}

async function maybeSignDirectory(
  request: Request,
  response: Response,
  config: ResolvedAgentReadiness,
) {
  if (!config.webBotAuthPrivateJwk) return response;
  try {
    const body = new Uint8Array(await response.clone().arrayBuffer());
    const digest = await contentDigestHeader(body);
    const signed = await signWebBotAuthHeaders({
      request,
      origin: config.origin,
      privateJwk: config.webBotAuthPrivateJwk,
      publicJwk: config.webBotAuthPublicJwk,
      tag: "http-message-signatures-directory",
      contentDigest: digest,
    });
    const headers = new Headers(response.headers);
    headers.set("Content-Digest", digest);
    for (const [name, value] of Object.entries(signed))
      headers.set(name, value);
    return new Response(body, { status: response.status, headers });
  } catch {
    return response;
  }
}

function normalizePath(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith("/"))
    return pathname.slice(0, -1);
  return pathname;
}

export function isAuthMdDiscoveryPath(pathname: string) {
  return AUTH_MD_DISCOVERY_PATHS.includes(
    normalizePath(pathname) as (typeof AUTH_MD_DISCOVERY_PATHS)[number],
  );
}

export function isPublicDiscoveryPath(pathname: string) {
  const path = normalizePath(pathname);
  return PUBLIC_DISCOVERY_PATHS.includes(
    path as (typeof PUBLIC_DISCOVERY_PATHS)[number],
  );
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

  if (request.method === "POST" && path !== "/x402/credits") {
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
      return jsonResponse(openIdProviderMetadata(config));
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
        webBotAuthDirectory(config),
        "application/http-message-signatures-directory+json",
      );
      return maybeSignDirectory(request, directory, config);
    }
    // ARD entries declare these media types; the +json structured suffix keeps
    // ordinary JSON consumers working.
    case "/.well-known/mcp/server-card.json":
    case "/.well-known/mcp.json":
      return jsonResponse(mcpServerCard(config), MCP_SERVER_CARD_MEDIA_TYPE);
    case "/.well-known/agent-card.json":
      return jsonResponse(a2aAgentCard(config), A2A_AGENT_CARD_MEDIA_TYPE);
    case "/.well-known/agent-skills/index.json":
      return jsonResponse(await agentSkillsIndex(config));
    case "/.well-known/agent-skills/offlinecreator-studio/SKILL.md":
      return textResponse(STUDIO_SKILL_MARKDOWN, "text/markdown");
    case "/.well-known/api-catalog":
      return jsonResponse(apiCatalog(config), "application/linkset+json");
    case AI_CATALOG_PATH:
      return jsonResponse(aiCatalog(config), AI_CATALOG_MEDIA_TYPE);
    case "/.well-known/ai-catalog.json":
      return jsonResponse(aiCatalogDocument(config));
    case "/.well-known/acp.json":
      return jsonResponse(acpDocument(config));
    case "/.well-known/ucp":
      return jsonResponse(ucpDocument(config));
    case "/acp":
      return jsonResponse({
        protocol: { name: "acp", version: "2025-09-10" },
        checkout: `${config.origin}/x402/credits`,
      });
    case "/x402/credits":
      return new Response(
        JSON.stringify(
          {
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
          },
          null,
          2,
        ),
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
