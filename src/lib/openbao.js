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

async function request(path, { method = "GET", body, token, baseUrl } = {}) {
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

function kvDataPath(settings, credentialId) {
  const mount = settings.kvMount.replace(/^\/+|\/+$/g, "");
  const prefix = settings.pathPrefix.replace(/^\/+|\/+$/g, "");
  return `/v1/${mount}/data/${prefix}/${credentialId}`;
}

function kvMetadataPath(settings, credentialId = "") {
  const mount = settings.kvMount.replace(/^\/+|\/+$/g, "");
  const prefix = settings.pathPrefix.replace(/^\/+|\/+$/g, "");
  const suffix = credentialId ? `/${credentialId}` : "";
  return `/v1/${mount}/metadata/${prefix}${suffix}`;
}

export async function testConnection() {
  const settings = await getSettings();
  await resolveToken(settings);
  // Cheap authenticated probe: read sys/health does not need a token on many installs,
  // so hit a token-required endpoint instead.
  await request("/v1/auth/token/lookup-self");
  return { ok: true, url: settings.openbaoUrl, authMethod: settings.authMethod };
}

export async function listPasskeys() {
  const settings = await getSettings();
  try {
    const result = await request(`${kvMetadataPath(settings)}?list=true`);
    const keys = result?.data?.keys || [];
    const credentials = [];
    for (const key of keys) {
      const id = key.replace(/\/$/, "");
      try {
        const record = await getPasskey(id);
        if (record) credentials.push(publicView(record));
      } catch {
        // Skip unreadable entries
      }
    }
    return credentials.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

export async function getPasskey(credentialId) {
  const settings = await getSettings();
  const result = await request(kvDataPath(settings, credentialId));
  return result?.data?.data || null;
}

export async function putPasskey(record) {
  const settings = await getSettings();
  await request(kvDataPath(settings, record.credentialId), {
    method: "POST",
    body: { data: record }
  });
  return publicView(record);
}

export async function deletePasskey(credentialId) {
  const settings = await getSettings();
  await request(kvMetadataPath(settings, credentialId), { method: "DELETE" });
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
