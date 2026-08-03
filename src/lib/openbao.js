import { getSettings, saveSettings } from "./settings.js";

export class OpenBaoError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "OpenBaoError";
    this.status = status;
    this.body = body;
  }
}

async function parseResponse(response) {
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const msg =
      payload?.errors?.join?.("; ") ||
      payload?.error ||
      (typeof payload === "string" ? payload : response.statusText);
    throw new OpenBaoError(msg || `OpenBao request failed (${response.status})`, response.status, payload);
  }

  return payload;
}

export async function request(path, { method = "GET", body, token, baseUrl } = {}) {
  const settings = await getSettings();
  const root = (baseUrl || settings.openbaoUrl).replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  const authToken = token === undefined ? await resolveToken(settings) : token;
  if (authToken) headers["X-Vault-Token"] = authToken;

  const response = await fetch(`${root}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  return parseResponse(response);
}

async function loginAppRole(settings) {
  const root = settings.openbaoUrl.replace(/\/+$/, "");
  const response = await fetch(`${root}/v1/auth/approle/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role_id: settings.roleId, secret_id: settings.secretId })
  });
  return parseResponse(response);
}

async function resolveToken(settings) {
  if (settings.authMethod === "token") {
    if (!settings.token) throw new OpenBaoError("OpenBao token is not configured", 401);
    return settings.token;
  }

  if (settings.cachedToken && settings.cachedTokenExpiresAt > Date.now() + 30_000) {
    return settings.cachedToken;
  }

  if (!settings.roleId || !settings.secretId) {
    throw new OpenBaoError("AppRole role_id and secret_id are required", 401);
  }

  const login = await loginAppRole(settings);
  const clientToken = login?.auth?.client_token;
  const lease = (login?.auth?.lease_duration || 3600) * 1000;
  if (!clientToken) throw new OpenBaoError("AppRole login did not return a client token", 401);

  await saveSettings({
    cachedToken: clientToken,
    cachedTokenExpiresAt: Date.now() + lease
  });

  return clientToken;
}

function cleanSegment(value) {
  return String(value || "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.\./g, "");
}

export function kvDataPath(settings, prefix, id) {
  const mount = cleanSegment(settings.kvMount);
  const path = cleanSegment(prefix);
  const key = cleanSegment(id);
  return `/v1/${mount}/data/${path}/${key}`;
}

export function kvMetadataPath(settings, prefix, id = "") {
  const mount = cleanSegment(settings.kvMount);
  const path = cleanSegment(prefix);
  const key = cleanSegment(id);
  const suffix = key ? `/${key}` : "";
  return `/v1/${mount}/metadata/${path}${suffix}`;
}

export async function listKvKeys(prefix) {
  const settings = await getSettings();
  try {
    const result = await request(`${kvMetadataPath(settings, prefix)}?list=true`);
    return (result?.data?.keys || []).map((key) => key.replace(/\/$/, ""));
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

export async function getKvRecord(prefix, id) {
  const settings = await getSettings();
  const result = await request(kvDataPath(settings, prefix, id));
  return result?.data?.data || null;
}

export async function putKvRecord(prefix, id, record) {
  const settings = await getSettings();
  await request(kvDataPath(settings, prefix, id), {
    method: "POST",
    body: { data: record }
  });
  return record;
}

export async function deleteKvRecord(prefix, id) {
  const settings = await getSettings();
  await request(kvMetadataPath(settings, prefix, id), { method: "DELETE" });
}

export async function testConnection() {
  const settings = await getSettings();
  await resolveToken(settings);
  await request("/v1/auth/token/lookup-self");
  return { ok: true, url: settings.openbaoUrl, authMethod: settings.authMethod };
}

export async function listPasskeys() {
  const settings = await getSettings();
  const keys = await listKvKeys(settings.pathPrefix);
  const credentials = [];
  for (const id of keys) {
    try {
      const record = await getPasskey(id);
      if (record) credentials.push(publicView(record));
    } catch {
      // Skip unreadable entries
    }
  }
  return credentials.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

export async function getPasskey(credentialId) {
  const settings = await getSettings();
  return getKvRecord(settings.pathPrefix, credentialId);
}

export async function putPasskey(record) {
  const settings = await getSettings();
  await putKvRecord(settings.pathPrefix, record.credentialId, record);
  return publicView(record);
}

export async function deletePasskey(credentialId) {
  const settings = await getSettings();
  await deleteKvRecord(settings.pathPrefix, credentialId);
}

export function publicView(record) {
  if (!record) return null;
  const { privateKeyJwk, ...rest } = record;
  return rest;
}

export async function findPasskeysForRp(rpId, allowCredentials) {
  const all = await listPasskeys();
  let matches = all.filter((c) => c.rpId === rpId);
  if (allowCredentials?.length) {
    const allowed = new Set(allowCredentials.map((c) => c.id));
    matches = matches.filter((c) => allowed.has(c.credentialId));
  }
  return matches;
}
