"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { beforeUserCreated } = require("firebase-functions/v2/identity");
const logger = require("firebase-functions/logger");
const crypto = require("crypto");
const { parseKey, generateKey, formatDisplay } = require("./zbtFormat");
const {
  ROLES,
  normalizeEmail,
  requireStaff,
  requireOwner,
  applyStaffClaims,
  applyZbtClaim,
} = require("./staff");
const {
  assertCatalogItemAvailable,
  getCoinPrice,
  listGrantedItemIds,
  normalizeRequestId,
  selectWeightedDrop,
} = require("./shopEconomy");

initializeApp({ databaseURL: "https://furry-launcher-default-rtdb.europe-west1.firebasedatabase.app" });
const adminAuth = getAuth();
const rtdb = getDatabase();
const db = getFirestore();
const REGION = "europe-west1";
const MAX_SEATS = 500;
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

const callOpts = { region: REGION, cors: true };
const staffOpts = { region: REGION, cors: true };

function now() {
  return Date.now();
}

function clientIp(request) {
  return request.rawRequest?.ip || request.rawRequest?.headers?.["x-forwarded-for"] || "unknown";
}

async function hitRateLimit(uid, ip) {
  const keys = [
    ...(uid ? [`redeem_uid_${uid}`] : []),
    `redeem_ip_${crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 32)}`,
  ];
  const t = now();
  for (const id of keys) {
    const ref = db.doc(`rateLimits/${id}`);
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};
    const windowStart = data.windowStart || 0;
    const fails = t - windowStart > FAIL_WINDOW_MS ? 0 : (data.fails || 0);
    if (fails >= FAIL_LIMIT) throw new HttpsError("resource-exhausted", "Слишком много попыток. Подождите 15 минут.");
  }
}

