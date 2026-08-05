# OpenBao Passkeys

Chrome extension (Manifest V3) that stores **passkeys** and **passwords** in [OpenBao](https://openbao.org/) KV v2.

## Features

- **Passkeys** — ES256 software authenticator; private keys live in OpenBao
- **WebAuthn proxy** — optional `webAuthenticationProxy` so site create/get prompts are handled here
- **Passwords** — save / list / delete logins in OpenBao
- **Autofill** — content script offers matching logins on username/password fields
- **Save prompt** — after form submit / login button, offers to store the credentials
- **Auth** — token, AppRole, or OIDC (JWT/OIDC auth method)

## Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this directory
4. Accept site access (needed for autofill on `http(s)` pages)

## Configure OpenBao

1. Extension popup → **OpenBao settings**
2. Set URL, auth (token, AppRole, or OIDC), KV mount, path prefixes
3. **Test connection**, then **Save**

Defaults:

| Kind | Path |
|------|------|
| Passkeys | `secret/data/passkeys/<credentialId>` |
| Passwords | `secret/data/passwords/<id>` |

### Minimal local OpenBao (dev)

```bash
docker run --rm -p 8200:8200 -e BAO_DEV_ROOT_TOKEN_ID=root openbao/openbao:latest server -dev -dev-listen-address=0.0.0.0:8200
```

Extension settings: URL `http://127.0.0.1:8200`, token `root`, mount `secret`.

### OIDC

Uses OpenBao’s [JWT/OIDC auth method](https://openbao.org/docs/auth/jwt/).

1. Enable and configure the mount (often `oidc` or `jwt`) and an OIDC role on OpenBao
2. In extension settings: auth method **OIDC**, mount path, and role name
3. Add the extension callback URL to the role’s `allowed_redirect_uris` **and** your IdP:

   `chrome-extension://<extension-id>/src/oidc/callback.html`

   Copy it from the settings page after loading the extension (the ID is stable for a given install path).
4. Click **Sign in with OIDC** (or **Test connection**, which starts sign-in if needed)

Callback modes:

| OpenBao role `callback_mode` | Extension behavior |
|------------------------------|--------------------|
| `client` (default) | IdP redirects to the extension callback page; code is exchanged via `oidc/callback` |
| `direct` | Set redirect URI override to `<openbao-url>/v1/auth/<mount>/oidc/callback`; extension polls `oidc/poll` |
| `device` | Shows/uses the device user code; extension polls `oidc/poll` |

Prefer **direct** or **device** if your IdP rejects `chrome-extension://` redirect URIs.

Cached OpenBao tokens are renewed with `auth/token/renew-self` when possible; use **Sign out** to revoke.

## Usage

### Passkeys

1. Enable **Intercept WebAuthn** in the popup
2. Register / authenticate on a site (e.g. webauthn.io) and approve the prompt

### Passwords

1. Log in on a site → click **Save** on the OpenBao prompt, **or** add one from the popup **Passwords** tab
2. Focus a login field → choose a saved credential from the dropdown

Autofill and save prompts can be toggled in settings.

## Security notes

- Secrets are fetched from OpenBao when needed; passkey private keys and passwords are not mirrored into `chrome.storage`
- Prefer AppRole, OIDC, or a narrowly scoped token outside local testing
- WebAuthn proxy suspends normal browser passkey handling while attached
- Autofill runs in page context for the current origin only

## Layout

```
manifest.json
src/
  background/service-worker.js
  content/autofill.js
  lib/          # OpenBao client, WebAuthn, passwords, settings
  popup/        # passkeys + passwords manager
  options/      # OpenBao connection
  oidc/         # OIDC client-callback page
  approve/      # WebAuthn consent UI
icons/
```
