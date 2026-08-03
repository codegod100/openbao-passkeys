(() => {
  if (window.__openbaoPasswordsInjected) return;
  window.__openbaoPasswordsInjected = true;
  try {
    document.documentElement.setAttribute("data-openbao-passwords", "1");
  } catch {
    // ignore
  }

  const ROOT_ID = "openbao-passwords-root";
  let dropdown = null;
  let saveBar = null;
  let activeField = null;
  let cachedCreds = null;
  let cachedOrigin = location.origin;
  let lastSeenLogin = { username: "", password: "", at: 0 };
  let offerInFlight = false;
  let loginAttemptedAt = 0;

  function send(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Request failed"));
          return;
        }
        resolve(response.result);
      });
    });
  }

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.style.all = "initial";
    root.style.position = "fixed";
    root.style.zIndex = "2147483646";
    root.style.top = "0";
    root.style.left = "0";
    root.style.width = "0";
    root.style.height = "0";
    (document.documentElement || document.body).appendChild(root);
    return root;
  }

  function fieldHaystack(el) {
    return [
      el.name,
      el.id,
      el.autocomplete,
      el.placeholder,
      el.getAttribute("aria-label"),
      el.getAttribute("data-testid"),
      el.getAttribute("textcontenttype")
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function isUsernameField(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    if (el.disabled || el.readOnly) return false;
    if (isPasswordField(el)) return false;
    if (el.type === "hidden") return false;
    const type = (el.type || "text").toLowerCase();
    if (!["text", "email", "tel", "url", "search"].includes(type)) return false;
    const hay = fieldHaystack(el);
    return (
      /user|email|login|account|phone|identifier|member|screen.?name|handle/.test(hay) ||
      el.autocomplete === "username" ||
      el.autocomplete === "email" ||
      el.getAttribute("data-testid") === "loginUsernameInput"
    );
  }

  function isPasswordField(el) {
    if (!(el instanceof HTMLInputElement) || el.disabled) return false;
    const type = (el.type || "").toLowerCase();
    const hay = fieldHaystack(el);
    const auto = (el.autocomplete || "").toLowerCase();
    // Bluesky / RN Web: type=password normally; becomes text when "reveal" is on.
    if (type === "password") return true;
    if (auto === "current-password" || auto === "new-password") return true;
    if (el.getAttribute("data-testid") === "loginPasswordInput") return true;
    if (/^(password|current password|new password)$/i.test(el.getAttribute("aria-label") || "")) {
      return type === "text" || type === "password";
    }
    if (/password/.test(hay) && (type === "text" || type === "password")) return true;
    return false;
  }

  function allPasswordFields(root = document) {
    return [...root.querySelectorAll("input")].filter(isPasswordField);
  }

  function nearestUsername(passwordInput, root) {
    const scope = root || passwordInput?.form || document;
    const inputs = [...scope.querySelectorAll("input")];
    const named = inputs.filter(isUsernameField);
    if (named.length) {
      if (!passwordInput) return named[0];
      const before = named.filter((el) => {
        const pos = passwordInput.compareDocumentPosition(el);
        return pos & Node.DOCUMENT_POSITION_PRECEDING;
      });
      return before.at(-1) || named[0];
    }

    // Fallback: text-like input preceding the password field.
    if (!passwordInput) return null;
    const idx = inputs.indexOf(passwordInput);
    for (let i = idx - 1; i >= 0; i--) {
      const el = inputs[i];
      if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) continue;
      if (isPasswordField(el)) continue;
      const type = (el.type || "text").toLowerCase();
      if (["text", "email", "tel", "url", "search"].includes(type)) return el;
    }
    return null;
  }

  function findLoginForm(fromEl) {
    const form = fromEl?.form || fromEl?.closest?.("form") || null;
    const scoped = form ? allPasswordFields(form) : [];
    const password =
      (fromEl && isPasswordField(fromEl) && fromEl) ||
      scoped[0] ||
      allPasswordFields(document)[0] ||
      null;
    if (!password) return null;
    const username = nearestUsername(password, form || document);
    return { form, password, username };
  }

  function snapshotLogin(login) {
    if (!login?.password) return null;
    const username = login.username?.value?.trim?.() || lastSeenLogin.username || "";
    const password = login.password.value || lastSeenLogin.password || "";
    if (!password) return null;
    lastSeenLogin = { username, password, at: Date.now() };
    return { username, password };
  }

  function rememberField(el) {
    if (isPasswordField(el) && el.value) {
      lastSeenLogin = { ...lastSeenLogin, password: el.value, at: Date.now() };
    }
    if (isUsernameField(el) && el.value) {
      lastSeenLogin = { ...lastSeenLogin, username: el.value.trim(), at: Date.now() };
    }
  }

  function setNativeValue(input, value) {
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    proto?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillCredential(cred, target) {
    const login = findLoginForm(target) || { username: null, password: target };
    if (login.username) setNativeValue(login.username, cred.username || "");
    if (login.password) setNativeValue(login.password, cred.password || "");
    hideDropdown();
  }

  async function loadCreds() {
    if (cachedCreds && cachedOrigin === location.origin) return cachedCreds;
    const result = await send("passwords-for-origin", { origin: location.origin });
    cachedCreds = result || [];
    cachedOrigin = location.origin;
    return cachedCreds;
  }

  function hideDropdown() {
    dropdown?.remove();
    dropdown = null;
    activeField = null;
  }

  function positionNear(el, panel) {
    const rect = el.getBoundingClientRect();
    panel.style.position = "fixed";
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 280))}px`;
    panel.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 12)}px`;
    panel.style.width = `${Math.max(rect.width, 260)}px`;
  }

  async function showDropdown(field) {
    const settings = await send("get-settings").catch(() => null);
    if (settings && settings.autofillEnabled === false) return;

    let creds = [];
    try {
      creds = await loadCreds();
    } catch {
      return;
    }
    if (!creds.length) return;

    hideDropdown();
    activeField = field;
    const root = ensureRoot();
    dropdown = document.createElement("div");
    dropdown.setAttribute("data-openbao", "dropdown");
    Object.assign(dropdown.style, {
      background: "#fff",
      color: "#152028",
      border: "1px solid #d5dee5",
      borderRadius: "12px",
      boxShadow: "0 12px 30px rgba(21,32,40,0.18)",
      fontFamily: "Segoe UI, Helvetica Neue, sans-serif",
      fontSize: "13px",
      overflow: "hidden",
      maxHeight: "240px",
      overflowY: "auto"
    });

    const header = document.createElement("div");
    header.textContent = "OpenBao passwords";
    Object.assign(header.style, {
      padding: "8px 12px",
      fontWeight: "600",
      borderBottom: "1px solid #e6edf2",
      color: "#0f766e"
    });
    dropdown.appendChild(header);

    for (const cred of creds) {
      const row = document.createElement("button");
      row.type = "button";
      Object.assign(row.style, {
        display: "block",
        width: "100%",
        textAlign: "left",
        border: "0",
        background: "transparent",
        padding: "10px 12px",
        cursor: "pointer",
        font: "inherit",
        color: "inherit"
      });
      row.innerHTML = `<strong style="display:block">${escapeHtml(cred.username || "(no username)")}</strong>
        <span style="color:#5b6b76;font-size:12px">${escapeHtml(cred.origin || "")}</span>`;
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        fillCredential(cred, field);
      });
      row.addEventListener("mouseenter", () => {
        row.style.background = "#f3f6f8";
      });
      row.addEventListener("mouseleave", () => {
        row.style.background = "transparent";
      });
      dropdown.appendChild(row);
    }

    root.appendChild(dropdown);
    positionNear(field, dropdown);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function hideSaveBar() {
    saveBar?.remove();
    saveBar = null;
  }

  function showSaveBar(offer) {
    hideSaveBar();
    hideDropdown();
    const root = ensureRoot();
    saveBar = document.createElement("div");
    saveBar.setAttribute("data-openbao", "save-bar");
    Object.assign(saveBar.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      width: "340px",
      background: "#fff",
      color: "#152028",
      border: "1px solid #d5dee5",
      borderRadius: "14px",
      boxShadow: "0 16px 40px rgba(21,32,40,0.2)",
      fontFamily: "Segoe UI, Helvetica Neue, sans-serif",
      padding: "14px",
      zIndex: "2147483647"
    });

    const title = offer.existingId ? "Update password in OpenBao?" : "Save password to OpenBao?";
    saveBar.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px;color:#0f766e">${escapeHtml(title)}</div>
      <div style="font-size:13px;color:#5b6b76;margin-bottom:10px;word-break:break-all">
        ${escapeHtml(offer.username || "(no username)")}<br/>${escapeHtml(offer.origin || location.origin)}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"></div>
    `;

    const actions = saveBar.lastElementChild;
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = offer.existingId ? "Update" : "Save";
    Object.assign(saveBtn.style, {
      border: "0",
      borderRadius: "999px",
      padding: "8px 14px",
      background: "#0f766e",
      color: "#fff",
      fontWeight: "600",
      cursor: "pointer"
    });
    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.textContent = "Not now";
    Object.assign(dismissBtn.style, {
      border: "1px solid #d5dee5",
      borderRadius: "999px",
      padding: "8px 14px",
      background: "transparent",
      cursor: "pointer"
    });

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      dismissBtn.disabled = true;
      try {
        await send("confirm-save-password", { offerId: offer.offerId });
        cachedCreds = null;
        hideSaveBar();
      } catch (err) {
        saveBtn.disabled = false;
        dismissBtn.disabled = false;
        saveBtn.textContent = "Retry";
        saveBtn.title = err.message;
      }
    });
    dismissBtn.addEventListener("click", async () => {
      try {
        await send("dismiss-save-password", { offerId: offer.offerId });
      } catch {
        // ignore
      }
      hideSaveBar();
    });

    actions.append(saveBtn, dismissBtn);
    root.appendChild(saveBar);
  }

  async function offerSave(login) {
    const snap = snapshotLogin(login);
    if (!snap?.password || offerInFlight) return;
    offerInFlight = true;
    try {
      const offer = await send("offer-save-password", {
        origin: location.origin,
        url: location.href,
        username: snap.username,
        password: snap.password
      });
      if (offer?.showInline) showSaveBar(offer);
    } catch {
      // OpenBao may be unconfigured; stay quiet on pages.
    } finally {
      setTimeout(() => {
        offerInFlight = false;
      }, 800);
    }
  }

  async function restorePendingOffer() {
    try {
      const offer = await send("get-pending-save", { origin: location.origin });
      if (offer?.showInline) showSaveBar(offer);
    } catch {
      // ignore
    }
  }

  document.addEventListener(
    "focusin",
    (event) => {
      const el = event.target;
      rememberField(el);
      if (isPasswordField(el) || isUsernameField(el)) showDropdown(el);
    },
    true
  );

  document.addEventListener(
    "input",
    (event) => {
      rememberField(event.target);
    },
    true
  );

  document.addEventListener(
    "change",
    (event) => {
      rememberField(event.target);
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      if (!dropdown) return;
      if (event.target === activeField) return;
      if (dropdown.contains(event.target)) return;
      hideDropdown();
    },
    true
  );

  window.addEventListener("resize", () => {
    if (dropdown && activeField) positionNear(activeField, dropdown);
  });

  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const login = findLoginForm(form.querySelector("input") || form);
      offerSave(login);
    },
    true
  );

  function looksLikeLoginAction(el) {
    if (!el || el.closest?.("[data-openbao]")) return false;
    const label = `${el.textContent || ""} ${el.value || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""}`;
    return /log.?in|sign.?in|sign.?up|continue|submit|next|create.?account|register/i.test(label);
  }

  function maybeOfferFromEventTarget(target) {
    const btn =
      target?.closest?.("button, input[type='submit'], [role='button'], a, div[tabindex], span[role='button']") ||
      null;
    if (btn && looksLikeLoginAction(btn)) {
      const login = findLoginForm(btn);
      if (snapshotLogin(login)) {
        loginAttemptedAt = Date.now();
        offerSave(login);
      }
      return;
    }

    // Bluesky RN pressables can fire on a child node without the Sign in label.
    if (!btn) return;
    const hasSignIn = [...document.querySelectorAll("button, [role='button']")].some(looksLikeLoginAction);
    if (!hasSignIn) return;
    const login = findLoginForm(btn);
    // Only offer if we already captured a password recently (user is on a login form).
    if (!lastSeenLogin.password || Date.now() - lastSeenLogin.at > 60_000) return;
    if (snapshotLogin(login)) {
      loginAttemptedAt = Date.now();
      offerSave(login);
    }
  }

  document.addEventListener(
    "pointerdown",
    (event) => {
      maybeOfferFromEventTarget(event.target);
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      maybeOfferFromEventTarget(event.target);
    },
    true
  );

  // Bluesky uses Enter on the password field (returnKeyType="done") instead of form submit.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter") return;
      const el = event.target;
      if (!isPasswordField(el) && !isUsernameField(el)) return;
      rememberField(el);
      const login = findLoginForm(el);
      if (snapshotLogin(login)) {
        loginAttemptedAt = Date.now();
        offerSave(login);
      }
    },
    true
  );

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", restorePendingOffer, { once: true });
  } else {
    restorePendingOffer();
  }
})();
