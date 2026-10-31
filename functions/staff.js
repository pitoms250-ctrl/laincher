"use strict";

const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");
const { HttpsError } = require("firebase-functions/v2/https");

const ROLES = new Set(["owner", "support", "marketing"]);

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function requireStaff(auth) {
  if (!auth) throw new HttpsError("unauthenticated", "Войдите в CRM через Google.");
  const firebase = auth.token.firebase || {};
  if (firebase.sign_in_provider !== "google.com") {
    throw new HttpsError("permission-denied", "Для CRM требуется вход через Google.");
  }
  if (!firebase.sign_in_second_factor) {
    throw new HttpsError("failed-precondition", "Для CRM обязательно включить второй фактор Firebase Authentication.");
  }
  const email = normalizeEmail(auth.token.email);
  const staff = await getDatabase().ref(`staff/${auth.uid}`).get();
  const data = staff.exists() ? staff.val() : null;
  if (!data || !ROLES.has(data.role) || normalizeEmail(data.email) !== email) {
    throw new HttpsError("permission-denied", "Нет доступа к CRM. Обратитесь к основателю.");
  }
  return data.role;
}

async function requireOwner(auth) {
  const role = await requireStaff(auth);
  if (role !== "owner") {
    throw new HttpsError("permission-denied", "Только основатель (owner) может это делать.");
  }
  return role;
}

async function applyStaffClaims(uid, role) {
  const auth = getAuth();
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, { ...(user.customClaims || {}), role, admin: true });
}

async function applyZbtClaim(uid, campaignId) {
  const auth = getAuth();
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, { ...(user.customClaims || {}), zbt: campaignId });
}

module.exports = {
  ROLES,
  normalizeEmail,
  requireStaff,
  requireOwner,
  applyStaffClaims,
  applyZbtClaim,
};
