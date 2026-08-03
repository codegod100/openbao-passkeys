const B64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function bufferToBase64Url(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBuffer(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function concatBuffers(...parts) {
  const arrays = parts.map((part) =>
    part instanceof ArrayBuffer ? new Uint8Array(part) : new Uint8Array(part.buffer, part.byteOffset, part.byteLength)
  );
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out.buffer;
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function utf8Encode(text) {
  return new TextEncoder().encode(text);
}

export async function sha256(data) {
  return crypto.subtle.digest("SHA-256", data);
}

/** Minimal CBOR encoder for WebAuthn attestation objects. */
export function encodeCbor(value) {
  const chunks = [];

  function pushUint8(n) {
    chunks.push(Uint8Array.of(n));
  }

  function pushBytes(bytes) {
    chunks.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  function writeTypeAndLength(major, length) {
    if (length < 24) {
      pushUint8((major << 5) | length);
    } else if (length < 0x100) {
      pushUint8((major << 5) | 24);
      pushUint8(length);
    } else if (length < 0x10000) {
      pushUint8((major << 5) | 25);
      pushBytes(Uint8Array.of((length >> 8) & 0xff, length & 0xff));
    } else {
      pushUint8((major << 5) | 26);
      pushBytes(
        Uint8Array.of(
          (length >>> 24) & 0xff,
          (length >>> 16) & 0xff,
          (length >>> 8) & 0xff,
          length & 0xff
        )
      );
    }
  }

  function write(v) {
    if (v === null) {
      pushUint8(0xf6);
      return;
    }
    if (typeof v === "number") {
      if (!Number.isInteger(v)) throw new Error("CBOR floats not supported");
      if (v >= 0) {
        writeTypeAndLength(0, v);
      } else {
        writeTypeAndLength(1, -1 - v);
      }
      return;
    }
    if (typeof v === "string") {
      const bytes = utf8Encode(v);
      writeTypeAndLength(3, bytes.length);
      pushBytes(bytes);
      return;
    }
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      const bytes = v instanceof Uint8Array ? v : new Uint8Array(v);
      writeTypeAndLength(2, bytes.length);
      pushBytes(bytes);
      return;
    }
    if (Array.isArray(v)) {
      writeTypeAndLength(4, v.length);
      for (const item of v) write(item);
      return;
    }
    if (v instanceof Map) {
      writeTypeAndLength(5, v.size);
      for (const [key, val] of v) {
        write(key);
        write(val);
      }
      return;
    }
    if (typeof v === "object") {
      const keys = Object.keys(v);
      writeTypeAndLength(5, keys.length);
      for (const key of keys) {
        write(key);
        write(v[key]);
      }
      return;
    }
    throw new Error(`Unsupported CBOR type: ${typeof v}`);
  }

  write(value);
  return concatBuffers(...chunks);
}

export { B64URL_ALPHABET };
