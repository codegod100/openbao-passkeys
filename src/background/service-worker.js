import { deletePasskey, findPasskeysForRp, listPasskeys, testConnection } from "../lib/openbao.js";
import {
  deletePassword,
  getPassword,
  getPasswordsForOrigin,
  listPasswords,
  savePassword
} from "../lib/passwords.js";
import { getSettings, saveSettings } from "../lib/settings.js";
import {
  createPasskey,
  getPasskeyAssertion,
  summarizeCreateRequest,
  summarizeGetRequest
} from "../lib/webauthn.js";

/** @type {Map<number, {kind: string, summary: object, requestDetailsJson: string, origin: string}>} */
const pending = new Map();

/** @type {Map<string, {offerId: string, origin: string, url: string, username: string, password: string, existingId: string|null, tabId: number|null, notificationId: string|null, createdAt: number}>} */
const pendingPasswordOffers = new Map();

chrome.runtime.onInstalled.addListener(() => {
  console.info("OpenBao Passkeys installed");
});

async function injectAutofill(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["src/content/autofill.js"]
    });
  } catch (err) {
    // Restricted pages (chrome://, Web Store, etc.) cannot be scripted.
    console.debug("autofill inject skipped", tabId, err?.message || err);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const url = tab.url || "";
  if (!/^https?:\/\//.test(url)) return;
  injectAutofill(tabId);
});

chrome.alarms.create("token-refresh-check", { periodInMinutes: 30 });
chrome.alarms.create("password-offer-cleanup", { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "password-offer-cleanup") {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, offer] of pendingPasswordOffers) {
      if (offer.createdAt < cutoff) pendingPasswordOffers.delete(id);
    }
  }
});

function publicOffer(offer) {
  if (!offer) return null;
  return {
    offerId: offer.offerId,
    origin: offer.origin,
    url: offer.url,
    username: offer.username,
    existingId: offer.existingId,
    showInline: true
  };
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

async function createPasswordOffer({ origin, url, username, password, tabId }) {
  const settings = await getSettings();
  if (settings.savePromptEnabled === false) return null;
  if (!password) return null;

  let existingId = null;
  let identical = false;
  try {
    const matches = await getPasswordsForOrigin(origin);
    const match = matches.find((item) => item.username === (username || ""));
    if (match) {
      existingId = match.id;
      identical = match.password === password;
    }
  } catch {
    // Still offer save even if listing fails (e.g. empty mount).
  }
  if (identical) return null;

  for (const offer of pendingPasswordOffers.values()) {
    if (
      offer.origin === origin &&
      offer.username === (username || "") &&
      offer.password === password &&
      Date.now() - offer.createdAt < 30_000
    ) {
      return publicOffer(offer);
    }
  }

  const offerId = crypto.randomUUID();
  const notificationId = `save-password-${offerId}`;
  const offer = {
    offerId,
    origin,
    url: url || origin,
    username: username || "",
    password,
    existingId,
    tabId: tabId ?? null,
    notificationId,
    createdAt: Date.now()
  };
  pendingPasswordOffers.set(offerId, offer);

  try {
    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: existingId ? "Update password in OpenBao?" : "Save password to OpenBao?",
      message: `${username || "(no username)"}\n${origin}`,
      priority: 2,
      requireInteraction: true,
      buttons: [{ title: existingId ? "Update" : "Save" }, { title: "Not now" }]
    });
  } catch (err) {
    console.warn("Password save notification failed", err);
  }

  return publicOffer(offer);
}

async function confirmPasswordOffer(offerId) {
  const offer = pendingPasswordOffers.get(offerId);
  if (!offer) throw new Error("Save offer expired");
  pendingPasswordOffers.delete(offerId);
  if (offer.notificationId) {
    try {
      await chrome.notifications.clear(offer.notificationId);
    } catch {
      // ignore
    }
  }
  return savePassword({
    id: offer.existingId || undefined,
    origin: offer.origin,
    url: offer.url,
    username: offer.username,
    password: offer.password
  });
}

async function dismissPasswordOffer(offerId) {
  const offer = pendingPasswordOffers.get(offerId);
  if (!offer) return { ok: true };
  pendingPasswordOffers.delete(offerId);
  if (offer.notificationId) {
    try {
      await chrome.notifications.clear(offer.notificationId);
    } catch {
      // ignore
    }
  }
  return { ok: true };
}

function findOfferByNotification(notificationId) {
  for (const offer of pendingPasswordOffers.values()) {
    if (offer.notificationId === notificationId) return offer;
  }
  return null;
}

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  const offer = findOfferByNotification(notificationId);
  if (!offer) return;
  if (buttonIndex === 0) {
    confirmPasswordOffer(offer.offerId).catch((err) => {
      console.warn("Failed confirming password save", err);
      notify("OpenBao Passkeys", err.message || "Could not save password");
    });
  } else {
    dismissPasswordOffer(offer.offerId);
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const offer = findOfferByNotification(notificationId);
  if (!offer) return;
  confirmPasswordOffer(offer.offerId).catch((err) => {
    console.warn("Failed confirming password save", err);
  });
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "get-settings":
        return getSettings();
      case "save-settings":
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
      case "list-passwords":
        return listPasswords();
      case "get-password": {
        const record = await getPassword(message.id);
        if (!record) throw new Error("Password not found");
        return record;
      }
      case "passwords-for-origin":
        return getPasswordsForOrigin(message.origin);
      case "save-password":
        return savePassword({
          id: message.id,
          origin: message.origin,
          url: message.url,
          username: message.username,
          password: message.password,
          notes: message.notes
        });
      case "offer-save-password":
        return createPasswordOffer({
          origin: message.origin,
          url: message.url,
          username: message.username,
          password: message.password,
          tabId: sender.tab?.id ?? null
        });
      case "get-pending-save": {
        const origin = message.origin;
        const tabId = sender.tab?.id;
        let best = null;
        for (const offer of pendingPasswordOffers.values()) {
          if (origin && offer.origin !== origin) continue;
          if (tabId != null && offer.tabId != null && offer.tabId !== tabId) continue;
          if (!best || offer.createdAt > best.createdAt) best = offer;
        }
        return publicOffer(best);
      }
      case "confirm-save-password":
        return confirmPasswordOffer(message.offerId);
      case "dismiss-save-password":
        return dismissPasswordOffer(message.offerId);
      case "delete-password":
        await deletePassword(message.id);
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
