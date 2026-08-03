async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Request failed");
  return response.result;
}

const params = new URLSearchParams(location.search);
const requestId = Number(params.get("requestId"));
const details = document.getElementById("details");
const choices = document.getElementById("choices");
const status = document.getElementById("status");
const title = document.getElementById("title");
const approveBtn = document.getElementById("approveBtn");
const denyBtn = document.getElementById("denyBtn");

let pending = null;
let selectedCredentialId = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function render() {
  if (!pending) {
    details.innerHTML = `<p class="muted">This request is no longer available.</p>`;
    approveBtn.disabled = true;
    return;
  }

  const s = pending.summary;
  if (pending.kind === "create") {
    title.textContent = "Create passkey";
    details.innerHTML = `
      <p><strong>${escapeHtml(s.rpName || s.rpId)}</strong></p>
      <span class="muted">${escapeHtml(s.rpId)}</span>
      <p style="margin-top:8px">Account: <strong>${escapeHtml(s.userDisplayName || s.userName)}</strong></p>
      <p class="muted">${escapeHtml(s.userName || "")}</p>
      <p class="muted" style="margin-top:8px">Origin: ${escapeHtml(s.origin || "unknown")}</p>
      <p class="muted">Private key will be stored in OpenBao.</p>
    `;
  } else {
    title.textContent = "Use passkey";
    details.innerHTML = `
      <p><strong>${escapeHtml(s.rpId)}</strong></p>
      <p class="muted">Origin: ${escapeHtml(s.origin || "unknown")}</p>
    `;
    const candidates = s.candidates || [];
    if (!candidates.length) {
      choices.innerHTML = `<p class="status err">No matching passkeys found in OpenBao for this RP.</p>`;
      approveBtn.disabled = true;
      return;
    }
    choices.innerHTML = "";
    for (const cred of candidates) {
      const label = document.createElement("label");
      label.className = "item";
      label.style.display = "flex";
      label.style.gap = "10px";
      label.style.alignItems = "flex-start";
      label.innerHTML = `
        <input type="radio" name="cred" value="${escapeHtml(cred.credentialId)}" />
        <span>
          <strong>${escapeHtml(cred.userDisplayName || cred.userName)}</strong>
          <span>${escapeHtml(cred.userName || "")}</span>
          <span>${escapeHtml(cred.credentialId)}</span>
        </span>
      `;
      choices.appendChild(label);
    }
    const first = choices.querySelector('input[type="radio"]');
    if (first) {
      first.checked = true;
      selectedCredentialId = first.value;
    }
    choices.addEventListener("change", (event) => {
      if (event.target.name === "cred") selectedCredentialId = event.target.value;
    });
  }
}

approveBtn.addEventListener("click", async () => {
  approveBtn.disabled = true;
  denyBtn.disabled = true;
  status.textContent = "Working…";
  try {
    if (pending.kind === "create") {
      await send("approve-create", { requestId });
    } else {
      await send("approve-get", { requestId, credentialId: selectedCredentialId });
    }
    status.textContent = "Done.";
    status.className = "status ok";
    setTimeout(() => window.close(), 400);
  } catch (err) {
    status.textContent = err.message;
    status.className = "status err";
    approveBtn.disabled = false;
    denyBtn.disabled = false;
  }
});

denyBtn.addEventListener("click", async () => {
  approveBtn.disabled = true;
  denyBtn.disabled = true;
  try {
    if (pending?.kind === "create") await send("deny-create", { requestId });
    else await send("deny-get", { requestId });
  } finally {
    window.close();
  }
});

pending = await send("get-pending", { requestId });
render();
