import {
  base64UrlToBuffer,
  bufferToBase64Url,
  concatBuffers,
  encodeCbor,
  randomBytes,
  sha256,
  utf8Encode
} from "./encoding.js";
import { getPasskey, putPasskey } from "./openbao.js";
import { getSettings } from "./settings.js";

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;

function aaguidBytes(aaguid) {
  const hex = aaguid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function decodeMaybeBase64Url(value) {
  if (typeof value === "string") return new Uint8Array(base64UrlToBuffer(value));
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("Expected base64url or buffer");
}

async function importPrivateKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

async function exportPublicKeyRaw(publicKey) {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  const x = new Uint8Array(base64UrlToBuffer(jwk.x));
  const y = new Uint8Array(base64UrlToBuffer(jwk.y));
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(`Unexpected P-256 coordinate length: x=${x.length} y=${y.length}`);
  }
  const spki = bufferToBase64Url(await crypto.subtle.exportKey("spki", publicKey));
  return { x, y, spki };
}

/**
 * Web Crypto ECDSA signatures are IEEE P1363 (r||s).
 * WebAuthn/CTAP assertion signatures for ES256 must be ASN.1 DER.
 */
function p1363ToDer(signature) {
  const bytes = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
  if (bytes.length >= 2 && bytes[0] === 0x30) return bytes;

  if (bytes.length % 2 !== 0) {
    throw new Error(`Unexpected ECDSA signature length: ${bytes.length}`);
  }

  const half = bytes.length / 2;
  const r = derIntegerFromUnsigned(bytes.slice(0, half));
  const s = derIntegerFromUnsigned(bytes.slice(half));
  const bodyLen = r.length + s.length;

  if (bodyLen < 0x80) {
    const out = new Uint8Array(2 + bodyLen);
    out[0] = 0x30;
    out[1] = bodyLen;
    out.set(r, 2);
    out.set(s, 2 + r.length);
    return out;
  }

  // Lengths for P-256 fit in short form; keep long-form for safety.
  const out = new Uint8Array(3 + bodyLen);
  out[0] = 0x30;
  out[1] = 0x81;
  out[2] = bodyLen;
  out.set(r, 3);
  out.set(s, 3 + r.length);
  return out;
}

function derIntegerFromUnsigned(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  let value = bytes.slice(start);
  if (value[0] & 0x80) {
    const padded = new Uint8Array(value.length + 1);
    padded.set(value, 1);
    value = padded;
  }
  const out = new Uint8Array(2 + value.length);
  out[0] = 0x02;
  out[1] = value.length;
  out.set(value, 2);
  return out;
}

function cosePublicKey(x, y) {
  const map = new Map();
  map.set(1, 2); // kty: EC2
  map.set(3, -7); // alg: ES256
  map.set(-1, 1); // crv: P-256
  map.set(-2, x);
  map.set(-3, y);
  return encodeCbor(map);
}

function buildAuthData({ rpIdHash, flags, signCount, attestedCredentialData }) {
  const counter = new Uint8Array(4);
  new DataView(counter.buffer).setUint32(0, signCount >>> 0, false);
  const parts = [rpIdHash, Uint8Array.of(flags), counter];
  if (attestedCredentialData) parts.push(attestedCredentialData);
  return new Uint8Array(concatBuffers(...parts));
}

function buildAttestedCredentialData(aaguid, credentialId, publicKeyCose) {
  const idLen = new Uint8Array(2);
  new DataView(idLen.buffer).setUint16(0, credentialId.length, false);
  return new Uint8Array(
    concatBuffers(aaguid, idLen, credentialId, publicKeyCose)
  );
}

function clientDataJSON({ type, challenge, origin, crossOrigin = false }) {
  return utf8Encode(
    JSON.stringify({
      type,
      challenge,
      origin,
      crossOrigin
    })
  );
}

function originFromRpId(rpId) {
  // RPs may be hostnames; WebAuthn origin is scheme+host[+port]. Proxy JSON usually includes the real origin
  // in extensions or we infer https.
  if (rpId.startsWith("http://") || rpId.startsWith("https://")) return rpId;
  return `https://${rpId}`;
}

function normalizeCreationOptions(options) {
  const publicKey = options.publicKey || options;
  return {
    rp: publicKey.rp,
    user: {
      ...publicKey.user,
      id: decodeMaybeBase64Url(publicKey.user.id)
    },
    challenge: decodeMaybeBase64Url(publicKey.challenge),
    pubKeyCredParams: publicKey.pubKeyCredParams || [{ type: "public-key", alg: -7 }],
    authenticatorSelection: publicKey.authenticatorSelection || {},
    attestation: publicKey.attestation || "none",
    excludeCredentials: (publicKey.excludeCredentials || []).map((c) => ({
      ...c,
      id: typeof c.id === "string" ? c.id : bufferToBase64Url(c.id)
    })),
    extensions: publicKey.extensions || {}
  };
}

function normalizeRequestOptions(options) {
  const publicKey = options.publicKey || options;
  return {
    rpId: publicKey.rpId,
    challenge: decodeMaybeBase64Url(publicKey.challenge),
    allowCredentials: (publicKey.allowCredentials || []).map((c) => ({
      ...c,
      id: typeof c.id === "string" ? c.id : bufferToBase64Url(c.id)
    })),
    userVerification: publicKey.userVerification || "preferred",
    extensions: publicKey.extensions || {},
    timeout: publicKey.timeout
  };
}

