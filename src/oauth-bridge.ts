const OAUTH_USER_HEADER = "x-oc-oauth-user";
const OAUTH_SCOPES_HEADER = "x-oc-oauth-scopes";
const OAUTH_TIMESTAMP_HEADER = "x-oc-oauth-timestamp";
/**
 * Signature over the pre-nonce canonical string. Every Studio deployment can
 * verify it, including ones that predate bridge nonces, so it stays unchanged.
 */
const OAUTH_SIGNATURE_HEADER = "x-oc-oauth-signature";
const OAUTH_CREDENTIAL_HEADER = "x-oc-oauth-credential";
const OAUTH_NONCE_HEADER = "x-oc-oauth-nonce";
/**
 * Second signature, over the same canonical string plus the nonce. Studio
 * deployments that predate nonces ignore it and verify the legacy signature.
 */
const OAUTH_NONCE_SIGNATURE_HEADER = "x-oc-oauth-nonce-signature";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** At least 16 random bytes, base64url encoded. */
const NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/;
const ALLOWED_SCOPES = new Set(["models", "read", "generate"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type OAuthBridgeIdentity = {
  userId: string;
  scopes: string[];
  /** Durable OAuth client id used for per-credential spend attribution. */
  credentialId?: string;
};

export type VerifiedOAuthBridgeRequest = OAuthBridgeIdentity & {
  /**
   * Single-use request nonce, present only when the nonce signature verified.
   * Absent for Workers deployed before bridge nonces (or a request stripped
   * of both nonce headers); Studio decides whether to still accept those.
   */
  nonce?: string;
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
  nonce?: string,
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
  // The legacy canonical string always ends in a base64url digest, which
  // never contains ":", so a nonce line cannot be mistaken for another layout
  // and neither signature can stand in for the other.
  if (nonce) {
    lines.push(`nonce:${nonce}`);
  }
  return lines.join("\n");
}

function randomNonce() {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function signOAuthBridgeRequest(input: {
  request: Request;
  secret: string;
  identity: OAuthBridgeIdentity;
  nowSeconds?: number;
  /** Defaults to 16 fresh random bytes; every request must use a new one. */
  nonce?: string;
}) {
  if (!UUID_RE.test(input.identity.userId)) {
    throw new Error("OAuth bridge userId must be a UUID.");
  }
  const nonce = input.nonce ?? randomNonce();
  if (!NONCE_RE.test(nonce)) {
    throw new Error("OAuth bridge nonce must be 22-128 base64url characters.");
  }
  const identity = {
    userId: input.identity.userId,
    scopes: normalizeScopes(input.identity.scopes),
    credentialId: normalizeCredentialId(input.identity.credentialId),
  };
  const timestamp = String(Math.floor(input.nowSeconds ?? Date.now() / 1000));
  const key = await importHmacKey(input.secret);
  const includeCredential = Boolean(identity.credentialId);
  const sign = async (nonceLine?: string) =>
    base64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(
            await canonicalRequest(
              input.request,
              identity,
              timestamp,
              includeCredential,
              nonceLine,
            ),
          ),
        ),
      ),
    );

  return {
    [OAUTH_USER_HEADER]: identity.userId,
    [OAUTH_SCOPES_HEADER]: identity.scopes.join(" "),
    ...(identity.credentialId
      ? { [OAUTH_CREDENTIAL_HEADER]: identity.credentialId }
      : {}),
    [OAUTH_TIMESTAMP_HEADER]: timestamp,
    [OAUTH_SIGNATURE_HEADER]: await sign(),
    [OAUTH_NONCE_HEADER]: nonce,
    [OAUTH_NONCE_SIGNATURE_HEADER]: await sign(nonce),
  };
}

/**
 * Verifies the signature and timestamp window only. A valid result can still
 * be a replay: callers must reject a nonce they have already seen.
 *
 * A request with a nonce is accepted only on its nonce signature, never on
 * the legacy one, and the nonce and its signature must arrive together. A
 * request with neither verifies on the legacy signature and returns no nonce.
 */
