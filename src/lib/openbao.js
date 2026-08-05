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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function defaultOidcRedirectUri() {
  return chrome.runtime.getURL("src/oidc/callback.html");
}

export function oidcRedirectUri(settings) {
  return String(settings?.oidcRedirectUri || "").trim() || defaultOidcRedirectUri();
}

function authMount(settings) {
  return cleanSegment(settings.oidcMount || "oidc");
}

async function persistAuthFromLogin(login) {
  const clientToken = login?.auth?.client_token;
  const lease = (login?.auth?.lease_duration || 3600) * 1000;
  if (!clientToken) throw new OpenBaoError("Login did not return a client token", 401);

  await saveSettings({
    cachedToken: clientToken,
    cachedTokenExpiresAt: Date.now() + lease,
    oidcPending: null
  });

  return clientToken;
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

async function renewSelf(token, settings) {
  const root = settings.openbaoUrl.replace(/\/+$/, "");
  const response = await fetch(`${root}/v1/auth/token/renew-self`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vault-Token": token
    },
    body: "{}"
  });
  return parseResponse(response);
}

async function resolveCachedOrRenew(settings) {
  if (settings.cachedToken && settings.cachedTokenExpiresAt > Date.now() + 30_000) {
    return settings.cachedToken;
  }

  if (settings.cachedToken) {
    try {
      const renewed = await renewSelf(settings.cachedToken, settings);
      return persistAuthFromLogin(renewed);
    } catch {
      await saveSettings({ cachedToken: "", cachedTokenExpiresAt: 0 });
    }
  }

  return null;
}

export async function requestOidcAuthUrl(settings, { redirectUri, clientNonce } = {}) {
  const root = settings.openbaoUrl.replace(/\/+$/, "");
  const mount = authMount(settings);
  const body = {};
  if (settings.oidcRole) body.role = settings.oidcRole;
  if (clientNonce) body.client_nonce = clientNonce;
  if (redirectUri) body.redirect_uri = redirectUri;

  const response = await fetch(`${root}/v1/auth/${mount}/oidc/auth_url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

export async function completeOidcCallback({ code, state, idToken, clientNonce, settings } = {}) {
  const current = settings || (await getSettings());
  const root = current.openbaoUrl.replace(/\/+$/, "");
  const mount = authMount(current);
  const params = new URLSearchParams();
  if (state) params.set("state", state);
  if (code) params.set("code", code);
  if (idToken) params.set("id_token", idToken);
  if (clientNonce) params.set("client_nonce", clientNonce);

  const response = await fetch(`${root}/v1/auth/${mount}/oidc/callback?${params}`, {
    method: "GET"
  });
  const login = await parseResponse(response);
  await persistAuthFromLogin(login);
  return login;
}

async function pollOidcOnceGet(root, mount, state, clientNonce) {
  const params = new URLSearchParams({ state });
  if (clientNonce) params.set("client_nonce", clientNonce);
  return fetch(`${root}/v1/auth/${mount}/oidc/poll?${params}`, { method: "GET" });
}

async function pollOidcOncePost(root, mount, state, clientNonce) {
  return fetch(`${root}/v1/auth/${mount}/oidc/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, client_nonce: clientNonce })
  });
}

export async function pollOidcOnce({ state, clientNonce, settings } = {}) {
  if (!state) throw new OpenBaoError("OIDC poll requires state", 400);

  const current = settings || (await getSettings());
  const root = current.openbaoUrl.replace(/\/+$/, "");
  const mount = authMount(current);

  let response = await pollOidcOnceGet(root, mount, state, clientNonce);
  if (response.status === 404 || response.status === 405) {
    response = await pollOidcOncePost(root, mount, state, clientNonce);
  }

  if (response.status === 400) {
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { errors: [text] };
    }
    const err = payload?.errors?.[0] || "";
    if (err === "authorization_pending" || err === "slow_down") {
      return { status: err };
    }
    throw new OpenBaoError(payload?.errors?.join?.("; ") || "OIDC poll failed", 400, payload);
  }

  const login = await parseResponse(response);
  if (!login?.auth?.client_token) {
    throw new OpenBaoError("OIDC poll did not return a client token", 401, login);
  }
  await persistAuthFromLogin(login);
  return { status: "ok", login };
}

