import {
  defaultOidcRedirectUri,
  loginWithOidc,
  logoutOidc,
  testConnection
} from "../lib/openbao.js";
import { ensureHostPermission, getSettings, saveSettings } from "../lib/settings.js";

const fields = {
  openbaoUrl: document.getElementById("openbaoUrl"),
  authMethod: document.getElementById("authMethod"),
  token: document.getElementById("token"),
  roleId: document.getElementById("roleId"),
  secretId: document.getElementById("secretId"),
  oidcMount: document.getElementById("oidcMount"),
  oidcRole: document.getElementById("oidcRole"),
  oidcRedirectUri: document.getElementById("oidcRedirectUri"),
  kvMount: document.getElementById("kvMount"),
  pathPrefix: document.getElementById("pathPrefix"),
  passwordPathPrefix: document.getElementById("passwordPathPrefix"),
  autofillEnabled: document.getElementById("autofillEnabled"),
  savePromptEnabled: document.getElementById("savePromptEnabled")
};

const tokenFields = document.getElementById("tokenFields");
const approleFields = document.getElementById("approleFields");
const oidcFields = document.getElementById("oidcFields");
const oidcDefaultRedirect = document.getElementById("oidcDefaultRedirect");
const oidcSession = document.getElementById("oidcSession");
const status = document.getElementById("status");

let oidcAbort = null;

function readForm() {
  return {
    openbaoUrl: fields.openbaoUrl.value.trim().replace(/\/+$/, ""),
    authMethod: fields.authMethod.value,
    token: fields.token.value.trim(),
    roleId: fields.roleId.value.trim(),
    secretId: fields.secretId.value.trim(),
    oidcMount: fields.oidcMount.value.trim() || "oidc",
    oidcRole: fields.oidcRole.value.trim(),
    oidcRedirectUri: fields.oidcRedirectUri.value.trim(),
    kvMount: fields.kvMount.value.trim(),
    pathPrefix: fields.pathPrefix.value.trim(),
    passwordPathPrefix: fields.passwordPathPrefix.value.trim(),
    autofillEnabled: fields.autofillEnabled.checked,
    savePromptEnabled: fields.savePromptEnabled.checked
  };
}

function authConfigChanged(prev, next) {
  return (
    prev.openbaoUrl !== next.openbaoUrl ||
    prev.authMethod !== next.authMethod ||
    prev.token !== next.token ||
    prev.roleId !== next.roleId ||
    prev.secretId !== next.secretId ||
    prev.oidcMount !== next.oidcMount ||
    prev.oidcRole !== next.oidcRole ||
    prev.oidcRedirectUri !== next.oidcRedirectUri
  );
}

function syncAuthVisibility() {
  const method = fields.authMethod.value;
  tokenFields.hidden = method !== "token";
  approleFields.hidden = method !== "approle";
  oidcFields.hidden = method !== "oidc";
}

function syncOidcRedirectHint() {
  oidcDefaultRedirect.textContent = defaultOidcRedirectUri();
}

async function syncOidcSession() {
  const settings = await getSettings();
  if (settings.authMethod !== "oidc") {
    oidcSession.textContent = "";
    return;
  }
  if (settings.cachedToken && settings.cachedTokenExpiresAt > Date.now()) {
    const mins = Math.max(1, Math.round((settings.cachedTokenExpiresAt - Date.now()) / 60_000));
    oidcSession.textContent = `Signed in — token expires in ~${mins} min.`;
  } else if (settings.cachedToken) {
    oidcSession.textContent = "Cached token expired — sign in again (renewal is attempted automatically).";
  } else {
    oidcSession.textContent = "Not signed in.";
  }
}

async function requestOpenBaoAccess(url) {
  const granted = await ensureHostPermission(url);
  if (!granted) throw new Error("Host permission for OpenBao URL was denied");
}

