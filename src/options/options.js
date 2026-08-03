import { ensureHostPermission } from "../lib/settings.js";

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Request failed");
  return response.result;
}

const fields = {
  openbaoUrl: document.getElementById("openbaoUrl"),
  authMethod: document.getElementById("authMethod"),
  token: document.getElementById("token"),
  roleId: document.getElementById("roleId"),
  secretId: document.getElementById("secretId"),
  kvMount: document.getElementById("kvMount"),
  pathPrefix: document.getElementById("pathPrefix"),
  passwordPathPrefix: document.getElementById("passwordPathPrefix"),
  autofillEnabled: document.getElementById("autofillEnabled"),
  savePromptEnabled: document.getElementById("savePromptEnabled")
};

const tokenFields = document.getElementById("tokenFields");
const approleFields = document.getElementById("approleFields");
const status = document.getElementById("status");

function readForm() {
  return {
    openbaoUrl: fields.openbaoUrl.value.trim().replace(/\/+$/, ""),
    authMethod: fields.authMethod.value,
    token: fields.token.value.trim(),
    roleId: fields.roleId.value.trim(),
    secretId: fields.secretId.value.trim(),
    kvMount: fields.kvMount.value.trim(),
    pathPrefix: fields.pathPrefix.value.trim(),
    passwordPathPrefix: fields.passwordPathPrefix.value.trim(),
    autofillEnabled: fields.autofillEnabled.checked,
    savePromptEnabled: fields.savePromptEnabled.checked,
    cachedToken: "",
    cachedTokenExpiresAt: 0
  };
}

function syncAuthVisibility() {
  const approle = fields.authMethod.value === "approle";
  tokenFields.hidden = approle;
  approleFields.hidden = !approle;
}

async function requestOpenBaoAccess(url) {
  const granted = await ensureHostPermission(url);
  if (!granted) throw new Error("Host permission for OpenBao URL was denied");
}

fields.authMethod.addEventListener("change", syncAuthVisibility);

document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Saving…";
  status.className = "status";
  try {
    const settings = readForm();
    await requestOpenBaoAccess(settings.openbaoUrl);
    await send("save-settings", { settings });
    status.textContent = "Saved.";
    status.className = "status ok";
  } catch (err) {
    status.textContent = err.message;
    status.className = "status err";
  }
});

document.getElementById("testBtn").addEventListener("click", async () => {
  status.textContent = "Testing…";
  status.className = "status";
  try {
    const settings = readForm();
    await requestOpenBaoAccess(settings.openbaoUrl);
    const result = await send("test-connection", { settings });
    status.textContent = `Connected to ${result.url} (${result.authMethod}).`;
    status.className = "status ok";
  } catch (err) {
    status.textContent = err.message;
    status.className = "status err";
  }
});

const settings = await send("get-settings");
fields.openbaoUrl.value = settings.openbaoUrl || "";
fields.authMethod.value = settings.authMethod || "token";
fields.token.value = settings.token || "";
fields.roleId.value = settings.roleId || "";
fields.secretId.value = settings.secretId || "";
fields.kvMount.value = settings.kvMount || "secret";
fields.pathPrefix.value = settings.pathPrefix || "passkeys";
fields.passwordPathPrefix.value = settings.passwordPathPrefix || "passwords";
fields.autofillEnabled.checked = settings.autofillEnabled !== false;
fields.savePromptEnabled.checked = settings.savePromptEnabled !== false;
syncAuthVisibility();
