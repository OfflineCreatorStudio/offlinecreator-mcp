/**
 * Test fixture, not a test suite: the Studio-side OAuth bridge verifier
 * exactly as commit 1f596af shipped it (`git show 1f596af:packages/mcp/src/
 * oauth-bridge.ts`, lines 1-95 and 139-195, unchanged). Studio deployments
 * from before bridge nonces run this code, so every header set the current
 * signer emits must still verify here, whichever of Studio and the OAuth
 * Worker deploys first.
 *
 * Named *.test.ts so it stays out of the published package; it defines no
 * tests. Do not edit the copied code: it must keep matching what is deployed.
 */
const OAUTH_USER_HEADER = "x-oc-oauth-user";
const OAUTH_SCOPES_HEADER = "x-oc-oauth-scopes";
const OAUTH_TIMESTAMP_HEADER = "x-oc-oauth-timestamp";
const OAUTH_SIGNATURE_HEADER = "x-oc-oauth-signature";
const OAUTH_CREDENTIAL_HEADER = "x-oc-oauth-credential";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_SCOPES = new Set(["models", "read", "generate"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type OAuthBridgeIdentity = {
  userId: string;
  scopes: string[];
  /** Durable OAuth client id used for per-credential spend attribution. */
  credentialId?: string;
};

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string) {
  try {
    const padded =
      value.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importHmacKey(secret: string) {
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("MCP_OAUTH_SERVICE_SECRET must contain at least 32 bytes.");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function bodyDigest(request: Request) {
  const bytes = await request.clone().arrayBuffer();
  return base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
}

function normalizeScopes(scopes: string[]) {
  return [...new Set(scopes)]
    .filter((scope) => ALLOWED_SCOPES.has(scope))
    .sort();
}

function normalizeCredentialId(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed.length > 512 || CONTROL_CHARS.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

async function canonicalRequest(
  request: Request,
  identity: OAuthBridgeIdentity,
  timestamp: string,
  includeCredential: boolean,
) {
  const url = new URL(request.url);
  const lines = [
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    identity.userId,
    normalizeScopes(identity.scopes).join(" "),
    timestamp,
    await bodyDigest(request),
  ];
  if (includeCredential) {
    lines.splice(4, 0, identity.credentialId ?? "");
  }
  return lines.join("\n");
}

export async function verifyOAuthBridgeRequest(input: {
  request: Request;
  secret: string;
  nowSeconds?: number;
  maxClockSkewSeconds?: number;
}): Promise<OAuthBridgeIdentity | null> {
  const userId = input.request.headers.get(OAUTH_USER_HEADER)?.trim() ?? "";
  const scopeValue =
    input.request.headers.get(OAUTH_SCOPES_HEADER)?.trim() ?? "";
  const timestamp =
    input.request.headers.get(OAUTH_TIMESTAMP_HEADER)?.trim() ?? "";
  const signatureValue =
    input.request.headers.get(OAUTH_SIGNATURE_HEADER)?.trim() ?? "";
  const credentialId = normalizeCredentialId(
    input.request.headers.get(OAUTH_CREDENTIAL_HEADER) ?? undefined,
  );
  if (!UUID_RE.test(userId) || !timestamp || !signatureValue) return null;

  const issuedAt = Number(timestamp);
  const now = Math.floor(input.nowSeconds ?? Date.now() / 1000);
  const skew = input.maxClockSkewSeconds ?? 60;
  if (!Number.isInteger(issuedAt) || Math.abs(now - issuedAt) > skew) {
    return null;
  }

  const requestedScopes = scopeValue ? scopeValue.split(/\s+/) : [];
  const scopes = normalizeScopes(requestedScopes);
  if (
    scopes.length !== requestedScopes.length ||
    scopes.join(" ") !== requestedScopes.join(" ")
  ) {
    return null;
  }

  const signature = fromBase64Url(signatureValue);
  if (!signature) return null;
  const key = await importHmacKey(input.secret);
  const identity = credentialId
    ? { userId, scopes, credentialId }
    : { userId, scopes };
  const canonical = await canonicalRequest(
    input.request,
    identity,
    timestamp,
    Boolean(credentialId),
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(canonical),
  );
  return valid ? identity : null;
}