async function persistForm({ clearAuthCache = false } = {}) {
  const prev = await getSettings();
  const settings = readForm();
  if (clearAuthCache || authConfigChanged(prev, settings)) {
    settings.cachedToken = "";
    settings.cachedTokenExpiresAt = 0;
    settings.oidcPending = null;
  }
  await saveSettings(settings);
  return settings;
}

fields.authMethod.addEventListener("change", () => {
  syncAuthVisibility();
  syncOidcSession();
});

document.getElementById("copyRedirectBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(defaultOidcRedirectUri());
    status.textContent = "Redirect URI copied.";
    status.className = "status ok";
  } catch {
    status.textContent = "Could not copy redirect URI.";
    status.className = "status err";
  }
});

document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Saving…";
  status.className = "status";
  try {
    const settings = await persistForm();
    await requestOpenBaoAccess(settings.openbaoUrl);
    status.textContent = "Saved.";
    status.className = "status ok";
    await syncOidcSession();
  } catch (err) {
    status.textContent = err.message;
    status.className = "status err";
  }
});

document.getElementById("testBtn").addEventListener("click", async () => {
  status.textContent = "Testing…";
  status.className = "status";
  try {
    const settings = await persistForm();
    await requestOpenBaoAccess(settings.openbaoUrl);

    if (settings.authMethod === "oidc") {
      const current = await getSettings();
      if (!current.cachedToken || current.cachedTokenExpiresAt <= Date.now()) {
        status.textContent = "No OIDC session — starting sign-in…";
        await runOidcLogin();
      }
    }

    const result = await testConnection();
    status.textContent = `Connected to ${result.url} (${result.authMethod}).`;
    status.className = "status ok";
    await syncOidcSession();
  } catch (err) {
    status.textContent = err.message;
    status.className = "status err";
  }
});

async function runOidcLogin() {
  if (oidcAbort) oidcAbort.abort();
  oidcAbort = new AbortController();

  const settings = await persistForm();
  await requestOpenBaoAccess(settings.openbaoUrl);

  await loginWithOidc(settings, {
    signal: oidcAbort.signal,
    onStatus: (info) => {
      if (info.userCode) {
        status.textContent = `${info.message} (code ${info.userCode})`;
      } else {
        status.textContent = info.message || "Signing in…";
      }
      status.className = "status";
    }
  });
}

document.getElementById("oidcLoginBtn").addEventListener("click", async () => {
  status.textContent = "Starting OIDC sign-in…";
  status.className = "status";
  try {
    await runOidcLogin();
    status.textContent = "OIDC sign-in complete.";
    status.className = "status ok";
    await syncOidcSession();
  } catch (err) {
    status.textContent = err.message;
    status.className = "status err";
  }
});

document.getElementById("oidcLogoutBtn").addEventListener("click", async () => {
  status.textContent = "Signing out…";
  status.className = "status";
  try {
    if (oidcAbort) oidcAbort.abort();
    await logoutOidc();
    status.textContent = "Signed out.";
    status.className = "status ok";
    await syncOidcSession();
  } catch (err) {
    status.textContent = err.message;
    status.className = "status err";
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) syncOidcSession();
});

const settings = await getSettings();
fields.openbaoUrl.value = settings.openbaoUrl || "";
fields.authMethod.value = settings.authMethod || "token";
fields.token.value = settings.token || "";
fields.roleId.value = settings.roleId || "";
fields.secretId.value = settings.secretId || "";
fields.oidcMount.value = settings.oidcMount || "oidc";
fields.oidcRole.value = settings.oidcRole || "";
fields.oidcRedirectUri.value = settings.oidcRedirectUri || "";
fields.kvMount.value = settings.kvMount || "secret";
fields.pathPrefix.value = settings.pathPrefix || "passkeys";
fields.passwordPathPrefix.value = settings.passwordPathPrefix || "passwords";
fields.autofillEnabled.checked = settings.autofillEnabled !== false;
fields.savePromptEnabled.checked = settings.savePromptEnabled !== false;
syncAuthVisibility();
syncOidcRedirectHint();
await syncOidcSession();
