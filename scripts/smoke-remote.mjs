import assert from "node:assert/strict";

const origin = "https://mcp.offlinecreatorstudio.com";
const resource = `${origin}/mcp`;
const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
const authorizationMetadataUrl = `${origin}/.well-known/oauth-authorization-server`;

const request = (url) =>
  fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { "user-agent": "offlinecreator-mcp-release-smoke/0.1.2" },
  });

const protectedResponse = await request(resource);
assert.equal(
  protectedResponse.status,
  401,
  "Unauthenticated MCP endpoint must reject access.",
);
const challenge = protectedResponse.headers.get("www-authenticate") ?? "";
assert.match(challenge, /^Bearer\b/i);
assert.ok(
  challenge.includes(`resource_metadata="${resourceMetadataUrl}"`),
  "Bearer challenge must advertise protected-resource metadata.",
);

const resourceResponse = await request(resourceMetadataUrl);
assert.equal(resourceResponse.status, 200);
assert.match(resourceResponse.headers.get("content-type") ?? "", /json/i);
const resourceMetadata = await resourceResponse.json();
assert.equal(resourceMetadata.resource, resource);
assert.deepEqual(resourceMetadata.authorization_servers, [origin]);
assert.ok(resourceMetadata.scopes_supported?.includes("models"));

const authorizationResponse = await request(authorizationMetadataUrl);
assert.equal(authorizationResponse.status, 200);
assert.match(authorizationResponse.headers.get("content-type") ?? "", /json/i);
const authorizationMetadata = await authorizationResponse.json();
assert.equal(authorizationMetadata.issuer, origin);
assert.equal(
  authorizationMetadata.authorization_endpoint,
  `${origin}/authorize`,
);
assert.equal(authorizationMetadata.token_endpoint, `${origin}/oauth/token`);
assert.ok(
  authorizationMetadata.code_challenge_methods_supported?.includes("S256"),
  "Authorization server must advertise PKCE S256.",
);

console.log("Remote unauthenticated health and OAuth discovery smoke passed.");
