#!/usr/bin/env bash
# Idempotent Cloud Agent setup for the OpenBao Passkeys Chrome extension.
#
# The extension itself is plain JavaScript loaded unpacked into Chrome, so there
# is nothing to compile or bundle. The one runtime dependency for an end-to-end
# development flow is an OpenBao server (the KV backend the extension talks to),
# so this script installs the `bao` binary. Chrome is already provided by the
# base image.
set -euo pipefail

OPENBAO_VERSION="2.6.1"
BIN_DIR="/usr/local/bin"

install_openbao() {
  local tmp url
  tmp="$(mktemp -d)"
  url="https://github.com/openbao/openbao/releases/download/v${OPENBAO_VERSION}/openbao_${OPENBAO_VERSION}_linux_amd64.tar.gz"
  echo "Installing OpenBao ${OPENBAO_VERSION} from ${url}"
  curl -fsSL "$url" -o "$tmp/openbao.tar.gz"
  tar -xzf "$tmp/openbao.tar.gz" -C "$tmp" bao
  sudo install -m 0755 "$tmp/bao" "${BIN_DIR}/bao"
  rm -rf "$tmp"
}

if command -v bao >/dev/null 2>&1 && bao version 2>/dev/null | grep -q "v${OPENBAO_VERSION}"; then
  echo "OpenBao ${OPENBAO_VERSION} already installed: $(bao version | head -n1)"
else
  install_openbao
fi

echo "bao: $(bao version | head -n1)"
echo "chrome: $(google-chrome --version 2>/dev/null || echo 'not found')"

# Sanity check the extension source is present.
test -f manifest.json
echo "manifest.json present (extension v$(jq -r .version manifest.json))"

echo "Cloud Agent install complete."