export async function verifyOAuthBridgeRequest(input: {
  request: Request;
  secret: string;
  nowSeconds?: number;
  maxClockSkewSeconds?: number;
}): Promise<VerifiedOAuthBridgeRequest | null> {
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
  const nonceValue = input.request.headers.get(OAUTH_NONCE_HEADER);
  const nonceSignatureValue = input.request.headers.get(
    OAUTH_NONCE_SIGNATURE_HEADER,
  );
  const nonce = nonceValue?.trim() || undefined;
  if ((nonceValue === null) !== (nonceSignatureValue === null)) return null;
  const nonced = nonceValue !== null;
  if (nonced && !NONCE_RE.test(nonce ?? "")) return null;
  const presentedSignature = nonced
    ? (nonceSignatureValue?.trim() ?? "")
    : signatureValue;
  if (!UUID_RE.test(userId) || !timestamp || !presentedSignature) return null;

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

  const signature = fromBase64Url(presentedSignature);
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
    nonced ? nonce : undefined,
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(canonical),
  );
  if (!valid) return null;
  return nonced && nonce ? { ...identity, nonce } : identity;
}

export function hasOAuthBridgeHeaders(request: Request) {
  return (
    request.headers.has(OAUTH_USER_HEADER) ||
    request.headers.has(OAUTH_SIGNATURE_HEADER) ||
    request.headers.has(OAUTH_NONCE_SIGNATURE_HEADER)
  );
}

// Login handoff: Studio's own sign-in pages (Google or an email link) hand a
// signed-in user back to a pending OAuth Worker authorization. The token is
// AES-GCM encrypted under a key derived from MCP_OAUTH_SERVICE_SECRET for this
// purpose only, bound to one authorization flow, and valid for two minutes.
// The Worker additionally consumes the flow atomically, so a token is single use.
const LOGIN_HANDOFF_PREFIX = "v1.";
const LOGIN_HANDOFF_CONTEXT = "offlinecreator:mcp-oauth:login-handoff:v1";
const LOGIN_HANDOFF_TTL_SECONDS = 120;
const LOGIN_HANDOFF_MAX_SKEW_SECONDS = 60;
const LOGIN_FLOW_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_EMAIL_LENGTH = 320;

export type OAuthLoginHandoffIdentity = {
  userId: string;
  email: string | null;
};

/** OAuth Worker flow IDs are 32 random bytes, base64url encoded. */
export function isOAuthLoginFlowId(value: string) {
  return LOGIN_FLOW_RE.test(value);
}

async function loginHandoffKey(secret: string) {
  const bytes = new TextEncoder().encode(secret);
  if (bytes.byteLength < 32) {
    throw new Error("MCP_OAUTH_SERVICE_SECRET must contain at least 32 bytes.");
  }
  const base = await crypto.subtle.importKey("raw", bytes, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("offlinecreator-mcp-oauth"),
      info: new TextEncoder().encode(LOGIN_HANDOFF_CONTEXT),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function loginHandoffAad(flow: string) {
  return new TextEncoder().encode(`${LOGIN_HANDOFF_CONTEXT}\n${flow}`);
}

function validEmail(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_EMAIL_LENGTH &&
      !CONTROL_CHARS.test(value))
  );
}

export async function createOAuthLoginHandoff(input: {
  secret: string;
  flow: string;
  userId: string;
  email: string | null;
  nowSeconds?: number;
}) {
  if (!isOAuthLoginFlowId(input.flow)) {
    throw new Error("OAuth login handoff flow is invalid.");
  }
  if (!UUID_RE.test(input.userId)) {
    throw new Error("OAuth login handoff userId must be a UUID.");
  }
  const email = input.email?.trim() || null;
  if (!validEmail(email)) {
    throw new Error("OAuth login handoff email is invalid.");
  }
  const now = Math.floor(input.nowSeconds ?? Date.now() / 1000);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: loginHandoffAad(input.flow) },
    await loginHandoffKey(input.secret),
    new TextEncoder().encode(
      JSON.stringify({
        sub: input.userId,
        email,
        exp: now + LOGIN_HANDOFF_TTL_SECONDS,
      }),
    ),
  );
  const sealed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(new Uint8Array(ciphertext), iv.byteLength);
  return `${LOGIN_HANDOFF_PREFIX}${base64Url(sealed)}`;
}

