# OpenBao Passkeys

Chrome extension (Manifest V3) that acts as a software passkey authenticator and stores credential material in [OpenBao](https://openbao.org/) KV v2.

## What it does

- Creates ES256 passkeys and stores the private key (JWK) plus WebAuthn metadata in OpenBao
- Signs assertions for stored credentials
- Lists / deletes passkeys from a popup manager
- Optionally attaches Chrome’s `webAuthenticationProxy` so site `navigator.credentials.create()` / `.get()` calls are handled by this extension (with an approval prompt)

When the proxy is **off**, the browser uses normal platform/security-key authenticators. Turn the proxy **on** only when you want OpenBao-backed passkeys to answer WebAuthn prompts.

## Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this directory

## Configure OpenBao

1. Click the extension → **OpenBao settings**
2. Set URL (default `http://127.0.0.1:8200`), auth method, KV mount, and path prefix
3. **Test connection**, then **Save**

### Minimal local OpenBao (dev)

```bash
docker run --rm -p 8200:8200 -e BAO_DEV_ROOT_TOKEN_ID=root openbao/openbao:latest server -dev -dev-listen-address=0.0.0.0:8200
```

Then in another shell:

```bash
export BAO_ADDR=http://127.0.0.1:8200
export BAO_TOKEN=root
bao secrets enable -path=secret kv-v2   # often already enabled in -dev
```

In the extension settings:

- URL: `http://127.0.0.1:8200`
- Auth: Token → `root`
- KV mount: `secret`
- Path prefix: `passkeys`

Secrets land at `secret/data/passkeys/<credentialId>`.

## Usage

1. Connect OpenBao and confirm **Test connection** succeeds
2. In the popup, enable **Intercept WebAuthn**
3. On a site that registers a passkey, approve the extension prompt
4. Later sign-ins for that RP will list matching OpenBao credentials

## Security notes

- Private keys live in OpenBao; the extension fetches them to sign and writes back `signCount`
- Prefer AppRole (or a narrowly scoped token) over a root token outside local testing
- Proxy mode suspends normal browser WebAuthn handling while attached — detach when finished
- This is an MVP software authenticator (`attestation: none`), not a certified hardware authenticator

## Layout

```
manifest.json
src/
  background/service-worker.js
  lib/          # OpenBao client, WebAuthn crypto, settings
  popup/        # credential list + proxy toggle
  options/      # OpenBao connection
  approve/      # create/get consent UI
icons/
```
