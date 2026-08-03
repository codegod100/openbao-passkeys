import { deleteKvRecord, getKvRecord, listKvKeys, putKvRecord } from "./openbao.js";
import { getSettings } from "./settings.js";

function passwordPrefix(settings) {
  return settings.passwordPathPrefix || "passwords";
}

export function publicPasswordView(record) {
  if (!record) return null;
  const { password, ...rest } = record;
  return { ...rest, hasPassword: true };
}

export async function listPasswords() {
  const settings = await getSettings();
  const prefix = passwordPrefix(settings);
  const keys = await listKvKeys(prefix);
  const items = [];
  for (const id of keys) {
    try {
      const record = await getKvRecord(prefix, id);
      if (record) items.push(publicPasswordView(record));
    } catch {
      // skip
    }
  }
  return items.sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""));
}

export async function getPassword(id) {
  const settings = await getSettings();
  return getKvRecord(passwordPrefix(settings), id);
}

export async function findPasswordsForOrigin(origin) {
  const all = await listPasswords();
  const host = safeHost(origin);
  return all.filter((item) => item.origin === origin || item.host === host);
}

export async function getPasswordsForOrigin(origin) {
  const settings = await getSettings();
  const prefix = passwordPrefix(settings);
  const matches = await findPasswordsForOrigin(origin);
  const full = [];
  for (const item of matches) {
    try {
      const record = await getKvRecord(prefix, item.id);
      if (record) full.push(record);
    } catch {
      // skip
    }
  }
  return full;
}

export async function savePassword({ id, origin, url, username, password, notes }) {
  const settings = await getSettings();
  const prefix = passwordPrefix(settings);
  const now = new Date().toISOString();
  const host = safeHost(origin);

  let recordId = id;
  if (!recordId) {
    const existing = (await findPasswordsForOrigin(origin)).find(
      (item) => item.username === username
    );
    recordId = existing?.id || crypto.randomUUID();
  }

  let createdAt = now;
  try {
    const previous = await getKvRecord(prefix, recordId);
    if (previous?.createdAt) createdAt = previous.createdAt;
  } catch {
    // new
  }

  const record = {
    id: recordId,
    origin,
    host,
    url: url || origin,
    username: username || "",
    password: password || "",
    notes: notes || "",
    createdAt,
    updatedAt: now
  };

  await putKvRecord(prefix, recordId, record);
  return publicPasswordView(record);
}

export async function deletePassword(id) {
  const settings = await getSettings();
  await deleteKvRecord(passwordPrefix(settings), id);
}

function safeHost(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}
