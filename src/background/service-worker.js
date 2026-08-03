import { deletePasskey, findPasskeysForRp, listPasskeys, testConnection } from "../lib/openbao.js";
import { getSettings, saveSettings } from "../lib/settings.js";
import {
  createPasskey,
  getPasskeyAssertion,
  summarizeCreateRequest,
  summarizeGetRequest
} from "../lib/webauthn.js";

/** @type {Map<number, {kind: string, summary: object, requestDetailsJson: string, origin: string}>} */
const pending = new Map();

chrome.runtime.onInstalled.addListener(() => {
  console.info("OpenBao Passkeys installed");
});

chrome.alarms.create("token-refresh-check", { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener(() => {
  // Touch settings so AppRole tokens can be refreshed lazily on next use.
});

async function currentOrigin() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const url = tabs[0]?.url;
    if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return null;
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function openApproval(requestId) {
  const url = chrome.runtime.getURL(`src/approve/approve.html?requestId=${requestId}`);
  await chrome.windows.create({
    url,
    type: "popup",
    width: 420,
    height: 520,
    focused: true
  });
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message
    });
  } catch {
    // notifications may be blocked
  }
}

async function setProxyEnabled(enabled) {
  const settings = await saveSettings({ proxyEnabled: enabled });
  if (enabled) {
    const err = await chrome.webAuthenticationProxy.attach();
    if (err) {
      await saveSettings({ proxyEnabled: false });
      throw new Error(err);
    }
    await notify("OpenBao Passkeys", "WebAuthn proxy attached — site passkey prompts go to this extension.");
  } else {
    await chrome.webAuthenticationProxy.detach();
    await notify("OpenBao Passkeys", "WebAuthn proxy detached — browser handles passkeys normally.");
  }
  return settings;
}

chrome.webAuthenticationProxy.onIsUvpaaRequest.addListener(async (requestInfo) => {
  const settings = await getSettings();
  await chrome.webAuthenticationProxy.completeIsUvpaaRequest({
    requestId: requestInfo.requestId,
    isUvpaa: !!settings.proxyEnabled
  });
});

chrome.webAuthenticationProxy.onCreateRequest.addListener(async (requestInfo) => {
  const origin = (await currentOrigin()) || "";
  const summary = summarizeCreateRequest(requestInfo.requestDetailsJson, origin);
  pending.set(requestInfo.requestId, {
    kind: "create",
    summary,
    requestDetailsJson: requestInfo.requestDetailsJson,
    origin
  });
  await openApproval(requestInfo.requestId);
});

chrome.webAuthenticationProxy.onGetRequest.addListener(async (requestInfo) => {
  const origin = (await currentOrigin()) || "";
  const summary = summarizeGetRequest(requestInfo.requestDetailsJson, origin);
  let candidates = [];
  try {
    candidates = await findPasskeysForRp(
      summary.rpId,
      (summary.allowCredentialIds || []).map((id) => ({ id }))
    );
  } catch (err) {
    console.warn("Failed listing passkeys for get request", err);
  }

  pending.set(requestInfo.requestId, {
    kind: "get",
    summary: { ...summary, candidates },
    requestDetailsJson: requestInfo.requestDetailsJson,
    origin
  });
  await openApproval(requestInfo.requestId);
});

chrome.webAuthenticationProxy.onRequestCanceled.addListener((requestId) => {
  pending.delete(requestId);
});

async function completeCreate(requestId, approved) {
  const item = pending.get(requestId);
  pending.delete(requestId);
  if (!item || item.kind !== "create") return;

  if (!approved) {
    await chrome.webAuthenticationProxy.completeCreateRequest({
      requestId,
      error: { name: "NotAllowedError", message: "The operation either timed out or was not allowed." }
    });
    return;
  }

  try {
    const { responseJson } = await createPasskey({
      requestDetailsJson: item.requestDetailsJson,
      origin: item.origin
    });
    await chrome.webAuthenticationProxy.completeCreateRequest({ requestId, responseJson });
  } catch (err) {
    await chrome.webAuthenticationProxy.completeCreateRequest({
      requestId,
      error: err.domException || { name: "UnknownError", message: err.message || String(err) }
    });
  }
}

async function completeGet(requestId, approved, credentialId) {
  const item = pending.get(requestId);
  pending.delete(requestId);
  if (!item || item.kind !== "get") return;

  if (!approved) {
    await chrome.webAuthenticationProxy.completeGetRequest({
      requestId,
      error: { name: "NotAllowedError", message: "The operation either timed out or was not allowed." }
    });
    return;
  }

  try {
    const { responseJson } = await getPasskeyAssertion({
      requestDetailsJson: item.requestDetailsJson,
      origin: item.origin,
      credentialId
    });
    await chrome.webAuthenticationProxy.completeGetRequest({ requestId, responseJson });
  } catch (err) {
    await chrome.webAuthenticationProxy.completeGetRequest({
      requestId,
      error: err.domException || { name: "UnknownError", message: err.message || String(err) }
    });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "get-settings":
        return getSettings();
      case "save-settings":
        // Host permission must be requested from a UI page during a user gesture.
        return saveSettings(message.settings);
      case "test-connection": {
        if (message.settings) await saveSettings(message.settings);
        return testConnection();
      }
      case "list-passkeys":
        return listPasskeys();
      case "delete-passkey":
        await deletePasskey(message.credentialId);
        return { ok: true };
      case "get-proxy-state": {
        const settings = await getSettings();
        return { proxyEnabled: settings.proxyEnabled };
      }
      case "set-proxy-enabled":
        return setProxyEnabled(!!message.enabled);
      case "get-pending":
        return pending.get(message.requestId) || null;
      case "approve-create":
        await completeCreate(message.requestId, true);
        return { ok: true };
      case "deny-create":
        await completeCreate(message.requestId, false);
        return { ok: true };
      case "approve-get":
        await completeGet(message.requestId, true, message.credentialId);
        return { ok: true };
      case "deny-get":
        await completeGet(message.requestId, false);
        return { ok: true };
      default:
        throw new Error(`Unknown message: ${message?.type}`);
    }
  })()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

// Re-attach after service worker restart if user left proxy enabled.
getSettings().then(async (settings) => {
  if (settings.proxyEnabled) {
    try {
      await chrome.webAuthenticationProxy.attach();
    } catch (err) {
      console.warn("Failed to re-attach WebAuthn proxy", err);
      await saveSettings({ proxyEnabled: false });
    }
  }
});
