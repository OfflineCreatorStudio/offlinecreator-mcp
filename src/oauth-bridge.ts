const OAUTH_USER_HEADER = "x-oc-oauth-user";
const OAUTH_SCOPES_HEADER = "x-oc-oauth-scopes";
const OAUTH_TIMESTAMP_HEADER = "x-oc-oauth-timestamp";
const OAUTH_SIGNATURE_HEADER = "x-oc-oauth-signature";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_SCOPES = new Set(["models", "read", "generate"]);

export type OAuthBridgeIdentity = {
  userId: string;
  scopes: string[];
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
    const padded = value.replace(/-/g, "+").replace(/_/g, "/")
      + "=".repeat((4 - (value.length % 4)) % 4);
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

async function canonicalRequest(
  request: Request,
  identity: OAuthBridgeIdentity,
  timestamp: string,
) {
  const url = new URL(request.url);
  return [
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    identity.userId,
    normalizeScopes(identity.scopes).join(" "),
    timestamp,
    await bodyDigest(request),
  ].join("\n");
}

export async function signOAuthBridgeRequest(input: {
  request: Request;
  secret: string;
  identity: OAuthBridgeIdentity;
  nowSeconds?: number;
}) {
  if (!UUID_RE.test(input.identity.userId)) {
    throw new Error("OAuth bridge userId must be a UUID.");
  }
  const identity = {
    userId: input.identity.userId,
    scopes: normalizeScopes(input.identity.scopes),
  };
  const timestamp = String(
    Math.floor(input.nowSeconds ?? Date.now() / 1000),
  );
  const key = await importHmacKey(input.secret);
  const canonical = await canonicalRequest(input.request, identity, timestamp);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonical),
  );

  return {
    [OAUTH_USER_HEADER]: identity.userId,
    [OAUTH_SCOPES_HEADER]: identity.scopes.join(" "),
    [OAUTH_TIMESTAMP_HEADER]: timestamp,
    [OAUTH_SIGNATURE_HEADER]: base64Url(new Uint8Array(signature)),
  };
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
  if (!UUID_RE.test(userId) || !timestamp || !signatureValue) return null;

  const issuedAt = Number(timestamp);
  const now = Math.floor(input.nowSeconds ?? Date.now() / 1000);
  const skew = input.maxClockSkewSeconds ?? 60;
  if (
    !Number.isInteger(issuedAt)
    || Math.abs(now - issuedAt) > skew
  ) {
    return null;
  }

  const requestedScopes = scopeValue ? scopeValue.split(/\s+/) : [];
  const scopes = normalizeScopes(requestedScopes);
  if (
    scopes.length !== requestedScopes.length
    || scopes.join(" ") !== requestedScopes.join(" ")
  ) {
    return null;
  }

  const signature = fromBase64Url(signatureValue);
  if (!signature) return null;
  const key = await importHmacKey(input.secret);
  const canonical = await canonicalRequest(
    input.request,
    { userId, scopes },
    timestamp,
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(canonical),
  );
  return valid ? { userId, scopes } : null;
}

export function hasOAuthBridgeHeaders(request: Request) {
  return request.headers.has(OAUTH_USER_HEADER)
    || request.headers.has(OAUTH_SIGNATURE_HEADER);
}