export async function createPasskey({ requestDetailsJson, origin }) {
  const options = normalizeCreationOptions(JSON.parse(requestDetailsJson));
  const settings = await getSettings();

  const algs = options.pubKeyCredParams.map((p) => p.alg);
  if (!algs.includes(-7)) {
    throw Object.assign(new Error("Only ES256 (-7) is supported"), {
      domException: { name: "NotSupportedError", message: "Only ES256 is supported" }
    });
  }

  const rpId = options.rp.id || new URL(origin).hostname;
  for (const excluded of options.excludeCredentials) {
    try {
      const existing = await getPasskey(excluded.id);
      if (existing?.rpId === rpId) {
        throw Object.assign(new Error("Credential excluded"), {
          domException: { name: "InvalidStateError", message: "Credential already registered" }
        });
      }
    } catch (err) {
      if (err.domException) throw err;
      if (err.status && err.status !== 404) throw err;
    }
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const { x, y, spki } = await exportPublicKeyRaw(keyPair.publicKey);
  const credentialIdBytes = randomBytes(32);
  const credentialId = bufferToBase64Url(credentialIdBytes);
  const rpIdHash = new Uint8Array(await sha256(utf8Encode(rpId)));
  const publicKeyCose = new Uint8Array(cosePublicKey(x, y));
  const attested = buildAttestedCredentialData(
    aaguidBytes(settings.aaguid),
    credentialIdBytes,
    publicKeyCose
  );

  const flags = FLAG_UP | FLAG_UV | FLAG_AT | FLAG_BE | FLAG_BS;
  const signCount = 0;
  const authData = buildAuthData({
    rpIdHash,
    flags,
    signCount,
    attestedCredentialData: attested
  });

  const challengeB64 = bufferToBase64Url(options.challenge);
  const clientData = clientDataJSON({
    type: "webauthn.create",
    challenge: challengeB64,
    origin: origin || originFromRpId(rpId)
  });

  const attestationObject = encodeCbor({
    fmt: "none",
    attStmt: {},
    authData
  });

  const record = {
    credentialId,
    rpId,
    rpName: options.rp.name || rpId,
    userHandle: bufferToBase64Url(options.user.id),
    userName: options.user.name,
    userDisplayName: options.user.displayName || options.user.name,
    privateKeyJwk,
    publicKeySpki: spki,
    signCount,
    createdAt: new Date().toISOString(),
    transports: ["internal"],
    backupEligible: true,
    backupState: true
  };

  await putPasskey(record);

  const responseJson = JSON.stringify({
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
    response: {
      clientDataJSON: bufferToBase64Url(clientData),
      attestationObject: bufferToBase64Url(attestationObject),
      transports: ["internal"],
      publicKeyAlgorithm: -7,
      publicKey: spki,
      authenticatorData: bufferToBase64Url(authData)
    }
  });

  return { responseJson, record };
}

export async function getPasskeyAssertion({ requestDetailsJson, origin, credentialId }) {
  const options = normalizeRequestOptions(JSON.parse(requestDetailsJson));
  const rpId = options.rpId || new URL(origin).hostname;

  let record;
  if (credentialId) {
    record = await getPasskey(credentialId);
  } else if (options.allowCredentials?.length) {
    for (const allowed of options.allowCredentials) {
      try {
        const candidate = await getPasskey(allowed.id);
        if (candidate?.rpId === rpId) {
          record = candidate;
          break;
        }
      } catch {
        // continue
      }
    }
  } else {
    throw Object.assign(new Error("No credentials available"), {
      domException: { name: "NotAllowedError", message: "No passkeys found for this site" }
    });
  }

  if (!record || record.rpId !== rpId) {
    throw Object.assign(new Error("Credential not found"), {
      domException: { name: "NotAllowedError", message: "Requested passkey not found in OpenBao" }
    });
  }

  const privateKey = await importPrivateKey(record.privateKeyJwk);
  const nextCount = (record.signCount || 0) + 1;
  const rpIdHash = new Uint8Array(await sha256(utf8Encode(rpId)));
  const flags = FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS;
  const authData = buildAuthData({ rpIdHash, flags, signCount: nextCount });

  const challengeB64 = bufferToBase64Url(options.challenge);
  const clientData = clientDataJSON({
    type: "webauthn.get",
    challenge: challengeB64,
    origin: origin || originFromRpId(rpId)
  });
  const clientDataHash = new Uint8Array(await sha256(clientData));
  const toSign = concatBuffers(authData, clientDataHash);
  const p1363 = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    toSign
  );
  const signature = p1363ToDer(p1363);

  const updated = { ...record, signCount: nextCount, lastUsedAt: new Date().toISOString() };
  await putPasskey(updated);

  const responseJson = JSON.stringify({
    id: record.credentialId,
    rawId: record.credentialId,
    type: "public-key",
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
    response: {
      clientDataJSON: bufferToBase64Url(clientData),
      authenticatorData: bufferToBase64Url(authData),
      signature: bufferToBase64Url(signature),
      userHandle: record.userHandle
    }
  });

  return { responseJson, record: updated };
}

export function summarizeCreateRequest(requestDetailsJson, origin) {
  const options = normalizeCreationOptions(JSON.parse(requestDetailsJson));
  return {
    type: "create",
    rpId: options.rp.id || (origin ? new URL(origin).hostname : ""),
    rpName: options.rp.name,
    userName: options.user.name,
    userDisplayName: options.user.displayName,
    origin
  };
}

export function summarizeGetRequest(requestDetailsJson, origin) {
  const options = normalizeRequestOptions(JSON.parse(requestDetailsJson));
  return {
    type: "get",
    rpId: options.rpId || (origin ? new URL(origin).hostname : ""),
    allowCredentialIds: (options.allowCredentials || []).map((c) => c.id),
    origin
  };
}