export async function verifyOAuthLoginHandoff(input: {
  secret: string;
  flow: string;
  token: string;
  nowSeconds?: number;
}): Promise<OAuthLoginHandoffIdentity | null> {
  if (
    !isOAuthLoginFlowId(input.flow) ||
    !input.token.startsWith(LOGIN_HANDOFF_PREFIX) ||
    input.token.length > 2048
  ) {
    return null;
  }
  const sealed = fromBase64Url(input.token.slice(LOGIN_HANDOFF_PREFIX.length));
  if (!sealed || sealed.byteLength < 12 + 16) return null;

  let claims: { sub?: unknown; email?: unknown; exp?: unknown };
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: sealed.slice(0, 12),
        additionalData: loginHandoffAad(input.flow),
      },
      await loginHandoffKey(input.secret),
      sealed.slice(12),
    );
    claims = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }

  const now = Math.floor(input.nowSeconds ?? Date.now() / 1000);
  if (
    !claims ||
    typeof claims.sub !== "string" ||
    !UUID_RE.test(claims.sub) ||
    !validEmail(claims.email) ||
    typeof claims.exp !== "number" ||
    !Number.isInteger(claims.exp) ||
    claims.exp < now ||
    claims.exp >
      now + LOGIN_HANDOFF_TTL_SECONDS + LOGIN_HANDOFF_MAX_SKEW_SECONDS
  ) {
    return null;
  }
  return { userId: claims.sub, email: claims.email };
}

// Token introspection: Studio asks the OAuth Worker whether an access token
// the Worker issued is still active, so `/api/v1/*` can accept that token as
// `Authorization: Bearer`. The Worker's tokens are opaque and live in its KV,
// so only the Worker can check expiry and revocation. The request is
// RFC 7662 shaped (form body `token=...`) and authenticated by an HMAC under
// a key derived from MCP_OAUTH_SERVICE_SECRET for this purpose only, so the
// bridge signature and this one can never stand in for each other.
export const TOKEN_INTROSPECTION_PATH = "/oauth/introspect";
const INTROSPECTION_CONTEXT = "offlinecreator:mcp-oauth:token-introspection:v1";
const INTROSPECTION_TIMESTAMP_HEADER = "x-oc-introspect-timestamp";
const INTROSPECTION_SIGNATURE_HEADER = "x-oc-introspect-signature";
const MAX_INTROSPECTION_BODY_BYTES = 4096;
/**
 * workers-oauth-provider access tokens are `userId:grantId:secret`. Studio API
 * keys start with `oc_` and never contain ":", so the two cannot overlap.
 */
const OAUTH_ACCESS_TOKEN_RE =
  /^[^\s:]{1,128}:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{16,256}$/;

export function isOAuthAccessTokenShape(token: string) {
  return !token.startsWith("oc_") && OAUTH_ACCESS_TOKEN_RE.test(token);
}

async function introspectionKey(secret: string) {
  const bytes = new TextEncoder().encode(secret);
  if (bytes.byteLength < 32) {
    throw new Error("MCP_OAUTH_SERVICE_SECRET must contain at least 32 bytes.");
  }
  const base = await crypto.subtle.importKey("raw", bytes, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("offlinecreator-mcp-oauth"),
      info: new TextEncoder().encode(INTROSPECTION_CONTEXT),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

async function introspectionCanonical(
  method: string,
  pathname: string,
  timestamp: string,
  body: string,
) {
  const digest = base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    ),
  );
  return new TextEncoder().encode(
    [
      INTROSPECTION_CONTEXT,
      method.toUpperCase(),
      pathname,
      timestamp,
      digest,
    ].join("\n"),
  );
}

