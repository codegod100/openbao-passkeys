import { completeOidcCallback } from "../lib/openbao.js";
import { getSettings } from "../lib/settings.js";

const status = document.getElementById("status");
const lead = document.getElementById("lead");

function setError(message) {
  lead.textContent = "Sign-in failed";
  status.textContent = message;
  status.className = "status err";
}

function setOk(message) {
  lead.textContent = "Signed in";
  status.textContent = message;
  status.className = "status ok";
}

try {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  const errorDescription = params.get("error_description");
  if (error) {
    setError(errorDescription || error);
  } else {
    const code = params.get("code");
    const state = params.get("state");
    const idToken = params.get("id_token");
    if (!code && !idToken) {
      setError("Missing authorization code in OIDC callback.");
    } else {
      const settings = await getSettings();
      const clientNonce = settings.oidcPending?.clientNonce || "";
      await completeOidcCallback({
        code,
        state,
        idToken,
        clientNonce,
        settings
      });
      setOk("OpenBao token stored. You can close this tab and return to settings.");
    }
  }
} catch (err) {
  setError(err.message || String(err));
}