function waitForOidcClientCallback({ signal, timeoutMs = 5 * 60_000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.storage.onChanged.removeListener(onChange);
      signal?.removeEventListener?.("abort", onAbort);
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(reject, new OpenBaoError("OIDC login timed out — complete sign-in in the browser tab", 408));
    }, timeoutMs);

    const onAbort = () => finish(reject, new Error("OIDC login cancelled"));

    function onChange(changes, area) {
      if (area !== "local" || !changes.settings) return;
      const next = changes.settings.newValue || {};
      if (!next.cachedToken || next.oidcPending) return;
      finish(resolve, { auth: { client_token: next.cachedToken, lease_duration: 0 } });
    }

    chrome.storage.onChanged.addListener(onChange);
    signal?.addEventListener?.("abort", onAbort);
  });
}

/**
 * Interactive OIDC login for OpenBao JWT/OIDC auth.
 * Supports client callback (extension page), direct callback (poll), and device flow.
 */
export async function loginWithOidc(settings, { onStatus, signal } = {}) {
  const current = settings || (await getSettings());
  if (!current.openbaoUrl) throw new OpenBaoError("OpenBao URL is required", 400);

  const clientNonce = crypto.randomUUID().replace(/-/g, "");
  const redirectUri = oidcRedirectUri(current);

  await saveSettings({
    cachedToken: "",
    cachedTokenExpiresAt: 0,
    oidcPending: { clientNonce, startedAt: Date.now(), redirectUri }
  });

  onStatus?.({ phase: "auth_url", message: "Requesting OpenBao OIDC authorization URL…" });

  const authUrlResp = await requestOidcAuthUrl(current, { redirectUri, clientNonce });
  const data = authUrlResp?.data || {};
  if (!data.auth_url) {
    throw new OpenBaoError("OpenBao did not return an OIDC auth_url", 500, authUrlResp);
  }

  let pollState = data.state || "";
  if (!pollState) {
    try {
      pollState = new URL(data.auth_url).searchParams.get("state") || "";
    } catch {
      pollState = "";
    }
  }

  // user_code => device; state/poll_interval from OpenBao => direct/device poll; else client callback.
  const mode = data.user_code
    ? "device"
    : data.poll_interval != null || data.state
      ? "direct"
      : "client";

  onStatus?.({
    phase: "browser",
    mode,
    userCode: data.user_code || "",
    authUrl: data.auth_url,
    message:
      mode === "device"
        ? `Enter code ${data.user_code} at the provider, then wait…`
        : "Complete sign-in in the browser tab…"
  });

  await chrome.tabs.create({ url: data.auth_url, active: true });

  if (mode === "client") {
    return waitForOidcClientCallback({ signal });
  }

  if (!pollState) {
    throw new OpenBaoError("OpenBao OIDC direct/device mode did not return state for polling", 500, data);
  }

  let intervalMs = Math.max(1, Number(data.poll_interval) || 5) * 1000;
  const deadline = Date.now() + 5 * 60_000;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("OIDC login cancelled");
    await sleep(intervalMs);
    onStatus?.({
      phase: "poll",
      mode,
      userCode: data.user_code || "",
      message: "Waiting for OpenBao OIDC authorization…"
    });

    const result = await pollOidcOnce({
      state: pollState,
      clientNonce,
      settings: current
    });

    if (result.status === "ok") return result.login;
    if (result.status === "slow_down") intervalMs += 2000;
  }

  throw new OpenBaoError("OIDC login timed out", 408);
}

export async function logoutOidc() {
  const settings = await getSettings();
  if (settings.cachedToken) {
    try {
      const root = settings.openbaoUrl.replace(/\/+$/, "");
      await fetch(`${root}/v1/auth/token/revoke-self`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Vault-Token": settings.cachedToken
        },
        body: "{}"
      });
    } catch {
      // Best-effort revoke
    }
  }

  return saveSettings({
    cachedToken: "",
    cachedTokenExpiresAt: 0,
    oidcPending: null
  });
}

async function resolveToken(settings) {
  if (settings.authMethod === "token") {
    if (!settings.token) throw new OpenBaoError("OpenBao token is not configured", 401);
    return settings.token;
  }

  if (settings.authMethod === "oidc") {
    const cached = await resolveCachedOrRenew(settings);
    if (cached) return cached;
    throw new OpenBaoError("Sign in with OIDC from OpenBao settings", 401);
  }

  const cached = await resolveCachedOrRenew(settings);
  if (cached) return cached;

  if (!settings.roleId || !settings.secretId) {
    throw new OpenBaoError("AppRole role_id and secret_id are required", 401);
  }

  const login = await loginAppRole(settings);
  return persistAuthFromLogin(login);
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
