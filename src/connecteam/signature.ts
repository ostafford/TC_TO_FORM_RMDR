/*
 * Copied from EH_Webhook (~/IDP/EH_Webhook/src/connecteam/signature.ts at
 * 0c5ec92), unchanged apart from this note. Never import it from the sibling
 * project.
 */
/**
 * Verifies that an inbound webhook really came from Connecteam, using the
 * `CT_WEBHOOK_SECRET` shared with the webhook registration.
 *
 * Connecteam webhook `webhookVersion: 1` (the only version as of 2026-08) does
 * NOT sign the body. It sends the registered `secretKey` verbatim in the
 * `x-webhook-secret` header - a static shared secret, no HMAC. That is what
 * `DEFAULT_SCHEME` below encodes, and it was confirmed against a real delivery
 * during the #22 guided deployment (see docs/RUNBOOK.md step 6).
 *
 * The `hmac` mode is kept for a future signed version / another source: pass an
 * explicit `{ mode: "hmac", encoding }` scheme and the raw body is HMAC-SHA256'd
 * and compared. The `/webhook` route reads the header name from
 * `DEFAULT_SCHEME.header` (src/index.ts) either way.
 */
export interface SignatureScheme {
  /**
   * `shared_secret` - the header carries the secret verbatim (Connecteam v1).
   * `hmac`          - the header carries HMAC-SHA256(rawBody) in `encoding`.
   */
  mode: "shared_secret" | "hmac";
  /** Lower-cased HTTP header that carries the value. */
  header: string;
  /** Only read in `hmac` mode. Defaults to `hex`. */
  encoding?: "hex" | "base64";
}

export const DEFAULT_SCHEME: SignatureScheme = {
  mode: "shared_secret",
  header: "x-webhook-secret",
};

const enc = new TextEncoder();

export async function verifyWebhookSignature(
  rawBody: string,
  headerValue: string | null | undefined,
  secret: string,
  scheme: SignatureScheme = DEFAULT_SCHEME,
): Promise<boolean> {
  if (!headerValue || !secret) return false;

  if (scheme.mode === "shared_secret") {
    return timingSafeEqual(headerValue.trim(), secret);
  }

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = scheme.encoding === "base64" ? toBase64(mac) : toHex(mac);
  return timingSafeEqual(expected, headerValue.trim());
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

/** Constant-time string compare. Exported for other shared-secret checks (e.g. `/status` auth). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
