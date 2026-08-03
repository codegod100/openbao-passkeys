# OpenBao Passkeys

Chrome extension (Manifest V3) that stores **passkeys** and **passwords** in [OpenBao](https://openbao.org/) KV v2.

## Features

- **Passkeys** — ES256 software authenticator; private keys live in OpenBao
- **WebAuthn proxy** — optional `webAuthenticationProxy` so site create/get prompts are handled here
- **Passwords** — save / list / delete logins in OpenBao
- **Autofill** — content script offers matching logins on username/password fields
- **Save prompt** — after form submit / login button, offers to store the credentials

## Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this directory
4. Accept site access (needed for autofill on `http(s)` pages)

## Configure OpenBao

1. Extension popup → **OpenBao settings**
2. Set URL, auth (token or AppRole), KV mount, path prefixes
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
- Prefer AppRole or a narrowly scoped token outside local testing
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
  approve/      # WebAuthn consent UI
icons/
```
