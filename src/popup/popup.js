import { ensureHostPermission } from "../lib/settings.js";

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Request failed");
  return response.result;
}

const proxyToggle = document.getElementById("proxyToggle");
const proxyStatus = document.getElementById("proxyStatus");
const listEl = document.getElementById("list");
const listStatus = document.getElementById("listStatus");

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

async function loadList({ requestPermission = false } = {}) {
  listStatus.textContent = "Loading…";
  listStatus.className = "status";
  listEl.innerHTML = "";
  try {
    if (requestPermission) await ensureAccessFromGesture();
    const items = await send("list-passkeys");
    if (!items.length) {
      listStatus.textContent = "No passkeys in OpenBao yet.";
      return;
    }
    listStatus.textContent = `${items.length} credential${items.length === 1 ? "" : "s"}`;
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
        await loadList();
      });
      actions.appendChild(del);
      row.appendChild(actions);
      listEl.appendChild(row);
    }
  } catch (err) {
    listStatus.textContent = err.message;
    listStatus.className = "status err";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

document.getElementById("refreshBtn").addEventListener("click", () => {
  loadList({ requestPermission: true });
});
document.getElementById("optionsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

loadProxy();
loadList();