/** Builds the signed POST Studio sends to `${oauthOrigin}/oauth/introspect`. */
export async function createTokenIntrospectionRequest(input: {
  oauthOrigin: string;
  secret: string;
  token: string;
  nowSeconds?: number;
}) {
  const url = new URL(
    TOKEN_INTROSPECTION_PATH,
    input.oauthOrigin.replace(/\/$/, "") + "/",
  );
  const body = new URLSearchParams({
    token: input.token,
    token_type_hint: "access_token",
  }).toString();
  const timestamp = String(Math.floor(input.nowSeconds ?? Date.now() / 1000));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await introspectionKey(input.secret),
    await introspectionCanonical("POST", url.pathname, timestamp, body),
  );
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      [INTROSPECTION_TIMESTAMP_HEADER]: timestamp,
      [INTROSPECTION_SIGNATURE_HEADER]: base64Url(new Uint8Array(signature)),
    },
    body,
  });
}

/**
 * Verifies a Studio introspection request and returns the token it asks
 * about, or null when the signature, timestamp window or body is bad.
 */
export async function verifyTokenIntrospectionRequest(input: {
  request: Request;
  secret: string;
  nowSeconds?: number;
  maxClockSkewSeconds?: number;
}): Promise<string | null> {
  if (input.request.method.toUpperCase() !== "POST") return null;
  const timestamp =
    input.request.headers.get(INTROSPECTION_TIMESTAMP_HEADER)?.trim() ?? "";
  const signature = fromBase64Url(
    input.request.headers.get(INTROSPECTION_SIGNATURE_HEADER)?.trim() ?? "",
  );
  if (!timestamp || !signature || signature.byteLength === 0) return null;
  const issuedAt = Number(timestamp);
  const now = Math.floor(input.nowSeconds ?? Date.now() / 1000);
  if (
    !Number.isInteger(issuedAt) ||
    Math.abs(now - issuedAt) > (input.maxClockSkewSeconds ?? 60)
  ) {
    return null;
  }
  const bytes = await input.request.clone().arrayBuffer();
  if (bytes.byteLength > MAX_INTROSPECTION_BODY_BYTES) return null;
  const body = new TextDecoder().decode(bytes);
  const valid = await crypto.subtle.verify(
    "HMAC",
    await introspectionKey(input.secret),
    signature,
    await introspectionCanonical(
      "POST",
      new URL(input.request.url).pathname,
      timestamp,
      body,
    ),
  );
  if (!valid) return null;
  const token = new URLSearchParams(body).get("token")?.trim() ?? "";
  return token || null;
}

export type TokenIntrospection =
  | { active: false }
  | {
      active: true;
      userId: string;
      clientId: string;
      /** Every scope on the token, OIDC ones included. */
      scopes: string[];
      expiresAt: number;
      audience: string[];
    };

/**
 * Reads the Worker's RFC 7662 response. Anything malformed, expired or
 * missing a UUID subject or client is treated as inactive.
 */
export function parseTokenIntrospectionResponse(
  value: unknown,
  nowSeconds?: number,
): TokenIntrospection {
  if (!value || typeof value !== "object") return { active: false };
  const body = value as Record<string, unknown>;
  if (body.active !== true) return { active: false };
  const now = Math.floor(nowSeconds ?? Date.now() / 1000);
  const clientId = normalizeCredentialId(
    typeof body.client_id === "string" ? body.client_id : undefined,
  );
  const audience =
    typeof body.aud === "string"
      ? [body.aud]
      : Array.isArray(body.aud)
        ? body.aud.filter((entry): entry is string => typeof entry === "string")
        : [];
  if (
    typeof body.sub !== "string" ||
    !UUID_RE.test(body.sub) ||
    !clientId ||
    typeof body.exp !== "number" ||
    !Number.isInteger(body.exp) ||
    body.exp < now ||
    (body.scope !== undefined && typeof body.scope !== "string")
  ) {
    return { active: false };
  }
  const scopes =
    typeof body.scope === "string"
      ? body.scope.split(/\s+/).filter(Boolean)
      : [];
  return {
    active: true,
    userId: body.sub,
    clientId,
    scopes,
    expiresAt: body.exp,
    audience,
  };
}