async function recordFail(uid, ip) {
  const t = now();
  const keys = [
    ...(uid ? [`redeem_uid_${uid}`] : []),
    `redeem_ip_${crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 32)}`,
  ];
  for (const id of keys) {
    const ref = db.doc(`rateLimits/${id}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : {};
      const windowStart = data.windowStart || 0;
      const fresh = t - windowStart > FAIL_WINDOW_MS;
      tx.set(ref, {
        windowStart: fresh ? t : windowStart || t,
        fails: (fresh ? 0 : data.fails || 0) + 1,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  }
}

async function audit(actorUid, action, payload) {
  await db.collection("auditLog").add({ actorUid: actorUid || "system", action, payload: payload || {}, at: FieldValue.serverTimestamp() });
}

function sanitizeDeviceSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const processors = Number(value.logicalProcessors);
  return {
    os: String(value.os || "unknown").slice(0, 128),
    architecture: String(value.architecture || "unknown").slice(0, 24),
    ramBucket: String(value.ramBucket || "unknown").slice(0, 16),
    logicalProcessors: Number.isInteger(processors) ? Math.min(Math.max(processors, 1), 256) : null,
  };
}

async function findFlRtdbKey(compact) {
  const hash = crypto.createHash("sha256").update(compact, "utf8").digest("hex");
  const display = `${compact.slice(0, 2)}-${compact.slice(2, 6)}-${compact.slice(6, 10)}-${compact.slice(10)}`;
  const candidates = [`keys/${hash}`, `keys/${compact}`, `keys/${display}`, `zbtKeys/${hash}`, `zbtKeys/${compact}`];
  for (const path of candidates) {
    const ref = rtdb.ref(path);
    const snapshot = await ref.get();
    if (snapshot.exists()) return { ref, snapshot, path };
  }
  return null;
}

async function redeemFlRtdbKey(uid, compact, installId, nickname, minecraftUuid, email, device) {
  const found = await findFlRtdbKey(compact);
  if (!found) return null;
  const key = found.snapshot.val();
  if (!key || typeof key !== "object") throw new HttpsError("not-found", "Ключ не найден.");
  const initialStatus = String(key.status || "").toUpperCase();
  if (["REVOKED", "REVOKE", "DISABLED"].includes(initialStatus) || key.revoked === true) throw new HttpsError("failed-precondition", "Ключ отозван.");
  if (key.expiresAt && Number(key.expiresAt) < Date.now()) throw new HttpsError("failed-precondition", "Ключ истёк.");
  const campaignId = String(key.campaignId || "");
  if (!campaignId) throw new HttpsError("failed-precondition", "У ключа не найдена кампания ЗБТ.");
  const campaignSnapshot = await rtdb.ref(`zbtCampaigns/${campaignId}`).get();
  if (!campaignSnapshot.exists()) throw new HttpsError("failed-precondition", "Кампания ЗБТ не найдена.");
  const campaign = campaignSnapshot.val();
  if (campaign.status !== "ACTIVE") throw new HttpsError("failed-precondition", "Кампания ЗБТ не активна.");
  if (campaign.expiresAt && Number(campaign.expiresAt) < Date.now()) throw new HttpsError("failed-precondition", "Кампания ЗБТ истекла.");

  const activatedAt = Date.now();
  let alreadyActivated = false;
  const transaction = await found.ref.transaction((current) => {
    alreadyActivated = false;
    if (!current || ["REVOKED", "REVOKE", "DISABLED"].includes(String(current.status || "").toUpperCase()) || current.revoked === true) return;
    const owner = current.activatedBy || current.usedBy;
    const status = String(current.status || "").toUpperCase();
    const isUsed = ["ACTIVATED", "USED", "REDEEMED"].includes(status) || current.used === true || current.isUsed === true;
    if (isUsed) {
      if (current.installId === installId && ((!uid && !owner) || (uid && owner === uid) || (uid && !owner))) {
        alreadyActivated = true;
        return uid && !owner ? { ...current, activatedBy: uid, usedBy: uid } : current;
      }
      return;
    }
    if (status && !["UNUSED", "AVAILABLE", "ACTIVE", "NEW", "CREATED"].includes(status)) return;
    const updated = { ...current, status: "ACTIVATED", used: true, activatedByInstallId: installId, installId,
      nickname: nickname || null, minecraftUuid: minecraftUuid || null, activatedAt, usedAt: activatedAt };
    if (uid) { updated.activatedBy = uid; updated.usedBy = uid; }
    return updated;
  });

  const activatedKey = transaction.snapshot.val();
  if (!activatedKey) throw new HttpsError("not-found", "Ключ недоступен.");
  if (["REVOKED", "REVOKE", "DISABLED"].includes(String(activatedKey.status || "").toUpperCase()) || activatedKey.revoked === true)
    throw new HttpsError("failed-precondition", "Ключ отозван.");
  const activatedBy = activatedKey.activatedBy || activatedKey.usedBy;
  if ((uid && activatedBy !== uid) || (!uid && activatedBy) || activatedKey.installId !== installId)
    throw new HttpsError("already-exists", "Этот ключ уже использован.");

  const activationPath = uid ? `players/${uid}/zbt` : `zbtDeviceActivations/${installId}`;
  await rtdb.ref(activationPath).set({ key: compact, campaignId, installId, activatedAt, nickname: nickname || null, email: email || null, device });
  if (!alreadyActivated) await rtdb.ref(`zbtCampaigns/${campaignId}/activatedCount`).transaction((count) => Number(count || 0) + 1);
  if (uid) {
    await applyZbtClaim(uid, campaignId);
    await rtdb.ref(`players/${uid}`).update({ uid, nickname: nickname || null, email: email || null, minecraftUuid: minecraftUuid || null,
      lastSeenAt: activatedAt, zbtCampaignId: campaignId, installId, device });
  }
  await audit(uid, "zbt.redeem", { campaignId, installId, format: "FL" });
  return { ok: true, campaignId, already: alreadyActivated,
    message: alreadyActivated ? "Доступ ЗБТ уже есть." : "Ключ активирован. Добро пожаловать в ЗБТ." };
}

async function checkFlRtdbAccess(uid, installId) {
  const playerSnapshot = uid ? await rtdb.ref(`players/${uid}/zbt`).get() : null;
  const profileSnapshot = uid ? await rtdb.ref(`players/${uid}`).get() : null;
  const activationSnapshot = playerSnapshot?.exists() ? playerSnapshot : await rtdb.ref(`zbtDeviceActivations/${installId}`).get();
  if (!activationSnapshot.exists()) return null;
  const playerAccess = activationSnapshot.val();
  const parsed = parseKey(playerAccess.key);
  if (!parsed.ok || !parsed.compact.startsWith("FL")) return { ok: false, message: "Ключ ЗБТ недействителен. Обратитесь в поддержку." };
  const found = await findFlRtdbKey(parsed.compact);
  if (!found) return { ok: false, message: "Ключ ЗБТ не найден. Обратитесь в поддержку." };
  const key = found.snapshot.val();
  const owner = key?.activatedBy || key?.usedBy;
  if (key?.status === "REVOKED" || key?.revoked === true || (uid && owner && owner !== uid)) return { ok: false, message: "Ключ ЗБТ отозван или недействителен." };
  if (key.expiresAt && Number(key.expiresAt) < Date.now()) return { ok: false, message: "Срок действия ключа ЗБТ истёк." };
  if (playerAccess.installId !== installId || key.installId !== installId) return { ok: false, otherDevice: true, message: "Ключ привязан к другому устройству. Напишите в поддержку." };
  const campaignId = String(playerAccess.campaignId || key.campaignId || "");
  const campaignSnapshot = await rtdb.ref(`zbtCampaigns/${campaignId}`).get();
  if (!campaignSnapshot.exists()) return { ok: false, message: "Кампания ЗБТ не найдена." };
  const campaign = campaignSnapshot.val();
  if (campaign.status !== "ACTIVE" || (campaign.expiresAt && Number(campaign.expiresAt) < Date.now())) return { ok: false, message: "Кампания ЗБТ закрыта или истекла." };
  if (uid && !owner) {
    const transaction = await found.ref.transaction((current) => {
      const currentOwner = current?.activatedBy || current?.usedBy;
      if (!current || (currentOwner && currentOwner !== uid) || current.installId !== installId) return;
      return { ...current, activatedBy: uid, usedBy: uid };
    });
    const claimed = transaction.snapshot.val();
    if (!claimed || (claimed.activatedBy || claimed.usedBy) !== uid) return { ok: false, message: "Ключ ЗБТ привязан к другому аккаунту." };
    await rtdb.ref(`players/${uid}/zbt`).set({ ...playerAccess, campaignId });
    await rtdb.ref(`players/${uid}`).update({ uid, nickname: playerAccess.nickname || null, email: playerAccess.email || null,
      minecraftUuid: playerAccess.minecraftUuid || null, lastSeenAt: Date.now(), zbtCampaignId: campaignId, installId, device: playerAccess.device || null });
    await rtdb.ref(`zbtDeviceActivations/${installId}`).remove();
    await applyZbtClaim(uid, campaignId);
  } else if (uid && profileSnapshot.exists()) {
    await rtdb.ref(`players/${uid}`).update({ lastSeenAt: Date.now(), installId });
  }
  return { ok: true, campaignId, message: "Доступ ЗБТ подтверждён." };
}

function safeText(value, maxLength) { return String(value || "").trim().slice(0, maxLength); }
function requireId(value, name) {
  const id = safeText(value, 160);
  if (!id || id.includes("/")) throw new HttpsError("invalid-argument", `${name} некорректен.`);
  return id;
}
function scrubText(value, maxLength) {
  return String(value || "").replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer <REDACTED>")
    .replace(/((?:access|refresh|id)_token\s*[=:]\s*)[^\s,;]+/gi, "$1<REDACTED>")
    .replace(/([A-Z]:\\Users\\)[^\\\s]+/gi, "$1<USER>").replace(/(\/home\/)[^/\s]+/gi, "$1<USER>").slice(0, maxLength);
}
async function consumeRateLimit(uid, action, limit, windowMs) {
  const bucket = crypto.createHash("sha256").update(`${uid}:${action}`).digest("hex").slice(0, 40);
  const ref = db.doc(`ingestLimits/${bucket}`);
  const currentTime = now();
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const data = snapshot.exists ? snapshot.data() : {};
    const startedAt = Number(data.startedAt || 0);
    const fresh = currentTime - startedAt >= windowMs;
    const count = fresh ? 0 : Number(data.count || 0);
    if (count >= limit) throw new HttpsError("resource-exhausted", "Превышен лимит отправки данных. Повторите позже.");
    tx.set(ref, { startedAt: fresh ? currentTime : startedAt || currentTime, count: count + 1,
      updatedAt: FieldValue.serverTimestamp(), expireAt: Timestamp.fromMillis(currentTime + windowMs + 24 * 60 * 60 * 1000) });
  });
}
function requirePlayerAuth(auth) {
  if (!auth) throw new HttpsError("unauthenticated", "Требуется активная сессия лаунчера.");
  if (auth.token.firebase?.sign_in_provider === "anonymous") throw new HttpsError("permission-denied", "Для облачной синхронизации нужен аккаунт Microsoft.");
}
function getDateKey(timestamp = new Date()) { return timestamp.toISOString().slice(0, 10); }
function randomBytes(n) { return crypto.randomBytes(n); }

exports.beforecreated = beforeUserCreated(async (event) => {
  const email = normalizeEmail(event.data?.email);
  if (!email) return;
  const invite = await db.doc(`staffInvites/${email}`).get();
  if (invite.exists) {
    const role = invite.data().role;
    if (ROLES.has(role)) return { customClaims: { role, admin: true } };
  }
});

exports.redeemZbtKey = onCall(callOpts, async (request) => {
  const uid = request.auth?.uid || null;
  const installId = String(request.data?.installId || "").trim();
  const nickname = String(request.data?.nickname || "").slice(0, 16);
  const minecraftUuid = String(request.data?.minecraftUuid || "").slice(0, 64);
  const email = safeText(request.data?.email, 254).toLowerCase();
  const device = sanitizeDeviceSnapshot(request.data?.device);
  if (!installId || installId.length > 64) throw new HttpsError("invalid-argument", "Некорректный installId.");
  await hitRateLimit(uid, clientIp(request));
  const parsed = parseKey(request.data?.key);
  if (!parsed.ok) { await recordFail(uid, clientIp(request)); throw new HttpsError("invalid-argument", "Ключ неверного формата или контрольная сумма не совпала."); }
  if (!parsed.compact.startsWith("FL")) { await recordFail(uid, clientIp(request)); throw new HttpsError("invalid-argument", "Поддерживается формат ключа FL-XXXX-XXXX-XXXX."); }
  if (uid && (await rtdb.ref(`bans/${uid}`).get()).exists()) throw new HttpsError("permission-denied", "Доступ к лаунчеру заблокирован. Обратитесь в поддержку.");
  const result = await redeemFlRtdbKey(uid, parsed.compact, installId, nickname, minecraftUuid, email, device);
  if (!result) { await recordFail(uid, clientIp(request)); throw new HttpsError("not-found", "Ключ не найден в общей базе RTDB /keys."); }
  return result;
});

exports.checkZbtAccess = onCall(staffOpts, async (request) => {
  const uid = request.auth?.uid || null;
  const installId = String(request.data?.installId || "").trim();
  if (!installId || installId.length > 64) throw new HttpsError("invalid-argument", "Некорректный installId.");
  if (!uid) return (await checkFlRtdbAccess(null, installId)) ?? { ok: false, message: "Нужен ключ ЗБТ." };
  if ((await rtdb.ref(`bans/${uid}`).get()).exists()) return { ok: false, message: "Доступ к лаунчеру заблокирован. Обратитесь в поддержку." };
  try {
    const access = await checkFlRtdbAccess(uid, installId);
    if (access?.ok && request.auth.token.zbt !== access.campaignId) await applyZbtClaim(uid, access.campaignId);
    return access ?? { ok: false, message: "Нужен ключ ЗБТ." };
  } catch (error) {
    logger.warn("Could not check RTDB ZBT access", { uid, error: String(error) });
    return { ok: false, message: "Не удалось проверить доступ ЗБТ. Проверьте подключение." };
  }
});

exports.createZbtCampaign = onCall(callOpts, async (request) => {
  await requireOwner(request.auth);
  const name = String(request.data?.name || "").trim().slice(0, 80);
  const seats = Number(request.data?.seats || 0);
  const note = String(request.data?.note || "").slice(0, 500);
  const expiresAtMs = request.data?.expiresAtMs ? Number(request.data.expiresAtMs) : null;
  if (!name) throw new HttpsError("invalid-argument", "Укажите название кампании.");
  if (!Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS) throw new HttpsError("invalid-argument", `Число мест: от 1 до ${MAX_SEATS}.`);
  const campaignId = `zbt_${crypto.randomUUID()}`;
  const createdAt = Date.now();
  const keys = [];
  const updates = { [`zbtCampaigns/${campaignId}`]: { name, seats, status: "ACTIVE", note, createdAt, createdBy: request.auth.uid, activatedCount: 0, expiresAt: expiresAtMs } };
  for (let i = 0; i < seats; i++) {
    const generated = generateKey(randomBytes);
    const hash = crypto.createHash("sha256").update(generated.compact, "utf8").digest("hex");
    updates[`keys/${hash}`] = { campaignId, campaignName: name, hash, status: "UNUSED", used: false, activatedBy: null, usedBy: null,
      installId: null, activatedAt: null, expiresAt: expiresAtMs, note: note || null, createdAt };
    keys.push(generated.display);
  }
  await rtdb.ref().update(updates);
  await rtdb.ref(`auditLog/zbt_${createdAt}_${crypto.randomBytes(4).toString("hex")}`).set({ actorUid: request.auth.uid,
    action: "zbt.campaign.create", payload: { campaignId, name, seats }, at: createdAt });
  return { campaignId, name, seats, keys, csv: ["key", ...keys].join("\n"), warning: "Ключи сохранены в Realtime Database и доступны в CRM." };
});

exports.listZbtCampaigns = onCall(staffOpts, async (request) => {
  const role = await requireStaff(request.auth);
  if (role === "marketing") throw new HttpsError("permission-denied", "Маркетинг не имеет доступа к разделу ЗБТ.");
  const snap = await rtdb.ref("zbtCampaigns").get();
  return { campaigns: Object.entries(snap.exists() ? snap.val() : {}).map(([id, value]) => ({ id, ...(value || {}) }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 50) };
});

exports.listZbtKeys = onCall(staffOpts, async (request) => {
  const role = await requireStaff(request.auth);
  if (role === "marketing") throw new HttpsError("permission-denied", "Маркетинг не имеет доступа к разделу ЗБТ.");
  const campaignId = String(request.data?.campaignId || "");
  if (!campaignId) throw new HttpsError("invalid-argument", "campaignId обязателен.");
  const snap = await rtdb.ref("keys").get();
  return { keys: Object.entries(snap.exists() ? snap.val() : {}).filter(([, value]) => value?.campaignId === campaignId).slice(0, 500).map(([id, x]) => ({
    id, rawKey: x.rawKey || null, storagePath: "keys", status: x.status, activatedBy: x.activatedBy || x.usedBy || null,
    nickname: x.nickname || null, minecraftUuid: x.minecraftUuid || null, installId: x.installId || null,
    activatedAt: x.activatedAt || x.usedAt || null, expiresAt: x.expiresAt || null, note: x.note || null,
  })) };
});

exports.revokeZbtKey = onCall(staffOpts, async (request) => {
  await requireOwner(request.auth);
  const keyId = String(request.data?.keyId || "");
  if (!keyId) throw new HttpsError("invalid-argument", "keyId обязателен.");
  const storagePath = request.data?.storagePath === "zbtKeys" ? "zbtKeys" : "keys";
  const ref = rtdb.ref(`${storagePath}/${keyId}`);
  const snap = await ref.get();
  if (!snap.exists()) throw new HttpsError("not-found", "Ключ не найден.");
  const data = snap.val();
  await ref.update({ status: "REVOKED", revoked: true, revokedAt: Date.now(), revokedBy: request.auth.uid });
  const activatedBy = data.activatedBy || data.usedBy;
  if (activatedBy) {
    const user = await adminAuth.getUser(activatedBy).catch(() => null);
    if (user) {
      const claims = { ...(user.customClaims || {}) };
      delete claims.zbt;
      await adminAuth.setCustomUserClaims(activatedBy, claims);
      await db.doc(`zbtActivations/${activatedBy}`).delete().catch(() => {});
      await rtdb.ref(`players/${activatedBy}/zbt`).remove();
    }
  }
  if (data.installId) await rtdb.ref(`zbtDeviceActivations/${data.installId}`).remove();
  const at = Date.now();
  await rtdb.ref(`auditLog/zbt_${at}_${crypto.randomBytes(4).toString("hex")}`).set({ actorUid: request.auth.uid, action: "zbt.key.revoke", payload: { keyId }, at });
  return { ok: true };
});

exports.extendZbtCampaign = onCall(staffOpts, async (request) => {
  await requireOwner(request.auth);
  const campaignId = String(request.data?.campaignId || "");
  const expiresAtMs = Number(request.data?.expiresAtMs || 0);
  if (!campaignId || !expiresAtMs) throw new HttpsError("invalid-argument", "Нужны campaignId и expiresAtMs.");
  const campaignRef = rtdb.ref(`zbtCampaigns/${campaignId}`);
  if (!(await campaignRef.get()).exists()) throw new HttpsError("not-found", "Кампания не найдена.");
  const keySnapshot = await rtdb.ref("keys").get();
  const updates = { [`zbtCampaigns/${campaignId}/expiresAt`]: expiresAtMs };
  for (const [id, key] of Object.entries(keySnapshot.exists() ? keySnapshot.val() : {})) if (key?.campaignId === campaignId) updates[`keys/${id}/expiresAt`] = expiresAtMs;
  await rtdb.ref().update(updates);
  const at = Date.now();
  await rtdb.ref(`auditLog/zbt_${at}_${crypto.randomBytes(4).toString("hex")}`).set({ actorUid: request.auth.uid, action: "zbt.campaign.extend", payload: { campaignId, expiresAtMs }, at });
  return { ok: true };
});

exports.setCampaignStatus = onCall(staffOpts, async (request) => {
  await requireOwner(request.auth);
  const campaignId = String(request.data?.campaignId || "");
  const status = String(request.data?.status || "");
  if (!["ACTIVE", "CLOSED"].includes(status)) throw new HttpsError("invalid-argument", "status: ACTIVE или CLOSED.");
  const campaignRef = rtdb.ref(`zbtCampaigns/${campaignId}`);
  if (!(await campaignRef.get()).exists()) throw new HttpsError("not-found", "Кампания не найдена.");
  await campaignRef.update({ status, updatedAt: Date.now() });
  const at = Date.now();
  await rtdb.ref(`auditLog/zbt_${at}_${crypto.randomBytes(4).toString("hex")}`).set({ actorUid: request.auth.uid, action: "zbt.campaign.status", payload: { campaignId, status }, at });
  return { ok: true };
});

exports.inviteStaff = onCall(staffOpts, async (request) => {
  await requireOwner(request.auth);
  const email = normalizeEmail(request.data?.email);
  const role = String(request.data?.role || "");
  if (!email || !email.includes("@")) throw new HttpsError("invalid-argument", "Укажите почту сотрудника.");
  if (!ROLES.has(role)) throw new HttpsError("invalid-argument", "Роль: owner, support или marketing.");
  await db.doc(`staffInvites/${email}`).set({ email, role, invitedBy: request.auth.uid, invitedAt: FieldValue.serverTimestamp() });
  const users = await adminAuth.getUserByEmail(email).catch(() => null);
  if (users) {
    await applyStaffClaims(users.uid, role);
    await db.doc(`staff/${users.uid}`).set({ email, role, displayName: users.displayName || email,
      createdAt: FieldValue.serverTimestamp(), createdBy: request.auth.uid }, { merge: true });
  }
  await audit(request.auth.uid, "staff.invite", { email, role });
  return { ok: true, pending: !users };
});

exports.listStaff = onCall(staffOpts, async (request) => {
  await requireOwner(request.auth);
  const [staffSnap, inviteSnap] = await Promise.all([db.collection("staff").get(), db.collection("staffInvites").get()]);
  return { staff: staffSnap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toMillis?.() || null })),
    invites: inviteSnap.docs.map((d) => ({ email: d.id, role: d.data().role, invitedAt: d.data().invitedAt?.toMillis?.() || null })) };
});

exports.whoAmI = onCall(staffOpts, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Нет сессии.");
  if (request.auth.token.firebase?.sign_in_provider !== "google.com") throw new HttpsError("permission-denied", "Для CRM требуется вход через Google.");
  const uid = request.auth.uid;
  try {
    const email = normalizeEmail(request.auth.token.email);
    const staffRef = db.doc(`staff/${uid}`);
    let staffSnap = await staffRef.get();
    if (!staffSnap.exists && email) {
      const inviteRef = db.doc(`staffInvites/${email}`);
      await db.runTransaction(async (tx) => {
        const [currentStaff, invite] = await Promise.all([tx.get(staffRef), tx.get(inviteRef)]);
        const invitedRole = invite.exists ? invite.data().role : null;
        if (!currentStaff.exists && ROLES.has(invitedRole)) {
          tx.set(staffRef, { email, role: invitedRole, displayName: request.auth.token.name || email,
            createdAt: FieldValue.serverTimestamp(), createdBy: "staff-invite" });
          tx.delete(inviteRef);
        }
      });
      staffSnap = await staffRef.get();
      if (staffSnap.exists && ROLES.has(staffSnap.data().role)) await applyStaffClaims(uid, staffSnap.data().role);
    }
    const staffData = staffSnap.exists ? staffSnap.data() : null;
    const staffEmail = normalizeEmail(staffData?.email);
    const roleValid = Boolean(staffData && ROLES.has(staffData.role));
    const emailMatches = staffEmail === email;
    const role = roleValid && emailMatches ? staffData.role : null;
    const staffStatus = !staffSnap.exists ? "missing_document" : !roleValid ? "invalid_role" : !emailMatches ? "email_mismatch" : "active";
    return { uid, email: request.auth.token.email || null, role, staffStatus,
      staffEmail: staffSnap.exists ? staffData.email || null : null, staffRole: staffSnap.exists ? staffData.role || null : null,
      zbt: request.auth.token.zbt || null };
  } catch (error) {
    logger.error("CRM whoAmI lookup failed", { uid, error });
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Не удалось прочитать роль CRM. Откройте логи функции whoAmI в Firebase Console.");
  }
});

exports.getCrmOverview = onCall(staffOpts, async (request) => {
  const role = await requireStaff(request.auth);
  const [players, campaignSnapshot, errors, analytics] = await Promise.all([
    db.collection("players").count().get(),
    role === "marketing" ? Promise.resolve(null) : rtdb.ref("zbtCampaigns").get(),
    role === "marketing" ? Promise.resolve({ docs: [] }) : db.collection("errorGroups").orderBy("updatedAt", "desc").limit(20).get(),
    db.collection("dailyAnalytics").orderBy("date", "desc").limit(30).get(),
  ]);
  const campaignRecords = campaignSnapshot?.exists() ? campaignSnapshot.val() : {};
  return { playerCount: players.data().count,
    campaigns: Object.entries(campaignRecords).map(([id, campaign]) => ({ id, ...campaign })),
    errors: errors.docs.map((doc) => ({ id: doc.id, fingerprint: doc.data().fingerprint, title: doc.data().title, area: doc.data().area,
      status: doc.data().status, occurrences: doc.data().occurrences || 0, affectedPlayers: doc.data().affectedPlayers || 0,
      updatedAt: doc.data().updatedAt?.toMillis?.() || null, version: doc.data().version || "" })),
    daily: analytics.docs.map((doc) => ({ id: doc.id, date: doc.data().date || doc.id,
      activePlayers: doc.data().activePlayers || 0, events: doc.data().events || 0 })) };
});

exports.listPlayers = onCall(staffOpts, async (request) => {
  const role = await requireStaff(request.auth);
  if (role === "marketing") throw new HttpsError("permission-denied", "Маркетинг не имеет доступа к данным игроков.");
  const snapshot = await db.collection("players").orderBy("lastSeenAt", "desc").limit(200).get();
  return { players: snapshot.docs.map((doc) => {
    const data = doc.data();
    return { uid: doc.id, nickname: data.nickname || "", minecraftUuid: data.minecraftUuid || "", contactEmail: data.contactEmail || "",
      status: data.status || "ACTIVE", zbtCampaignId: data.zbtCampaignId || null,
      lastSeenAt: data.lastSeenAt?.toMillis?.() || null, createdAt: data.createdAt?.toMillis?.() || null };
  }) };
});

exports.setPlayerStatus = onCall(staffOpts, async (request) => {
  const role = await requireStaff(request.auth);
  const uid = requireId(request.data?.uid, "uid");
  const status = String(request.data?.status || "");
  if (!["ACTIVE", "BANNED"].includes(status)) throw new HttpsError("invalid-argument", "Статус должен быть ACTIVE или BANNED.");
  if (role === "marketing") throw new HttpsError("permission-denied", "Маркетинг не может менять статус игрока.");
  await db.doc(`players/${uid}`).set({ status, statusUpdatedAt: FieldValue.serverTimestamp(), statusUpdatedBy: request.auth.uid }, { merge: true });
  if (status === "BANNED") {
    const user = await adminAuth.getUser(uid).catch(() => null);
    if (user) { const claims = { ...(user.customClaims || {}) }; delete claims.zbt; await adminAuth.setCustomUserClaims(uid, claims); }
  }
  await audit(request.auth.uid, `player.${status.toLowerCase()}`, { uid });
  return { ok: true };
});

exports.listErrorGroups = onCall(staffOpts, async (request) => {
  const role = await requireStaff(request.auth);
  if (role === "marketing") throw new HttpsError("permission-denied", "Маркетинг не имеет доступа к отчётам ошибок.");
  const snapshot = await db.collection("errorGroups").orderBy("updatedAt", "desc").limit(100).get();
  return { errors: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data(), updatedAt: doc.data().updatedAt?.toMillis?.() || null,
    firstSeenAt: doc.data().firstSeenAt?.toMillis?.() || null })) };
});

exports.updateErrorStatus = onCall(staffOpts, async (request) => {
  const role = await requireStaff(request.auth);
  if (role === "marketing") throw new HttpsError("permission-denied", "Маркетинг не может разбирать ошибки.");
  const fingerprint = requireId(request.data?.fingerprint, "fingerprint");
  const status = String(request.data?.status || "");
  if (!["NEW", "IN_PROGRESS", "RESOLVED", "IGNORED"].includes(status)) throw new HttpsError("invalid-argument", "Недопустимый статус ошибки.");
  await db.doc(`errorGroups/${fingerprint}`).update({ status, updatedAt: FieldValue.serverTimestamp(), updatedBy: request.auth.uid });
  await audit(request.auth.uid, "error.status", { fingerprint, status });
  return { ok: true };
});

exports.listAnnouncements = onCall(staffOpts, async (request) => {
  await requireStaff(request.auth);
  const snapshot = await db.collection("announcements").orderBy("updatedAt", "desc").limit(100).get();
  return { announcements: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data(),
    updatedAt: doc.data().updatedAt?.toMillis?.() || null, publishedAt: doc.data().publishedAt?.toMillis?.() || null })) };
});

exports.saveAnnouncement = onCall(staffOpts, async (request) => {
  const role = await requireStaff(request.auth);
  if (role === "support") throw new HttpsError("permission-denied", "Только owner или marketing могут редактировать новости.");
  const title = safeText(request.data?.title, 120);
  const body = safeText(request.data?.body, 5000);
  const status = String(request.data?.status || "DRAFT");
  const id = request.data?.id ? requireId(request.data.id, "id") : null;
  if (!title || !body) throw new HttpsError("invalid-argument", "Заполните заголовок и текст новости.");
  if (!["DRAFT", "PUBLISHED"].includes(status)) throw new HttpsError("invalid-argument", "Статус новости некорректен.");
  const ref = id ? db.doc(`announcements/${id}`) : db.collection("announcements").doc();
  const payload = { title, body, status, updatedAt: FieldValue.serverTimestamp(), updatedBy: request.auth.uid };
  if (status === "PUBLISHED") payload.publishedAt = FieldValue.serverTimestamp();
  if (!id) payload.createdAt = FieldValue.serverTimestamp();
  await ref.set(payload, { merge: true });
  await audit(request.auth.uid, id ? "announcement.update" : "announcement.create", { id: ref.id, status });
  return { id: ref.id, ok: true };
});

exports.deleteAnnouncement = onCall(staffOpts, async (request) => {
  const role = await requireStaff(request.auth);
  if (role !== "owner") throw new HttpsError("permission-denied", "Удалять новости может только owner.");
  const id = requireId(request.data?.id, "id");
  await db.doc(`announcements/${id}`).delete();
  await audit(request.auth.uid, "announcement.delete", { id });
  return { ok: true };
});

exports.listAuditLog = onCall(staffOpts, async (request) => {
  await requireOwner(request.auth);
  const snapshot = await db.collection("auditLog").orderBy("at", "desc").limit(200).get();
  return { entries: snapshot.docs.map((doc) => ({ id: doc.id, actorUid: doc.data().actorUid, action: doc.data().action,
    payload: doc.data().payload || {}, at: doc.data().at?.toMillis?.() || null })) };
});

exports.getLauncherNews = onCall(staffOpts, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Войдите в лаунчер.");
  const snapshot = await db.collection("announcements").where("status", "==", "PUBLISHED").orderBy("publishedAt", "desc").limit(20).get();
  return { announcements: snapshot.docs.map((doc) => ({ id: doc.id, title: doc.data().title, body: doc.data().body,
    publishedAt: doc.data().publishedAt?.toMillis?.() || null })) };
});

exports.registerPlayer = onCall(staffOpts, async (request) => {
  requirePlayerAuth(request.auth);
  const uid = request.auth.uid;
  await consumeRateLimit(uid, "profile", 10, 60 * 60 * 1000);
  const nickname = safeText(request.data?.nickname, 16);
  const minecraftUuid = safeText(request.data?.minecraftUuid, 64);
  const locale = safeText(request.data?.locale, 10);
  if (!nickname || !minecraftUuid || !["ru-RU", "uk-UA", "en-US"].includes(locale)) throw new HttpsError("invalid-argument", "Некорректный профиль игрока.");
  const ref = db.doc(`players/${uid}`);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const profile = { nickname, minecraftUuid, locale, lastSeenAt: FieldValue.serverTimestamp() };
    if (!snapshot.exists) { profile.createdAt = FieldValue.serverTimestamp(); profile.status = "ACTIVE"; }
    tx.set(ref, profile, { merge: true });
  });
  return { ok: true };
});

exports.setPlayerContact = onCall(staffOpts, async (request) => {
  requirePlayerAuth(request.auth);
  await consumeRateLimit(request.auth.uid, "contact", 5, 60 * 60 * 1000);
  const email = safeText(request.data?.email, 254).toLowerCase();
  const consent = request.data?.consent === true;
  if (consent && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError("invalid-argument", "Укажите корректный email.");
  await db.doc(`players/${request.auth.uid}`).set({ contactEmail: consent ? email : FieldValue.delete(),
    contactEmailConsentAt: consent ? FieldValue.serverTimestamp() : FieldValue.delete() }, { merge: true });
  return { ok: true };
});

exports.setDiagnosticsConsent = onCall(staffOpts, async (request) => {
  requirePlayerAuth(request.auth);
  await db.doc(`players/${request.auth.uid}`).set({ diagnosticsConsent: request.data?.consent === true,
    diagnosticsConsentUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});

exports.ingestPlayerEvent = onCall(staffOpts, async (request) => {
  requirePlayerAuth(request.auth);
  const uid = request.auth.uid;
  const player = await db.doc(`players/${uid}`).get();
  if (!player.exists || player.data().diagnosticsConsent !== true) throw new HttpsError("permission-denied", "Игрок не разрешил отправку диагностики.");
  await consumeRateLimit(uid, "events", 30, 60 * 1000);
  const eventType = safeText(request.data?.eventType, 48);
  const area = safeText(request.data?.area, 48);
  const locale = safeText(request.data?.locale, 10);
  const launcherVersion = safeText(request.data?.launcherVersion, 32);
  const gameVersion = safeText(request.data?.gameVersion, 32);
  if (!eventType || !area || !launcherVersion) throw new HttpsError("invalid-argument", "Некорректное событие.");
  const date = getDateKey(new Date());
  const dailyRef = db.doc(`dailyAnalytics/${date}`);
  const activeRef = db.doc(`dailyPlayerActivity/${date}_${uid}`);
  const eventRef = db.collection("playerEvents").doc();
  await db.runTransaction(async (tx) => {
    const [active] = await Promise.all([tx.get(activeRef), tx.get(dailyRef)]);
    tx.set(eventRef, { uid, eventType, area, locale, launcherVersion, gameVersion: gameVersion || null,
      occurredAt: FieldValue.serverTimestamp(), expireAt: Timestamp.fromMillis(Date.now() + 90 * 24 * 60 * 60 * 1000) });
    tx.set(dailyRef, { date, events: FieldValue.increment(1), activePlayers: FieldValue.increment(active.exists ? 0 : 1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (!active.exists) tx.create(activeRef, { uid, date, createdAt: FieldValue.serverTimestamp(), expireAt: Timestamp.fromMillis(Date.now() + 90 * 24 * 60 * 60 * 1000) });
    tx.set(db.doc(`players/${uid}`), { lastSeenAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  return { ok: true };
});

exports.ingestPlayerError = onCall(staffOpts, async (request) => {
  requirePlayerAuth(request.auth);
  const uid = request.auth.uid;
  const player = await db.doc(`players/${uid}`).get();
  if (!player.exists || player.data().diagnosticsConsent !== true) throw new HttpsError("permission-denied", "Игрок не разрешил отправку диагностики.");
  await consumeRateLimit(uid, "errors", 20, 60 * 60 * 1000);
  const area = safeText(request.data?.area, 48);
  const title = scrubText(request.data?.title, 160);
  const description = scrubText(request.data?.description, 4000);
  const locale = safeText(request.data?.locale, 10);
  const launcherVersion = safeText(request.data?.launcherVersion, 32);
  const gameVersion = safeText(request.data?.gameVersion, 32);
  const device = request.data?.device && typeof request.data.device === "object" ? request.data.device : {};
  const stack = scrubText(request.data?.stack, 6000);
  if (!area || !title || !description || !launcherVersion) throw new HttpsError("invalid-argument", "Некорректный отчёт об ошибке.");
  const fingerprint = crypto.createHash("sha256").update(`${area}\n${title}\n${description.replace(/:\d+:\d+/g, ":<line>")}`).digest("hex");
  const groupRef = db.doc(`errorGroups/${fingerprint}`);
  const affectedRef = db.doc(`errorGroups/${fingerprint}/affectedPlayers/${uid}`);
  const reportRef = db.collection("errorReports").doc();
  const occurredAt = FieldValue.serverTimestamp();
  await db.runTransaction(async (tx) => {
    const [group, affected] = await Promise.all([tx.get(groupRef), tx.get(affectedRef)]);
    const groupData = group.exists ? group.data() : {};
    tx.set(groupRef, { fingerprint, area, title, description, stack: stack || null, version: gameVersion || launcherVersion,
      status: groupData.status || "NEW", occurrences: FieldValue.increment(1), affectedPlayers: FieldValue.increment(affected.exists ? 0 : 1),
      firstSeenAt: groupData.firstSeenAt || occurredAt, updatedAt: occurredAt,
      expireAt: Timestamp.fromMillis(Date.now() + 90 * 24 * 60 * 60 * 1000), device }, { merge: true });
    if (!affected.exists) tx.create(affectedRef, { uid, createdAt: occurredAt });
    tx.create(reportRef, { uid, fingerprint, occurredAt, expireAt: Timestamp.fromMillis(Date.now() + 90 * 24 * 60 * 60 * 1000),
      area, title, description, stack: stack || null, locale, launcherVersion, gameVersion: gameVersion || null, device });
    tx.set(db.doc(`players/${uid}`), { lastSeenAt: occurredAt }, { merge: true });
  });
  return { ok: true, fingerprint };
});

function safeOrderId(value) { return /^[A-Za-z0-9_-]{8,80}$/.test(String(value || "")); }
function safeShopItem(value) {
  const name = safeText(value?.name, 80);
  const description = safeText(value?.description, 400);
  const type = safeText(value?.type, 32);
  const priceUah = Number(value?.priceUah);
  const priceUsdt = Number(value?.priceUsdt);
  if (!name || !type || !Number.isFinite(priceUah) || priceUah < 0 || priceUah > 1000000 || !Number.isFinite(priceUsdt) || priceUsdt < 0 || priceUsdt > 100000)
    throw new HttpsError("invalid-argument", "Перевірте назву, тип і ціни товару.");
  return { name, description, type, priceUah: Math.round(priceUah * 100) / 100, priceUsdt: Math.round(priceUsdt * 100) / 100,
    iconUrl: safeText(value?.iconUrl, 500) || null, enabled: value?.enabled === true, dynamicPrice: value?.dynamicPrice === true,
    priceStepUah: Math.min(Math.max(Number(value?.priceStepUah) || 0, 0), 100000),
    priceStepUsdt: Math.min(Math.max(Number(value?.priceStepUsdt) || 0, 0), 10000), updatedAt: now() };
}

exports.createLauncherOrder = onCall(callOpts, async (request) => {
  requirePlayerAuth(request.auth);
  const uid = request.auth.uid;
  await consumeRateLimit(uid, "shopOrders", 8, 60 * 60 * 1000);
  const itemId = safeText(request.data?.itemId, 120);
  const method = request.data?.paymentMethod;
  if (!itemId || !["card", "crypto"].includes(method)) throw new HttpsError("invalid-argument", "Некоректний товар або спосіб оплати.");
  const itemSnapshot = await rtdb.ref(`shop_items/${itemId}`).get();
  const item = itemSnapshot.val();
  if (!item || item.enabled !== true) throw new HttpsError("not-found", "Товар недоступний.");
  const requestedTag = item.type === "tag" ? safeText(request.data?.tag, 16).toLowerCase() : "";
  if (item.type === "tag" && !/^[a-z0-9_]{3,16}$/.test(requestedTag)) throw new HttpsError("invalid-argument", "Тег має містити 3–16 латинських літер, цифр або символів підкреслення.");
  const currency = method === "card" ? "UAH" : "USDT";
  const baseAmount = Number(method === "card" ? item.priceUah : item.priceUsdt);
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) throw new HttpsError("failed-precondition", `Для цього товару не задана ціна в ${currency}.`);
  const uniqueKopecks = method === "card" ? crypto.randomInt(1, 100) / 100 : 0;
  const amount = Math.round((baseAmount + uniqueKopecks) * 100) / 100;
  const orderRef = rtdb.ref("orders").push();
  const orderId = orderRef.key;
  const receiptCode = `F-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const playerSnapshot = await rtdb.ref(`players/${uid}`).get();
  const player = playerSnapshot.val() || {};
  const order = { uid, email: safeText(request.auth.token.email, 254) || safeText(player.contactEmail, 254) || null,
    nickname: safeText(player.nickname || request.auth.token.name, 32) || null, itemId, itemName: safeText(item.name, 80),
    itemType: safeText(item.type, 32), amount, baseAmount, currency, paymentMethod: method, tag: requestedTag || null,
    receiptCode, status: "pending", createdAt: now(), updatedAt: now() };
  if (requestedTag) {
    const reservation = await rtdb.ref(`tags/${requestedTag}`).transaction((current) => current || {
      tag: requestedTag, uid, itemId, orderId, status: "reserved", reservedAt: now() });
    if (!reservation.committed) throw new HttpsError("already-exists", "Цей тег уже зайнятий або очікує оплати.");
  }
  await orderRef.set(order);
  const username = String(process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");
  return { orderId, receiptCode, amount, currency, botLink: username ? `https://t.me/${username}?start=pay_${orderId}` : null };
});

exports.getLauncherOrder = onCall(callOpts, async (request) => {
  requirePlayerAuth(request.auth);
  const orderId = String(request.data?.orderId || "");
  if (!safeOrderId(orderId)) throw new HttpsError("invalid-argument", "Некоректний номер замовлення.");
  const snapshot = await rtdb.ref(`orders/${orderId}`).get();
  const order = snapshot.val();
  if (!order || order.uid !== request.auth.uid) throw new HttpsError("not-found", "Замовлення не знайдено.");
  return { orderId, status: order.status, updatedAt: order.updatedAt || order.createdAt };
});

exports.listShopItems = onCall(staffOpts, async (request) => {
  await requireOwner(request.auth);
  const [items, tags] = await Promise.all([rtdb.ref("shop_items").get(), rtdb.ref("tags").get()]);
  return { items: items.val() || {}, tags: tags.val() || {} };
});
exports.saveShopItem = onCall(staffOpts, async (request) => {
  await requireOwner(request.auth);
  const itemId = safeText(request.data?.itemId, 120);
  try {
    const item = safeShopItem(request.data?.item);
    const ref = itemId ? rtdb.ref(`shop_items/${itemId}`) : rtdb.ref("shop_items").push();
    const key = ref.key;
    await ref.transaction((current) => ({ ...current, ...item, createdAt: current?.createdAt || now() }));
    await rtdb.ref("auditLog").push({ actorUid: request.auth.uid, action: itemId ? "shop.item.updated" : "shop.item.created",
      payload: { itemId: key, name: item.name, enabled: item.enabled }, at: now() });
    return { itemId: key };
  } catch (error) {
    logger.error("saveShopItem failed", {
      uid: request.auth.uid,
      itemId: itemId || null,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });
    throw error;
  }
});
exports.listShopOrders = onCall(staffOpts, async (request) => {
  await requireOwner(request.auth);
  const [orders, sales] = await Promise.all([rtdb.ref("orders").orderByChild("createdAt").limitToLast(300).get(),
    rtdb.ref("analytics/sales").orderByChild("completedAt").limitToLast(300).get()]);
  return { orders: orders.val() || {}, sales: sales.val() || {} };
});

exports.reviewShopOrder = onCall(staffOpts, async (request) => {
  await requireOwner(request.auth);
  const orderId = String(request.data?.orderId || "");
  const action = request.data?.action;
  if (!safeOrderId(orderId) || !["complete", "reject", "revoke"].includes(action)) throw new HttpsError("invalid-argument", "Некоректна дія або замовлення.");
  const orderRef = rtdb.ref(`orders/${orderId}`);
  const beforeReview = (await orderRef.get()).val();
  if (action === "complete" && beforeReview?.tag) {
    const tag = (await rtdb.ref(`tags/${beforeReview.tag}`).get()).val();
    if (!tag || tag.orderId !== orderId) throw new HttpsError("failed-precondition", "Резервацію тегу втрачено. Перевірте замовлення вручну.");
  }
  let transitioned = false;
  const result = await orderRef.transaction((current) => {
    transitioned = false;
    if (!current) return;
    if (action === "complete" && ["pending", "under_review"].includes(current.status)) {
      transitioned = true;
      const completedAt = now();
      return { ...current, status: "completed", reviewedBy: request.auth.uid, reviewedAt: completedAt, completedAt, updatedAt: completedAt };
    }
    if (action === "reject" && ["pending", "under_review"].includes(current.status)) return { ...current, status: "rejected", reviewedBy: request.auth.uid, reviewedAt: now(), updatedAt: now() };
    if (action === "revoke" && current.status === "completed") return { ...current, status: "revoked", reviewedBy: request.auth.uid, reviewedAt: now(), updatedAt: now() };
    return;
  });
  const order = result.snapshot.val();
  if (!order) throw new HttpsError("not-found", "Замовлення не знайдено.");
  if (action === "complete" && order.status === "completed") {
    const purchasedItem = (await rtdb.ref(`shop_items/${order.itemId}`).get()).val();
    if (!purchasedItem) throw new HttpsError("failed-precondition", "Товар замовлення відсутній у каталозі; видача потребує перевірки.");
    await deliverWalletPurchase(order.uid, { ...purchasedItem, id: order.itemId }, `order_${orderId}`);
    const sale = { orderId, uid: order.uid, email: order.email || null, nickname: order.nickname || null, itemId: order.itemId,
      itemName: order.itemName, itemType: order.itemType, tag: order.tag || null, amount: order.amount, currency: order.currency,
      paymentMethod: order.paymentMethod, completedAt: order.completedAt || order.reviewedAt || order.updatedAt };
    await rtdb.ref().update({ [`analytics/sales/${orderId}`]: sale,
      [`entitlements/${order.uid}/${orderId}`]: { orderId, itemId: order.itemId, itemName: order.itemName, tag: order.tag || null, status: "active", activatedAt: sale.completedAt } });
    if (order.tag) await rtdb.ref(`tags/${order.tag}`).update({ status: "active", activatedAt: sale.completedAt });
    if (transitioned) await rtdb.ref(`shop_items/${order.itemId}`).transaction((item) => {
      if (!item) return item;
      const salesCount = Number(item.salesCount || 0) + 1;
      if (item.dynamicPrice !== true) return { ...item, salesCount, updatedAt: now() };
      const priceKey = order.currency === "UAH" ? "priceUah" : "priceUsdt";
      const stepKey = order.currency === "UAH" ? "priceStepUah" : "priceStepUsdt";
      const nextPrice = Math.round((Number(item[priceKey] || 0) + Number(item[stepKey] || 0)) * 100) / 100;
      const historyKey = rtdb.ref(`shop_items/${order.itemId}/priceHistory`).push().key;
      return { ...item, [priceKey]: nextPrice, salesCount, updatedAt: now(),
        priceHistory: { ...(item.priceHistory || {}), [historyKey]: { price: nextPrice, currency: order.currency, at: now(), orderId } } };
    });
  }
  if (action === "revoke" && order.status === "revoked") {
    await rtdb.ref(`entitlements/${order.uid}/${orderId}`).remove();
    await rtdb.ref(`analytics/sales/${orderId}/revokedAt`).set(now());
    if (order.tag) await rtdb.ref(`tags/${order.tag}`).transaction((tag) => tag?.orderId === orderId ? null : tag);
  }
  if (action === "reject" && order.status === "rejected" && order.tag)
    await rtdb.ref(`tags/${order.tag}`).transaction((tag) => tag?.orderId === orderId ? null : tag);
  await rtdb.ref("auditLog").push({ actorUid: request.auth.uid, action: `shop.order.${order.status}`,
    payload: { orderId, uid: order.uid, email: order.email || null, itemId: order.itemId, amount: order.amount, currency: order.currency }, at: now() });
  return { ok: true, status: order.status, uid: order.uid, email: order.email || null };
});

function safeWalletOperations(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function writeWalletLedger(uid, operationId, entry) {
  await rtdb.ref(`ledger/${uid}/${operationId}`).transaction((current) => current || entry);
}

async function creditWalletOnce(uid, operationId, amount, reason, reference) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new HttpsError("invalid-argument", "Некоректна сума FL Coins.");
  const walletRef = rtdb.ref(`wallets/${uid}`);
  let balanceAfter = 0;
  const transaction = await walletRef.transaction((current) => {
    const wallet = current && typeof current === "object" ? current : { coins: 0 };
    const operations = safeWalletOperations(wallet.operations);
    if (operations[operationId]) {
      balanceAfter = Number(wallet.coins || 0);
      return wallet;
    }
    balanceAfter = Number(wallet.coins || 0) + amount;
    return { ...wallet, coins: balanceAfter, updatedAt: now(), operations: {
      ...operations, [operationId]: { status: "completed", delta: amount, reason, reference, at: now(), balanceAfter },
    } };
  });
  const wallet = transaction.snapshot.val() || {};
  const operation = wallet.operations?.[operationId];
  balanceAfter = Number(operation?.balanceAfter ?? wallet.coins ?? balanceAfter);
  await writeWalletLedger(uid, operationId, { delta: Number(operation?.delta || amount), reason,
    ref: reference || null, balanceAfter, ts: Number(operation?.at || now()) });
  return balanceAfter;
}

async function reserveLimitedStock(itemId, requestId) {
  const ref = rtdb.ref(`shop_items/${itemId}`);
  let limited = false;
  let outOfStock = false;
  const transaction = await ref.transaction((item) => {
    if (!item || item.enabled !== true) return;
    if (item.stock === undefined || item.stock === null) return item;
    limited = true;
    const reservations = safeWalletOperations(item.stockReservations);
    if (reservations[requestId]) return item;
    const stock = Number(item.stock);
    if (!Number.isSafeInteger(stock) || stock <= 0) {
      outOfStock = true;
      return;
    }
    return { ...item, stock: stock - 1, stockReservations: { ...reservations, [requestId]: true }, updatedAt: now() };
  });
  if (!transaction.committed) {
    if (outOfStock) throw new HttpsError("resource-exhausted", "Товар закончился.");
    throw new HttpsError("failed-precondition", "Товар больше недоступен.");
  }
  return limited;
}

async function releaseLimitedStock(itemId, requestId) {
  const ref = rtdb.ref(`shop_items/${itemId}`);
  await ref.transaction((item) => {
    if (!item) return item;
    const reservations = safeWalletOperations(item.stockReservations);
    if (!reservations[requestId]) return item;
    const nextReservations = { ...reservations };
    delete nextReservations[requestId];
    return { ...item, stock: Number(item.stock || 0) + 1, stockReservations: nextReservations, updatedAt: now() };
  });
}

async function commitLimitedStock(itemId, requestId) {
  const ref = rtdb.ref(`shop_items/${itemId}`);
  await ref.transaction((item) => {
    if (!item) return item;
    const reservations = safeWalletOperations(item.stockReservations);
    if (!reservations[requestId]) return item;
    const nextReservations = { ...reservations };
    delete nextReservations[requestId];
    return { ...item, stockReservations: nextReservations, updatedAt: now() };
  });
}

async function grantCaseInventory(uid, caseId, quantity, deliveryId) {
  const ref = rtdb.ref(`case_inventory/${uid}/${caseId}`);
  let alreadyGranted = false;
  await ref.transaction((current) => {
    const record = Number.isSafeInteger(current) ? { count: current } : (current || { count: 0 });
    const deliveries = safeWalletOperations(record.deliveries);
    if (deliveries[deliveryId]) {
      alreadyGranted = true;
      return record;
    }
    return { ...record, count: Number(record.count || 0) + quantity, updatedAt: now(),
      deliveries: { ...deliveries, [deliveryId]: { quantity, at: now() } } };
  });
  return { duplicate: alreadyGranted };
}

async function grantOwnedItem(uid, item, deliveryId, source) {
  const ref = rtdb.ref(`owned/${uid}/${item.id}`);
  let duplicate = false;
  await ref.transaction((current) => {
    const record = current && typeof current === "object" ? current : {};
    const deliveries = safeWalletOperations(record.deliveries);
    if (deliveries[deliveryId]) {
      duplicate = deliveries[deliveryId].duplicate === true;
      return record;
    }
    const premiumDays = item.type === "premium" ? Math.max(0, Number(item.metadata?.days || 0)) : 0;
    const isPremium = premiumDays > 0;
    duplicate = !isPremium && Boolean(record.acquiredAt);
    const currentExpiry = Number(record.expiresAt || 0);
    const updated = { ...record, itemId: item.id, source: record.source || source,
      acquiredAt: record.acquiredAt || now(), deliveries: { ...deliveries, [deliveryId]: { duplicate, at: now() } } };
    if (isPremium) updated.expiresAt = Math.max(now(), currentExpiry) + premiumDays * 24 * 60 * 60 * 1000;
    return updated;
  });
  return { duplicate };
}

async function deliverWalletPurchase(uid, purchaseItem, requestId) {
  if (purchaseItem.type === "coins") {
    const amount = Number(purchaseItem.metadata?.coinAmount);
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new HttpsError("failed-precondition", "У пакета FL Coins не задано количество монет.");
    await creditWalletOnce(uid, `${requestId}_${purchaseItem.id}`, amount, "money_purchase", purchaseItem.id);
    return 0;
  }
  let duplicateRefund = 0;
  const catalog = (await rtdb.ref("shop_items").get()).val() || {};
  let rewards;
  if (purchaseItem.type === "case") rewards = [{ item: purchaseItem, quantity: 1 }];
  else {
    const grantIds = listGrantedItemIds(purchaseItem);
    if (Array.isArray(purchaseItem.metadata?.grants) && purchaseItem.metadata.grants.length) {
      rewards = purchaseItem.metadata.grants.map((grant) => ({ item: catalog[grant.itemId], quantity: Math.max(1, Number(grant.quantity || 1)), itemId: grant.itemId }));
    } else if (grantIds.length) rewards = grantIds.map((itemId) => ({ item: catalog[itemId], quantity: 1, itemId }));
    else rewards = [{ item: purchaseItem, quantity: 1 }];
  }

  for (const [index, reward] of rewards.entries()) {
    const item = reward.item || catalog[reward.itemId];
    if (!item || !item.id && !reward.itemId) throw new HttpsError("failed-precondition", "В наборе найдена отсутствующая позиция.");
    const itemId = item.id || reward.itemId;
    const deliveryId = `${requestId}_${itemId}`;
    if (item.type === "case") {
      await grantCaseInventory(uid, itemId, reward.quantity, deliveryId);
      continue;
    }
    const ownedItem = { ...item, id: itemId };
    const grant = await grantOwnedItem(uid, ownedItem, deliveryId, `coins:${requestId}`);
    if (grant.duplicate) duplicateRefund += Math.floor(Number(item.priceCoins || 0) * 0.25);
  }
  return duplicateRefund;
}

exports.getWalletSnapshot = onCall(callOpts, async (request) => {
  requirePlayerAuth(request.auth);
  const uid = request.auth.uid;
  const [walletSnap, ownedSnap, equippedSnap, casesSnap, ledgerSnap] = await Promise.all([
    rtdb.ref(`wallets/${uid}`).get(), rtdb.ref(`owned/${uid}`).get(), rtdb.ref(`equipped/${uid}`).get(),
    rtdb.ref(`case_inventory/${uid}`).get(), rtdb.ref(`ledger/${uid}`).orderByChild("ts").limitToLast(100).get(),
  ]);
  const wallet = walletSnap.val() || {};
  const ledger = ledgerSnap.val() || {};
  return { wallet: { coins: Math.max(0, Number(wallet.coins || 0)), updatedAt: Number(wallet.updatedAt || 0) },
    owned: ownedSnap.val() || {}, equipped: equippedSnap.val() || {}, caseInventory: casesSnap.val() || {}, ledger };
});

exports.purchaseWithCoins = onCall(callOpts, async (request) => {
  requirePlayerAuth(request.auth);
  const uid = request.auth.uid;
  await consumeRateLimit(uid, "coinPurchases", 20, 60 * 60 * 1000);
  const itemId = requireId(request.data?.itemId, "itemId");
  let requestId;
  try { requestId = normalizeRequestId(request.data?.requestId); }
  catch (error) { throw new HttpsError("invalid-argument", error.message); }

  const itemRef = rtdb.ref(`shop_items/${itemId}`);
  const itemSnapshot = await itemRef.get();
  const item = itemSnapshot.val();
  try { assertCatalogItemAvailable(item); }
  catch (error) { throw new HttpsError("failed-precondition", error.message); }
  if (item.type === "gift") throw new HttpsError("failed-precondition", "Для подарков сначала выберите получателя.");
  const configSnapshot = await rtdb.ref("shop_config").get();
  let price;
  try { price = getCoinPrice(item, configSnapshot.val() || { coinsPerUah: 1 }); }
  catch (error) { throw new HttpsError("failed-precondition", error.message); }

  const walletRef = rtdb.ref(`wallets/${uid}`);
  const operationsRef = walletRef.child("operations");
  const prior = (await operationsRef.child(requestId).get()).val();
  if (prior && prior.itemId !== itemId) throw new HttpsError("already-exists", "requestId уже использован для другого товара.");
  if (prior?.status === "completed") return prior.result;

  let stockReserved = false;
  if (!prior) stockReserved = await reserveLimitedStock(itemId, requestId);
  let insufficient = false;
  let conflictingRequest = false;
  const debit = await walletRef.transaction((current) => {
    const wallet = current && typeof current === "object" ? current : { coins: 0 };
    const operations = safeWalletOperations(wallet.operations);
    const operation = operations[requestId];
    if (operation) {
      if (operation.itemId !== itemId || operation.price !== price) conflictingRequest = true;
      return wallet;
    }
    const balance = Number(wallet.coins || 0);
    if (balance < price) { insufficient = true; return; }
    return { ...wallet, coins: balance - price, updatedAt: now(), operations: {
      ...operations, [requestId]: { status: "delivering", itemId, price, createdAt: now() },
    } };
  });
  if (conflictingRequest) throw new HttpsError("already-exists", "requestId уже использован для другой операции.");
  if (insufficient || !debit.committed) {
    if (stockReserved) await releaseLimitedStock(itemId, requestId);
    throw new HttpsError("failed-precondition", "Недостаточно FL Coins.");
  }

  const operation = debit.snapshot.val()?.operations?.[requestId];
  if (operation?.status === "completed") return operation.result;
  let duplicateRefund;
  try { duplicateRefund = await deliverWalletPurchase(uid, { ...item, id: itemId }, requestId); }
  catch (error) {
    logger.error("FL Coin item delivery failed; idempotent operation remains retryable", { uid, itemId, requestId, message: error.message });
    throw new HttpsError("internal", "Списание выполнено, выдача товара будет повторена безопасно. Повторите покупку через несколько секунд.");
  }

  let result;
  const finalize = await walletRef.transaction((current) => {
    if (!current) return;
    const operations = safeWalletOperations(current.operations);
    const currentOperation = operations[requestId];
    if (!currentOperation || currentOperation.itemId !== itemId) return;
    if (currentOperation.status === "completed") { result = currentOperation.result; return current; }
    const coins = Number(current.coins || 0) + duplicateRefund;
    result = { itemId, requestId, coinsRefunded: duplicateRefund, balance: coins };
    return { ...current, coins, updatedAt: now(), operations: { ...operations,
      [requestId]: { ...currentOperation, status: "completed", duplicateRefund, completedAt: now(), result } } };
  });
  if (!finalize.committed || !result) throw new HttpsError("aborted", "Операция ожидает завершения. Повторите запрос с тем же requestId.");
  await writeWalletLedger(uid, requestId, { delta: -price + duplicateRefund, reason: "shop_purchase",
    ref: itemId, balanceAfter: result.balance, ts: now() });
  if (stockReserved) await commitLimitedStock(itemId, requestId);
  await rtdb.ref("auditLog").push({ actorUid: uid, action: "wallet.purchase", payload: { itemId, requestId, price, duplicateRefund }, at: now() });
  return result;
});

exports.openCase = onCall(callOpts, async (request) => {
  requirePlayerAuth(request.auth);
  const uid = request.auth.uid;
  await consumeRateLimit(uid, "caseOpenings", 30, 60 * 60 * 1000);
  const caseId = requireId(request.data?.caseId, "caseId");
  let requestId;
  try { requestId = normalizeRequestId(request.data?.requestId); }
  catch (error) { throw new HttpsError("invalid-argument", error.message); }

  const [caseSnapshot, dropsSnapshot] = await Promise.all([
    rtdb.ref(`shop_items/${caseId}`).get(), rtdb.ref(`case_drops/${caseId}`).get(),
  ]);
  const caseItem = caseSnapshot.val();
  try { assertCatalogItemAvailable(caseItem); }
  catch (error) { throw new HttpsError("failed-precondition", error.message); }
  if (caseItem.type !== "case") throw new HttpsError("invalid-argument", "Товар не является кейсом.");
  const drops = dropsSnapshot.val();
  if (!Array.isArray(drops)) throw new HttpsError("failed-precondition", "Таблица дропа кейса отсутствует.");

  const inventoryRef = rtdb.ref(`case_inventory/${uid}/${caseId}`);
  let noCases = false;
  const openingTransaction = await inventoryRef.transaction((current) => {
    const inventory = Number.isSafeInteger(current) ? { count: current } : (current || { count: 0 });
    const openings = safeWalletOperations(inventory.openings);
    if (openings[requestId]) return inventory;
    if (Number(inventory.count || 0) < 1) { noCases = true; return; }
    let reward;
    try { reward = selectWeightedDrop(drops, crypto.randomInt(0, 10000)); }
    catch (error) { throw new HttpsError("failed-precondition", error.message); }
    return { ...inventory, count: Number(inventory.count) - 1, updatedAt: now(),
      openings: { ...openings, [requestId]: { reward, openedAt: now() } } };
  });
  if (noCases || !openingTransaction.committed)
    throw new HttpsError("failed-precondition", "В инвентаре нет этого кейса.");

  const opening = openingTransaction.snapshot.val()?.openings?.[requestId];
  if (!opening) throw new HttpsError("aborted", "Результат открытия не сохранён. Повторите запрос с тем же requestId.");
  const openingRef = rtdb.ref(`case_openings/${uid}/${requestId}`);
  await openingRef.transaction((current) => current || { caseId, reward: opening.reward, openedAt: opening.openedAt, status: "reward_pending" });
  let rewardResult;
  if (opening.reward.kind === "coins") {
    const balance = await creditWalletOnce(uid, `case_${requestId}`, Number(opening.reward.amount), "case_reward", caseId);
    rewardResult = { kind: "coins", amount: Number(opening.reward.amount), balance };
  } else {
    const rewardId = requireId(opening.reward.itemId, "reward.itemId");
    const item = (await rtdb.ref(`shop_items/${rewardId}`).get()).val();
    if (!item || !item.enabled) throw new HttpsError("failed-precondition", "Выпавший предмет больше недоступен.");
    const grant = await grantOwnedItem(uid, { ...item, id: rewardId }, `case_${requestId}`, `case:${caseId}`);
    let balance;
    let coinsRefunded = 0;
    if (grant.duplicate) {
      coinsRefunded = Math.floor(Number(item.priceCoins || 0) * 0.25);
      if (coinsRefunded > 0) balance = await creditWalletOnce(uid, `case_duplicate_${requestId}`, coinsRefunded, "case_duplicate", rewardId);
    }
    rewardResult = { kind: "item", itemId: rewardId, duplicate: grant.duplicate, coinsRefunded, balance: balance ?? null };
  }
  await openingRef.update({ status: "completed", rewardResult, completedAt: now() });
  return { caseId, requestId, ...rewardResult };
});
