import { ensureHostPermission } from "../lib/settings.js";

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Request failed");
  return response.result;
}

const proxyToggle = document.getElementById("proxyToggle");
const proxyStatus = document.getElementById("proxyStatus");
const passkeyList = document.getElementById("passkeyList");
const passkeyStatus = document.getElementById("passkeyStatus");
const passwordList = document.getElementById("passwordList");
const passwordStatus = document.getElementById("passwordStatus");
const passkeysPanel = document.getElementById("passkeysPanel");
const passwordsPanel = document.getElementById("passwordsPanel");
const addPasswordStatus = document.getElementById("addPasswordStatus");

async function loadProxy() {
  const state = await send("get-proxy-state");
  proxyToggle.checked = !!state.proxyEnabled;
  proxyStatus.textContent = state.proxyEnabled
    ? "Attached — browser WebAuthn is routed here."
    : "Detached — browser uses normal authenticators.";
  proxyStatus.className = "status";
}

async function ensureAccessFromGesture() {
  const settings = await send("get-settings");
  if (!settings?.openbaoUrl) throw new Error("Configure OpenBao settings first");
  const granted = await ensureHostPermission(settings.openbaoUrl);
  if (!granted) throw new Error("Host permission for OpenBao URL was denied");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadPasskeys({ requestPermission = false } = {}) {
  passkeyStatus.textContent = "Loading…";
  passkeyStatus.className = "status";
  passkeyList.innerHTML = "";
  try {
    if (requestPermission) await ensureAccessFromGesture();
    const items = await send("list-passkeys");
    if (!items.length) {
      passkeyStatus.textContent = "No passkeys in OpenBao yet.";
      return;
    }
    passkeyStatus.textContent = `${items.length} credential${items.length === 1 ? "" : "s"}`;
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "item";
      row.innerHTML = `
        <strong>${escapeHtml(item.userDisplayName || item.userName || "Passkey")}</strong>
        <span>${escapeHtml(item.rpId)}</span>
        <span>${escapeHtml(item.credentialId)}</span>
      `;
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.style.marginTop = "8px";
      const del = document.createElement("button");
      del.className = "btn danger";
      del.type = "button";
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete passkey for ${item.rpId}?`)) return;
        await send("delete-passkey", { credentialId: item.credentialId });
        await loadPasskeys();
      });
      actions.appendChild(del);
      row.appendChild(actions);
      passkeyList.appendChild(row);
    }
  } catch (err) {
    passkeyStatus.textContent = err.message;
    passkeyStatus.className = "status err";
  }
}

async function loadPasswords({ requestPermission = false } = {}) {
  passwordStatus.textContent = "Loading…";
  passwordStatus.className = "status";
  passwordList.innerHTML = "";
  try {
    if (requestPermission) await ensureAccessFromGesture();
    const items = await send("list-passwords");
    if (!items.length) {
      passwordStatus.textContent = "No passwords in OpenBao yet.";
      return;
    }
    passwordStatus.textContent = `${items.length} password${items.length === 1 ? "" : "s"}`;
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "item";
      row.innerHTML = `
        <strong>${escapeHtml(item.username || "(no username)")}</strong>
        <span>${escapeHtml(item.origin || item.host || "")}</span>
        <span>${escapeHtml(item.id)}</span>
      `;
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.style.marginTop = "8px";
      const del = document.createElement("button");
      del.className = "btn danger";
      del.type = "button";
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete password for ${item.username || item.origin}?`)) return;
        await send("delete-password", { id: item.id });
        await loadPasswords();
      });
      actions.appendChild(del);
      row.appendChild(actions);
      passwordList.appendChild(row);
    }
  } catch (err) {
    passwordStatus.textContent = err.message;
    passwordStatus.className = "status err";
  }
}

function setTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }
  passkeysPanel.hidden = name !== "passkeys";
  passwordsPanel.hidden = name !== "passwords";
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => setTab(tab.dataset.tab));
}

proxyToggle.addEventListener("change", async () => {
  proxyStatus.textContent = "Updating…";
  try {
    await send("set-proxy-enabled", { enabled: proxyToggle.checked });
    await loadProxy();
  } catch (err) {
    proxyToggle.checked = !proxyToggle.checked;
    proxyStatus.textContent = err.message;
    proxyStatus.className = "status err";
  }
});

document.getElementById("refreshPasskeysBtn").addEventListener("click", () => {
  loadPasskeys({ requestPermission: true });
});
document.getElementById("refreshPasswordsBtn").addEventListener("click", () => {
  loadPasswords({ requestPermission: true });
});
document.getElementById("optionsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("addPasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  addPasswordStatus.textContent = "Saving…";
  addPasswordStatus.className = "status";
  try {
    await ensureAccessFromGesture();
    const origin = document.getElementById("newOrigin").value.trim().replace(/\/+$/, "");
    await send("save-password", {
      origin,
      url: origin,
      username: document.getElementById("newUsername").value.trim(),
      password: document.getElementById("newPassword").value
    });
    document.getElementById("newPassword").value = "";
    addPasswordStatus.textContent = "Saved.";
    addPasswordStatus.className = "status ok";
    await loadPasswords();
  } catch (err) {
    addPasswordStatus.textContent = err.message;
    addPasswordStatus.className = "status err";
  }
});

(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && /^https?:/.test(tab.url)) {
      document.getElementById("newOrigin").value = new URL(tab.url).origin;
    }
  } catch {
    // ignore
  }
})();

loadProxy();
loadPasskeys();
loadPasswords();
