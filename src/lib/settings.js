const DEFAULTS = {
  openbaoUrl: "http://127.0.0.1:8200",
  authMethod: "token", // token | approle | oidc
  token: "",
  roleId: "",
  secretId: "",
  oidcMount: "oidc",
  oidcRole: "",
  oidcRedirectUri: "",
  oidcPending: null,
  cachedToken: "",
  cachedTokenExpiresAt: 0,
  kvMount: "secret",
  pathPrefix: "passkeys",
  passwordPathPrefix: "passwords",
  autofillEnabled: true,
  savePromptEnabled: true,
  proxyEnabled: false,
  aaguid: "6f70656e-6261-6f70-6173-736b65797301"
};

export async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function openbaoOrigin(url) {
  const trimmed = url.replace(/\/+$/, "");
  return new URL(trimmed).origin;
}

export async function ensureHostPermission(url) {
  const origin = `${openbaoOrigin(url)}/*`;
  const already = await chrome.permissions.contains({ origins: [origin] });
  if (already) return true;
  return chrome.permissions.request({ origins: [origin] });
}
