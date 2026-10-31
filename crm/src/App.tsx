import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity, AlertTriangle, Ban, Check, ChevronDown, CircleHelp,
  Clock3, FileText, KeyRound, LayoutDashboard, LogOut, Mail, Menu, Plus, RefreshCw,
  Search, ShieldCheck, ShieldAlert, Users, X, Download, Database, Copy, CheckCheck,
  Server, Lock, Sparkles, ExternalLink
} from "lucide-react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { ShopManager, type ShopItem, type ShopSeedCatalog, type ShopTag } from "./ShopManager";
import { SalesDashboard, type ShopOrder } from "./SalesDashboard";
import {
  auth, beginGoogleSignIn, rtdbSet, rtdbGet, rtdbUpdate, rtdbRemove, rtdbSubscribe,
  rtdbTestAccess, RECOMMENDED_RTDB_RULES, RTDB_RULES_URL, RTDB_DATA_URL, RTDB_URL,
  enrollPhoneMfa, isSecondFactorSession, multiFactor, RecaptchaVerifier, signOut, rtdbTransaction,
} from "./firebase";

type Role = "owner" | "support" | "marketing";
type Page = "overview" | "zbt" | "players" | "errors" | "news" | "staff" | "analytics" | "audit" | "shop" | "sales";
type Campaign = { id: string; name: string; seats: number; status: string; activatedCount: number; createdAt?: number; expiresAt?: number | null };
type Player = { uid: string; nickname: string; contactEmail: string; status: string; zbtCampaignId?: string; lastSeenAt?: number; launchCount?: number; totalPlayMinutes?: number; lastVersion?: string };
type ZbtKey = { id: string; campaignId?: string; status: string; activatedBy?: string; usedBy?: string; nickname?: string; installId?: string; activatedAt?: number; usedAt?: number; used?: boolean; rawKey?: string; createdAt?: number; storagePath?: "keys" | "zbtKeys" };
type CrmError = { id: string; fingerprint: string; title: string; area: string; status: string; occurrences: number; affectedPlayers: number; updatedAt?: number; version?: string };
type Announcement = { id: string; title: string; body: string; status: string; updatedAt?: number; author?: string };
type StaffMember = { id: string; email: string; displayName?: string; role: Role; isChief?: boolean; createdAt?: number; invitedBy?: string };
type AuditEntry = { id: string; actorUid: string; action: string; payload: Record<string, unknown>; at?: number };
type Overview = { playerCount: number; campaigns: Campaign[]; errors: CrmError[]; daily: Array<{ id: string; date?: string; activePlayers?: number; events?: number }> };

const nav: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Обзор", icon: LayoutDashboard },
  { id: "zbt", label: "ЗБТ-ключи", icon: KeyRound },
  { id: "players", label: "Игроки и Баны", icon: Users },
  { id: "errors", label: "Ошибки", icon: AlertTriangle },
  { id: "news", label: "Новости", icon: FileText },
  { id: "analytics", label: "Аналитика", icon: Activity },
  { id: "shop", label: "Магазин", icon: Database },
  { id: "sales", label: "Продажи", icon: Activity },
  { id: "staff", label: "Сотрудники", icon: ShieldCheck },
  { id: "audit", label: "Журнал аудита", icon: Clock3 },
];

const ZBT_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function makeZbtKey(): string {
  const bytes = new Uint8Array(16);
  let payload = "";
  while (payload.length < 12) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= 252) continue;
      payload += ZBT_ALPHABET[byte % ZBT_ALPHABET.length];
      if (payload.length === 12) break;
    }
  }
  return `FL-${payload.slice(0, 4)}-${payload.slice(4, 8)}-${payload.slice(8, 12)}`;
}

function dateLabel(value?: number) {
  return value ? new Date(value).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

async function hashZbtKey(displayKey: string): Promise<string> {
  const compact = displayKey.replace(/[-\s]/g, "").toUpperCase();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(compact));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorText(error: unknown) {
  if (typeof error === "object" && error && "message" in error) {
    const code = "code" in error ? String((error as { code: unknown }).code || "") : "";
    const message = String((error as { message: unknown }).message).replace(/^Firebase: /, "");
    if (code === "database/permission-denied" || /PERMISSION_DENIED|permission denied/i.test(message)) {
      return "RTDB запретила запись. Разверните актуальные database.rules.json и проверьте, что в staff/{UID} указана роль owner, а вход в CRM подтверждён MFA.";
    }
    return message;
  }
  return "Не удалось выполнить операцию.";
}

function recordRows<T extends object>(records: Record<string, T> | null): Array<T & { id: string }> {
  return (Object.entries(records || {}) as Array<[string, T]>).map(([id, value]) => ({ ...value, id }));
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const [loading, setLoading] = useState(true);
  const [secondFactor, setSecondFactor] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [accessDiagnostic, setAccessDiagnostic] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [zbtEnabled, setZbtEnabled] = useState(false);

  // Optimistic data states initialized from LocalStorage
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [activatedCounts, setActivatedCounts] = useState<Record<string, number>>({});
  const [players, setPlayers] = useState<Player[]>([]);
  const [errors, setErrors] = useState<CrmError[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [keys, setKeys] = useState<ZbtKey[]>([]);
  const [shopItems, setShopItems] = useState<ShopItem[]>([]);
  const [shopTags, setShopTags] = useState<ShopTag[]>([]);
  const [shopOrders, setShopOrders] = useState<ShopOrder[]>([]);

  const [selectedCampaign, setSelectedCampaign] = useState("");
  const [queryText, setQueryText] = useState("");
  const [playerStatusFilter, setPlayerStatusFilter] = useState<"ALL" | "ACTIVE" | "BANNED">("ALL");
  const [busy, setBusy] = useState(false);

  // Modals
  const [showCampaignForm, setShowCampaignForm] = useState(false);
  const [showInviteForm, setShowInviteForm] = useState(false);
    const [showNewsForm, setShowNewsForm] = useState(false);
    const [showDbModal, setShowDbModal] = useState(false);

    // Form states
    const [campaignName, setCampaignName] = useState("");
  const [campaignSeats, setCampaignSeats] = useState(50);
  const [campaignExpiry, setCampaignExpiry] = useState("");
    const [inviteEmail, setInviteEmail] = useState("");
    const [inviteUid, setInviteUid] = useState("");
    const [inviteRole, setInviteRole] = useState<Role>("support");
  const [newsTitle, setNewsTitle] = useState("");
  const [newsBody, setNewsBody] = useState("");
  const [newsStatus, setNewsStatus] = useState("DRAFT");
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [mfaVerificationId, setMfaVerificationId] = useState("");
  const mfaVerifier = useRef<RecaptchaVerifier | null>(null);
  const createdKeysByHash = useRef(new Map<string, string>());

  const [rtdbDiag, setRtdbDiag] = useState<{ testing: boolean; tested: boolean; canRead: boolean; canWrite: boolean; message: string }>({
    testing: false,
    tested: false,
    canRead: false,
    canWrite: false,
    message: "",
  });
  const [copiedRules, setCopiedRules] = useState(false);
  const [copiedKey, setCopiedKey] = useState("");

  // CRM role is provisioned in RTDB by a project administrator.
  useEffect(() => {
    return onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setRole(null);
      setSecondFactor(false);
      setLoading(true);
      setError("");

      if (!currentUser) {
        setLoading(false);
        return;
      }

      try {
        const tokenEmail = currentUser.email?.trim().toLowerCase() || "";
        const staffMember = await rtdbGet<StaffMember>(`staff/${currentUser.uid}`);
        const staffEmail = staffMember?.email?.trim().toLowerCase() || "";
        const validRole = staffMember?.role === "owner" || staffMember?.role === "support" || staffMember?.role === "marketing";
        if (!staffMember) {
          setRole(null);
          setAccessDiagnostic(`В RTDB не найден staff/${currentUser.uid}. Администратор проекта должен создать эту запись.`);
        } else if (staffEmail !== tokenEmail) {
          setRole(null);
          setAccessDiagnostic(`Email в staff/${currentUser.uid} не совпадает с текущим Google-аккаунтом.`);
        } else if (!validRole) {
          setRole(null);
          setAccessDiagnostic(`Недопустимая роль «${staffMember.role}». Разрешены owner, support, marketing.`);
        } else {
          setRole(staffMember.role);
          setAccessDiagnostic(`Роль подтверждена в Realtime Database (${staffMember.role}).`);
        }
        setSecondFactor(await isSecondFactorSession(currentUser));
      } catch (checkErr) {
        console.warn("Auth role check error:", checkErr);
        setRole(null);
        setError(errorText(checkErr));
      } finally {
        setLoading(false);
      }
    });
  }, []);

  useEffect(() => {
    if (!user || !secondFactor || !role) return;
    void loadPage(page);
  }, [user, secondFactor, role, page]);

  useEffect(() => {
    if (!user || !secondFactor || role !== "owner") return;
    return rtdbSubscribe<boolean>("config/zbtEnabled", (enabled) => {
      setZbtEnabled(enabled ?? false);
    }, (cause) => setError(errorText(cause)));
  }, [user, secondFactor, role]);

  useEffect(() => {
    if (!user || !secondFactor || !role || role === "marketing" || !["overview", "analytics", "players"].includes(page)) return;
    let playerRecords: Record<string, Player> = {};
    let banRecords: Record<string, { bannedAt?: number; reason?: string }> = {};
    const publishPlayers = () => {
      const currentPlayers = Object.entries(playerRecords).map(([uid, player]) => ({
        ...player,
        uid,
        status: banRecords[uid] ? "BANNED" : player.status || "ACTIVE",
      }));
      setPlayers(currentPlayers);
      setOverview((current) => current ? { ...current, playerCount: currentPlayers.length } : current);
    };
    const unsubscribePlayers = rtdbSubscribe<Record<string, Player>>("players", (records) => {
      playerRecords = records || {};
      publishPlayers();
    }, (cause) => setError(errorText(cause)));
    const unsubscribeBans = rtdbSubscribe<Record<string, { bannedAt?: number; reason?: string }>>("bans", (records) => {
      banRecords = records || {};
      publishPlayers();
    }, (cause) => setError(errorText(cause)));
    return () => {
      unsubscribePlayers();
      unsubscribeBans();
    };
  }, [user, secondFactor, role, page]);

  useEffect(() => {
    if (!user || !secondFactor || !role || page !== "zbt") return;
    return rtdbSubscribe<Record<string, Campaign>>("zbtCampaigns", (records) => {
      const liveCampaigns = Object.entries(records || {}).map(([id, value]) => ({ ...value, id }));
      setCampaigns(liveCampaigns);
    }, (cause) => setError(errorText(cause)));
  }, [user, secondFactor, role, page]);

  useEffect(() => {
    if (!user || !secondFactor || !role || role === "marketing") return;
    const recordsByPath: Record<string, Record<string, ZbtKey>> = {};
    const refreshCounts = () => {
      const counts = new Map<string, number>();
      const keysById = new Map<string, ZbtKey>();
      for (const path of ["zbtKeys", "keys"] as const) {
        for (const [id, value] of Object.entries(recordsByPath[path] || {})) {
          const previous = keysById.get(id);
          const previousUsed = Boolean(previous?.used || ["ACTIVATED", "USED", "REDEEMED"].includes(previous?.status || ""));
          const currentUsed = Boolean(value?.used || ["ACTIVATED", "USED", "REDEEMED"].includes(value?.status || ""));
          if (!previous || currentUsed || !previousUsed) keysById.set(id, value);
        }
      }
      for (const value of keysById.values()) {
        if (!value?.campaignId || !(value.used || ["ACTIVATED", "USED", "REDEEMED"].includes(value.status))) continue;
        counts.set(value.campaignId, (counts.get(value.campaignId) || 0) + 1);
      }
      setActivatedCounts(Object.fromEntries(counts));
    };
    const unsubscribeLegacy = rtdbSubscribe<Record<string, ZbtKey>>("zbtKeys", (records) => {
      recordsByPath.zbtKeys = records || {};
      refreshCounts();
    }, (cause) => setError(errorText(cause)));
    const unsubscribeCanonical = rtdbSubscribe<Record<string, ZbtKey>>("keys", (records) => {
      recordsByPath.keys = records || {};
      refreshCounts();
    }, (cause) => setError(errorText(cause)));
    return () => {
      unsubscribeLegacy();
      unsubscribeCanonical();
    };
  }, [user, secondFactor, role]);

  useEffect(() => {
    if (!user || !secondFactor || role !== "owner" || !["shop", "sales"].includes(page)) return;
    return rtdbSubscribe<Record<string, Omit<ShopItem, "id">>>("shop_items", (records) => {
      setShopItems(recordRows(records) as ShopItem[]);
    }, (cause) => setError(errorText(cause)));
  }, [user, secondFactor, role, page]);

  useEffect(() => {
    if (!user || !secondFactor || role !== "owner" || page !== "sales") return;
    return rtdbSubscribe<Record<string, Omit<ShopOrder, "id">>>("orders", (records) => {
      setShopOrders(recordRows(records).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)) as ShopOrder[]);
    }, (cause) => setError(errorText(cause)));
  }, [user, secondFactor, role, page]);

  useEffect(() => {
    if (!user || !secondFactor || role !== "owner" || page !== "shop") return;
    return rtdbSubscribe<Record<string, Omit<ShopTag, "tag">>>("tags", (records) => {
      setShopTags(Object.entries(records || {}).map(([tag, value]) => ({ tag, ...value })));
    }, (cause) => setError(errorText(cause)));
  }, [user, secondFactor, role, page]);

  useEffect(() => {
    if (!user || !secondFactor || !role || page !== "zbt" || !selectedCampaign) return;
    const recordsByPath: Record<string, Record<string, ZbtKey>> = {};
    const applyKeys = () => {
      const merged = new Map<string, ZbtKey>();
      for (const storagePath of ["zbtKeys", "keys"] as const) {
        for (const [id, value] of Object.entries(recordsByPath[storagePath] || {})) {
          if (!value || value.campaignId !== selectedCampaign) continue;
          merged.set(id, {
            ...value,
            id,
            rawKey: value.rawKey || createdKeysByHash.current.get(id),
            storagePath,
            activatedBy: value.activatedBy || value.usedBy,
            activatedAt: value.activatedAt || value.usedAt,
            status: value.status || (value.used ? "ACTIVATED" : "UNUSED"),
          });
        }
      }
      setKeys([...merged.values()]);
    };
    const unsubscribeLegacy = rtdbSubscribe<Record<string, ZbtKey>>("zbtKeys", (records) => {
      recordsByPath.zbtKeys = records || {};
      applyKeys();
    }, (cause) => setError(errorText(cause)));
    const unsubscribeCanonical = rtdbSubscribe<Record<string, ZbtKey>>("keys", (records) => {
      recordsByPath.keys = records || {};
      applyKeys();
    }, (cause) => setError(errorText(cause)));
    return () => {
      unsubscribeLegacy();
      unsubscribeCanonical();
    };
  }, [user, secondFactor, role, page, selectedCampaign]);

  async function loadPage(target: Page) {
    setBusy(true);
    setError("");

    try {
      if (target === "overview" || target === "analytics") {
        const [rtdbPlayers, rtdbCampaigns, rtdbErrors, rtdbDaily] = await Promise.all([
          rtdbGet<Record<string, Player>>("players").catch(() => null),
          rtdbGet<Record<string, Campaign>>("zbtCampaigns").catch(() => null),
          rtdbGet<Record<string, CrmError>>("errors").catch(() => null),
          rtdbGet<Record<string, { date?: string; activePlayers?: number; events?: number }>>("dailyAnalytics").catch(() => null),
        ]);

        if (rtdbCampaigns) {
          setCampaigns(recordRows(rtdbCampaigns));
        }
        if (rtdbErrors) {
          setErrors(recordRows(rtdbErrors));
        }

        const dailyList = recordRows(rtdbDaily);
        const count = rtdbPlayers ? Object.keys(rtdbPlayers).length : players.length;

        setOverview({
          playerCount: count,
          campaigns: rtdbCampaigns ? recordRows(rtdbCampaigns) : campaigns,
          errors: rtdbErrors ? recordRows(rtdbErrors) : errors,
          daily: dailyList,
        });
      }

      if (target === "zbt") {
        const rtdbCampaigns = await rtdbGet<Record<string, Campaign>>("zbtCampaigns").catch(() => null);
        if (rtdbCampaigns) {
          setCampaigns(recordRows(rtdbCampaigns));
        }
        if (selectedCampaign) await loadKeys(selectedCampaign);
      }

      if (target === "players") {
        const rtdbPlayers = await rtdbGet<Record<string, Player>>("players").catch(() => null);
        const rtdbBans = await rtdbGet<Record<string, { bannedAt?: number; reason?: string }>>("bans").catch(() => null);

        if (rtdbPlayers) {
          const list = (Object.entries(rtdbPlayers) as Array<[string, Player]>).map(([uid, p]) => ({
            ...p,
            uid,
            status: rtdbBans && rtdbBans[uid] ? "BANNED" : p.status || "ACTIVE",
          }));
          setPlayers(list);
        }
      }

      if (target === "errors") {
        const rtdbErrors = await rtdbGet<Record<string, CrmError>>("errors").catch(() => null);
        if (rtdbErrors) {
          setErrors(recordRows(rtdbErrors));
        }
      }

      if (target === "news") {
        const rtdbNews = await rtdbGet<Record<string, Announcement>>("news").catch(() => null);
        if (rtdbNews) {
          setAnnouncements(recordRows(rtdbNews));
        }
      }

      if (target === "staff") {
        const rtdbStaff = await rtdbGet<Record<string, StaffMember>>("staff").catch(() => null);
        setStaff(recordRows(rtdbStaff));
      }

      if (target === "audit") {
        const rtdbAudit = await rtdbGet<Record<string, AuditEntry>>("auditLog").catch(() => null);
        if (rtdbAudit) {
          setAudit(recordRows<AuditEntry>(rtdbAudit).sort((a, b) => (b.at || 0) - (a.at || 0)));
        }
      }

      if (target === "shop") {
        const [items, tags] = await Promise.all([
          rtdbGet<Record<string, Omit<ShopItem, "id">>>("shop_items"),
          rtdbGet<Record<string, Omit<ShopTag, "tag">>>("tags"),
        ]);
        setShopItems(recordRows(items) as ShopItem[]);
        setShopTags(Object.entries(tags || {}).map(([tag, value]) => ({ tag, ...value })));
      }

      if (target === "sales") {
        const orders = await rtdbGet<Record<string, Omit<ShopOrder, "id">>>("orders");
        setShopOrders(recordRows(orders).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)) as ShopOrder[]);
      }
    } catch (err) {
      console.warn("loadPage error:", err);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadKeys(campaignId: string) {
    setSelectedCampaign(campaignId);
    try {
      const [zbtKeys, legacyKeys] = await Promise.all([
        rtdbGet<Record<string, ZbtKey>>("zbtKeys").catch(() => null),
        rtdbGet<Record<string, ZbtKey>>("keys").catch(() => null),
      ]);
      const merged = new Map<string, ZbtKey>();
      const sources: Array<["keys" | "zbtKeys", Record<string, ZbtKey> | null]> = [
        ["zbtKeys", zbtKeys],
        ["keys", legacyKeys],
      ];
      for (const [storagePath, records] of sources) {
        for (const [id, value] of Object.entries(records || {}) as Array<[string, ZbtKey]>) {
          if (!value || value.campaignId !== campaignId) continue;
          merged.set(id, {
            ...value,
            id,
            storagePath,
            activatedBy: value.activatedBy || value.usedBy,
            activatedAt: value.activatedAt || value.usedAt,
            status: value.status || (value.used ? "ACTIVATED" : "UNUSED"),
          });
        }
      }
      setKeys([...merged.values()]);
    } catch (cause) {
      console.warn("Error loading keys:", cause);
    }
  }

  async function signIn() {
    setError("");
    try {
      await beginGoogleSignIn();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function startMfaEnrollment() {
    if (!user || !phone.trim()) return setError("Укажите номер телефона в международном формате.");
    try {
      const container = document.getElementById("mfa-recaptcha") || document.body;
      if (!mfaVerifier.current) {
        mfaVerifier.current = new RecaptchaVerifier(auth, container, { size: "invisible" });
      }
      const session = await multiFactor(user).getSession();
      const { PhoneAuthProvider } = await import("firebase/auth");
      const provider = new PhoneAuthProvider(auth);
      const verificationId = await provider.verifyPhoneNumber({ phoneNumber: phone.trim(), session }, mfaVerifier.current);
      setMfaVerificationId(verificationId);
      setNotice("Код отправлен. Подтвердите телефон, затем войдите повторно.");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function finishMfaEnrollment() {
    if (!user || !mfaVerificationId || !smsCode.trim()) return;
    try {
      await enrollPhoneMfa(user, mfaVerificationId, smsCode.trim());
      await signOut(auth);
      setNotice("Телефон подтверждён как второй фактор! Войдите снова через Google.");
      setMfaVerificationId("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  // OPTIMISTIC: Invite staff member
  async function inviteStaff(event: FormEvent) {
    event.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
    const uid = inviteUid.trim();
    if (!email || !uid || !user || role !== "owner") return;

    const newStaffMember: StaffMember = {
      id: uid,
      email,
      role: inviteRole,
      displayName: email.split("@")[0],
      createdAt: Date.now(),
      invitedBy: user.uid,
    };
    const res = await rtdbSet(`staff/${uid}`, newStaffMember);
    if (!res.success) {
      setError(`Не удалось сохранить staff/${uid}: ${res.error || "проверьте правила RTDB"}`);
      return;
    }
    await rtdbSet(`auditLog/audit_${Date.now()}`, {
      actorUid: user.uid,
      action: "invite_staff",
      payload: { uid, email, role: inviteRole },
      at: Date.now(),
    });
    setStaff((prev) => [newStaffMember, ...prev.filter((member) => member.id !== uid)]);
    setInviteEmail("");
    setInviteUid("");
    setShowInviteForm(false);
    setNotice(`Доступ для ${email} сохранён в RTDB по UID ${uid}.`);
  }

  // OPTIMISTIC: Ban or unban player
  async function changePlayerStatus(player: Player) {
    const isBanning = player.status !== "BANNED";
    const newStatus = isBanning ? "BANNED" : "ACTIVE";
    const confirmMessage = isBanning
      ? `Заблокировать доступ игроку ${player.nickname || player.uid} в лаунчере? (Запись появится в RTDB /bans)`
      : `Снять блокировку с игрока ${player.nickname || player.uid}? (Запись будет удалена из RTDB /bans)`;

    if (!window.confirm(confirmMessage)) return;

    if (isBanning) {
      const result = await rtdbSet(`bans/${player.uid}`, {
        uid: player.uid,
        nickname: player.nickname || "",
        bannedAt: Date.now(),
        bannedBy: user?.uid || "unknown",
        reason: "Блокировка администратором CRM",
      });
      if (!result.success) {
        setError(`Не удалось сохранить бан в RTDB: ${result.error || "отказано правилами"}`);
        return;
      }
    } else {
      const result = await rtdbRemove(`bans/${player.uid}`);
      if (!result.success) {
        setError(`Не удалось снять бан в RTDB: ${result.error || "отказано правилами"}`);
        return;
      }
    }

    setPlayers((prev) => prev.map((item) => item.uid === player.uid ? { ...item, status: newStatus } : item));
    setNotice(`Игрок ${player.nickname || player.uid}: ${isBanning ? "ЗАБЛОКИРОВАН" : "РАЗБЛОКИРОВАН"}`);
    const auditResult = await rtdbSet(`auditLog/audit_${Date.now()}`, {
      actorUid: user?.uid || "unknown",
      action: isBanning ? "ban_player" : "unban_player",
      payload: { uid: player.uid, nickname: player.nickname, status: newStatus },
      at: Date.now(),
    });
    if (!auditResult.success) setError(`Статус игрока изменён, но журнал не записан: ${auditResult.error || "ошибка RTDB"}`);
  }

  // OPTIMISTIC: Create ZBT Campaign & Keys
  async function createCampaign(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const expiresAtMs = campaignExpiry ? new Date(campaignExpiry).getTime() : null;
      const campaignId = `zbt_${crypto.randomUUID()}`;
      const generatedKeys = Array.from({ length: campaignSeats }, makeZbtKey);
      const createdAt = Date.now();
      const campaignPayload: Campaign = {
        id: campaignId,
        name: campaignName.trim(),
        seats: campaignSeats,
        status: "ACTIVE",
        activatedCount: 0,
        createdAt,
        expiresAt: expiresAtMs,
      };
      const newKeysList: ZbtKey[] = await Promise.all(generatedKeys.map(async (rawKey) => ({
        id: await hashZbtKey(rawKey),
        rawKey,
        storagePath: "keys",
        campaignId,
        status: "UNUSED",
        createdAt,
      })));

      const updates: Record<string, unknown> = {
        [`zbtCampaigns/${campaignId}`]: campaignPayload,
      };
      newKeysList.forEach((key) => {
        updates[`keys/${key.id}`] = {
          campaignId,
          campaignName: campaignPayload.name,
          hash: key.id,
          status: "UNUSED",
          used: false,
          createdAt,
          expiresAt: expiresAtMs,
        };
      });
      const write = await rtdbUpdate("", updates);
      if (!write.success) throw new Error(write.error || "Не вдалося записати кампанію та ключі в RTDB.");

      for (const key of newKeysList) {
        if (key.rawKey) createdKeysByHash.current.set(key.id, key.rawKey);
      }

      setCampaigns((previous) => [campaignPayload, ...previous]);
      setKeys((previous) => [...newKeysList, ...previous]);
      setSelectedCampaign(campaignId);
      const csvContent = "index,key,campaign,status\n" + generatedKeys.map((key, index) => `${index + 1},${key},${campaignPayload.name},UNUSED`).join("\n");
      const file = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(file);
      link.download = `${campaignPayload.name.replace(/[^\p{L}\p{N}-]+/gu, "-")}-keys.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
      setNotice("Кампания и ключи записаны в общую базу Realtime Database.");
      setCampaignName("");
      setShowCampaignForm(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  // OPTIMISTIC: Publish News
  async function saveNews(event: FormEvent) {
    event.preventDefault();
    const announcementId = `news_${Date.now()}`;
    const payload: Announcement = {
      id: announcementId,
      title: newsTitle,
      body: newsBody,
      status: newsStatus,
      updatedAt: Date.now(),
      author: user?.email || "admin",
    };

    // 1. Optimistic update
    setAnnouncements((prev) => {
      const updated = [payload, ...prev];
      return updated;
    });

    setNewsTitle("");
    setNewsBody("");
    setShowNewsForm(false);
    setNotice("Новость опубликована!");

    // 2. Async RTDB write
    await rtdbSet(`news/${announcementId}`, payload);
    await rtdbSet(`announcements/${announcementId}`, payload);
  }

  async function setCampaignStatus(campaignId: string, status: string) {
    try {
      const result = await rtdbUpdate(`zbtCampaigns/${campaignId}`, { status, updatedAt: Date.now() });
      if (!result.success) throw new Error(result.error || "Не вдалося оновити кампанію в RTDB.");
      setCampaigns((prev) => prev.map((campaign) => campaign.id === campaignId ? { ...campaign, status } : campaign));
      setNotice(`Статус кампании обновлён: ${status}`);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function setZbtTestingEnabled(enabled: boolean) {
    if (!user || role !== "owner") return;
    const timestamp = Date.now();
    const result = await rtdbUpdate("", {
      "config/zbtEnabled": enabled,
      "config/zbtUpdatedAt": timestamp,
      "config/zbtUpdatedBy": user.uid,
      [`auditLog/audit_${timestamp}_${crypto.randomUUID()}`]: {
        actorUid: user.uid,
        action: enabled ? "zbt.testing.enabled" : "zbt.testing.disabled",
        payload: { enabled },
        at: timestamp,
      },
    });
    if (!result.success) {
      setError(`Не удалось изменить режим ЗБТ: ${result.error || "проверьте правила RTDB"}`);
      return;
    }
    setZbtEnabled(enabled);
    setNotice(enabled ? "Тестирование ЗБТ включено." : "Тестирование ЗБТ выключено; блокировка лаунчера снята.");
  }

  async function revokeKey(keyId: string, storagePath: "keys" | "zbtKeys" = "keys") {
    if (!window.confirm("Отозвать этот ключ? Доступ игрока к лаунчеру будет немедленно прекращён.")) return;
    try {
      const result = await rtdbUpdate(`${storagePath}/${keyId}`, { status: "REVOKED", revoked: true, revokedAt: Date.now() });
      if (!result.success) throw new Error(result.error || "Не вдалося відкликати ключ у RTDB.");
      setKeys((prev) => prev.map((key) => key.id === keyId ? { ...key, status: "REVOKED" } : key));
      setNotice("Ключ ЗБТ отозван.");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function updateError(errorItem: CrmError, status: string) {
    setErrors((prev) => {
      const updated = prev.map((e) => (e.id === errorItem.id ? { ...e, status } : e));
      return updated;
    });
    setNotice(`Статус ошибки обновлён: ${status}`);
    await rtdbUpdate(`errors/${errorItem.id || errorItem.fingerprint}`, { status, updatedAt: Date.now() });
  }

  async function saveShopItem(item: Omit<ShopItem, "id">, itemId?: string) {
    try {
      const timestamp = Date.now();
      const existing = itemId ? await rtdbGet<ShopItem & { createdAt?: number }>(`shop_items/${itemId}`) : null;
      const payload = {
        ...item,
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp,
        salesCount: existing?.salesCount || 0,
        priceHistory: existing?.priceHistory || {},
      };
      const savedItemId = itemId || `shop_${crypto.randomUUID()}`;
      const result = itemId
        ? await rtdbUpdate(`shop_items/${savedItemId}`, payload)
        : await rtdbSet(`shop_items/${savedItemId}`, payload);
      if (!result.success) throw new Error(result.error || "Не удалось сохранить товар в RTDB.");
      await rtdbSet(`auditLog/audit_${timestamp}_${crypto.randomUUID()}`, {
        actorUid: user?.uid || "unknown",
        action: itemId ? "shop.item.updated" : "shop.item.created",
        payload: { itemId: savedItemId, name: item.name, enabled: item.enabled },
        at: timestamp,
      });
      setNotice(itemId ? "Товар оновлено." : "Товар додано до каталогу.");
    } catch (cause) {
      setError(errorText(cause));
      throw cause;
    }
  }

  async function publishShopCatalog(catalog: ShopSeedCatalog) {
    if (!user || !secondFactor || role !== "owner") throw new Error("Публикация каталога доступна только владельцу с MFA.");
    setBusy(true);
    try {
      const [currentItems, currentConfig] = await Promise.all([
        rtdbGet<Record<string, ShopItem>>("shop_items"),
        rtdbGet<Record<string, unknown> & { createdAt?: number }>("shop_config"),
      ]);
      const timestamp = Date.now();
      const updates: Record<string, unknown> = {};
      for (const [itemId, item] of Object.entries(catalog.items)) {
        const existing = currentItems?.[itemId];
        updates[`shop_items/${itemId}`] = {
          ...item,
          createdAt: existing?.createdAt || item.createdAt || timestamp,
          updatedAt: timestamp,
          salesCount: existing?.salesCount || 0,
          priceHistory: existing?.priceHistory || {},
        };
      }
      for (const [itemId, item] of Object.entries(currentItems || {})) {
        const valid = Boolean(item.name?.trim() && item.category && Number(item.priceUah) >= catalog.config.minPriceUah &&
          Number(item.priceUsdt) === Number(item.priceUah) * catalog.config.usdtPerUah);
        if (!catalog.items[itemId] && item.enabled && !valid) {
          updates[`shop_items/${itemId}/enabled`] = false;
          updates[`shop_items/${itemId}/updatedAt`] = timestamp;
        }
      }
      updates.case_drops = { ...catalog.drops, updatedAt: timestamp };
      updates.shop_config = {
        ...currentConfig,
        ...catalog.config,
        createdAt: currentConfig?.createdAt || timestamp,
        updatedAt: timestamp,
      };
      updates[`auditLog/catalog_${timestamp}`] = {
        actorUid: user.uid,
        action: "shop.catalog.seeded",
        payload: { itemCount: Object.keys(catalog.items).length, dropTableCount: Object.keys(catalog.drops).length },
        at: timestamp,
      };

      const result = await rtdbUpdate("", updates);
      if (!result.success) throw new Error(result.error || "Не удалось опубликовать каталог в RTDB.");
      setNotice(`Каталог опубликован: ${Object.keys(catalog.items).length} товаров и ${Object.keys(catalog.drops).length} таблиц дропа.`);
    } finally {
      setBusy(false);
    }
  }

  async function reviewShopOrder(orderId: string, action: "complete" | "reject" | "revoke") {
    const prompts = {
      complete: "Підтверджуйте лише після перевірки фактичного надходження коштів. Активувати покупку?",
      reject: "Відхилити це замовлення?",
      revoke: "Відкликати покупку? Це прибере entitlement у гравця, але не поверне кошти автоматично.",
    };
    if (!window.confirm(prompts[action])) return;
    try {
      type ReviewOrder = ShopOrder & {
        tag?: string | null;
        itemType?: string;
        receiptCode?: string;
        receiptHash?: string;
        receiptReceivedAt?: number;
        telegramUserId?: string;
        telegramChatId?: string;
        completedAt?: number;
        reviewedAt?: number;
        reviewedBy?: string;
        updatedAt?: number;
      };
      const before = await rtdbGet<ReviewOrder>(`orders/${orderId}`);
      if (!before) throw new Error("Заказ не найден в RTDB.");
      if (action === "complete" && before.tag) {
        const tag = await rtdbGet<ShopTag>(`tags/${before.tag}`);
        if (!tag || tag.orderId !== orderId) throw new Error("Резервация тега потеряна. Проверьте заказ вручную.");
      }

      const timestamp = Date.now();
      const transition = await rtdbTransaction<ReviewOrder>(`orders/${orderId}`, (current) => {
        if (!current) return;
        if (action === "complete" && ["pending", "under_review"].includes(current.status)) {
          return { ...current, status: "completed", completedAt: timestamp, reviewedAt: timestamp, reviewedBy: user?.uid || "owner", updatedAt: timestamp };
        }
        if (action === "reject" && ["pending", "under_review"].includes(current.status)) {
          return { ...current, status: "rejected", reviewedAt: timestamp, reviewedBy: user?.uid || "owner", updatedAt: timestamp };
        }
        if (action === "revoke" && current.status === "completed") {
          return { ...current, status: "revoked", reviewedAt: timestamp, reviewedBy: user?.uid || "owner", updatedAt: timestamp };
        }
        return;
      });
      if (!transition.committed || !transition.value) throw new Error("Статус заказа уже изменился. Обновите список и проверьте его.");

      const order = transition.value;
      const updates: Record<string, unknown> = {
        [`auditLog/audit_${timestamp}_${crypto.randomUUID()}`]: {
          actorUid: user?.uid || "unknown",
          action: `shop.order.${order.status}`,
          payload: { orderId, uid: order.uid, email: order.email || null, itemId: order.itemId, amount: order.amount, currency: order.currency },
          at: timestamp,
        },
      };

      if (action === "complete") {
        const completedAt = order.completedAt || timestamp;
        updates[`analytics/sales/${orderId}`] = {
          orderId,
          uid: order.uid,
          email: order.email || null,
          nickname: order.nickname || null,
          itemId: order.itemId,
          itemName: order.itemName,
          itemType: order.itemType || null,
          tag: order.tag || null,
          amount: order.amount,
          currency: order.currency,
          paymentMethod: order.paymentMethod,
          receiptCode: order.receiptCode || null,
          receiptHash: order.receiptHash || null,
          receiptReceivedAt: order.receiptReceivedAt || null,
          telegramUserId: order.telegramUserId || null,
          telegramChatId: order.telegramChatId || null,
          completedAt,
        };
        updates[`entitlements/${order.uid}/${orderId}`] = {
          orderId,
          itemId: order.itemId,
          itemName: order.itemName,
          tag: order.tag || null,
          status: "active",
          activatedAt: completedAt,
        };
        if (order.tag) {
          updates[`tags/${order.tag}/status`] = "active";
          updates[`tags/${order.tag}/activatedAt`] = completedAt;
        }
      } else if (action === "revoke") {
        updates[`entitlements/${order.uid}/${orderId}`] = null;
        updates[`analytics/sales/${orderId}/revokedAt`] = timestamp;
      }

      const write = await rtdbUpdate("", updates);
      if (!write.success) throw new Error(write.error || "Не удалось синхронизировать результат проверки с RTDB.");

      if (action === "complete") {
        await rtdbTransaction<ShopItem & { priceHistory?: Record<string, { price: number; currency: string; at: number; orderId: string }> }>(
          `shop_items/${order.itemId}`,
          (current) => {
            if (!current) return;
            const salesCount = Number(current.salesCount || 0) + 1;
            if (!current.dynamicPrice) return { ...current, salesCount, updatedAt: timestamp };
            const priceKey = order.currency === "UAH" ? "priceUah" : "priceUsdt";
            const stepKey = order.currency === "UAH" ? "priceStepUah" : "priceStepUsdt";
            const nextPrice = Math.round((Number(current[priceKey] || 0) + Number(current[stepKey] || 0)) * 100) / 100;
            const historyKey = `price_${timestamp}_${crypto.randomUUID().slice(0, 8)}`;
            return {
              ...current,
              [priceKey]: nextPrice,
              salesCount,
              updatedAt: timestamp,
              priceHistory: {
                ...(current.priceHistory || {}),
                [historyKey]: { price: nextPrice, currency: order.currency, at: timestamp, orderId },
              },
            };
          },
        );
      } else if ((action === "reject" || action === "revoke") && order.tag) {
        await rtdbTransaction<ShopTag>(`tags/${order.tag}`, (current) => current?.orderId === orderId ? null : undefined);
      }

      setNotice(action === "revoke" ? "Покупку відкликано; повернення коштів не виконувалося." : "Статус замовлення оновлено.");
      await loadPage("sales");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  // Execute RTDB diagnostics
  async function runRtdbDiagnostics() {
    setRtdbDiag((prev) => ({ ...prev, testing: true }));
    const result = await rtdbTestAccess();
    setRtdbDiag({
      testing: false,
      tested: true,
      canRead: result.canRead,
      canWrite: result.canWrite,
      message: result.message,
    });
  }

  // Initialize public configuration and starter content; staff is seeded by a project administrator.
  async function initRtdbStructure() {
    setBusy(true);
    try {
      const now = Date.now();
      // Write /config
      await rtdbSet("config", {
        launcherVersion: "1.0.0",
        maintenance: false,
        registrationOpen: true,
        updatedAt: now,
      });

      // Write starter /news
      await rtdbSet("news/welcome", {
        id: "welcome",
        title: "F Launcher Control Room запущен",
        body: "База данных успешно настроена и подключена.",
        status: "PUBLISHED",
        updatedAt: now,
        author: user?.email || "admin",
      });

      // Run check again
      await runRtdbDiagnostics();
      setNotice("Структура Realtime Database успешно инициализирована во всех ветках!");
      await loadPage(page);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Ошибка инициализации базы: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function signOutUser() {
    await signOut(auth);
    setRole(null);
    setOverview(null);
    setNotice("");
    setError("");
  }

  if (loading) {
    return (
      <div className="boot">
        <span className="loader" />
        <span>Подключение к furry-launcher-default-rtdb...</span>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen onSignIn={signIn} error={error} />;
  }

  // Strict Access Screen: If unauthorized, user CANNOT self-grant role!
  if (!role) {
    return (
      <AccessScreen
        email={user.email || ""}
        uid={user.uid}
        error={error}
        diagnostic={accessDiagnostic}
        onSignOut={signOutUser}
      />
    );
  }

  if (!secondFactor) {
    return (
      <MfaScreen
        phone={phone}
        setPhone={setPhone}
        code={smsCode}
        setCode={setSmsCode}
        sent={Boolean(mfaVerificationId)}
        start={startMfaEnrollment}
        finish={finishMfaEnrollment}
        onSignOut={signOutUser}
        error={error}
        notice={notice}
      />
    );
  }

  const currentPage = nav.find((item) => item.id === page) || nav[0];
  const campaignsWithCounts = campaigns.map((campaign) => ({
    ...campaign,
    activatedCount: activatedCounts[campaign.id] ?? campaign.activatedCount ?? 0,
  }));
  const visibleNav = nav.filter((item) => {
    if (item.id === "staff" || item.id === "audit") return role === "owner";
    if (item.id === "shop" || item.id === "sales") return role === "owner";
    if (role === "marketing") return !["zbt", "players", "errors"].includes(item.id);
    return true;
  });

  const filteredPlayers = players.filter((player) => {
    const matchesQuery = `${player.nickname || ""} ${player.contactEmail || ""} ${player.uid}`.toLowerCase().includes(queryText.toLowerCase());
    if (playerStatusFilter === "ACTIVE") return matchesQuery && player.status !== "BANNED";
    if (playerStatusFilter === "BANNED") return matchesQuery && player.status === "BANNED";
    return matchesQuery;
  });

  const filteredErrors = errors.filter((item) =>
    `${item.title || ""} ${item.area || ""} ${item.status || ""}`.toLowerCase().includes(queryText.toLowerCase())
  );

  const isChiefUser = role === "owner";

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "is-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">F</div>
          <div>
            <strong>F Launcher</strong>
            <span>Control Room · CRM</span>
          </div>
        </div>
        <div className="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav className="primary-nav" aria-label="Разделы CRM">
          {visibleNav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={page === id ? "nav-item active" : "nav-item"}
              onClick={() => {
                setPage(id);
                setMenuOpen(false);
              }}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {id === "errors" && errors.some((item) => item.status === "NEW") && <i className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="secure-note">
            <ShieldCheck size={16} />
            <span>
              {isChiefUser ? "Главный администратор" : "Сотрудник CRM"}
              <br />
              <b>{user.email}</b>
            </span>
          </div>
          <button className="profile-row" onClick={signOutUser} title="Выйти из CRM">
            <span className="avatar">{(user.displayName || user.email || "A").slice(0, 1).toUpperCase()}</span>
            <span className="profile-copy">
              <b>{user.displayName || user.email}</b>
              <small>{role}</small>
            </span>
            <LogOut size={15} />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Открыть меню"
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumbs">
            <span>F Launcher</span>
            <b>/</b>
            <strong>{currentPage.label}</strong>
          </div>
          <div className="top-actions">
            <button
              className="button secondary"
              style={{ padding: "0 10px", height: "30px", fontSize: "10px" }}
              onClick={() => {
                setShowDbModal(true);
                void runRtdbDiagnostics();
              }}
              title="Настройка и диагностика Realtime Database"
            >
              <Database size={14} style={{ color: "#28744a" }} /> База RTDB
            </button>
            <span className="live-indicator" title="Подключено к furry-launcher-default-rtdb">
              <i /> RTDB Online
            </span>
            <button
              className="icon-button"
              onClick={() => loadPage(page)}
              title="Обновить данные из базы"
              disabled={busy}
            >
              <RefreshCw size={17} className={busy ? "spin" : ""} />
            </button>
            <button
              className="help-button"
              title="Справка"
              onClick={() => setShowDbModal(true)}
            >
              <CircleHelp size={17} />
            </button>
          </div>
        </header>

        <section className="page-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">F LAUNCHER / CONTROL</p>
              <h1>{currentPage.label}</h1>
            </div>
            <div className="heading-actions">
              {page === "zbt" && role === "owner" && (
                <button className="button primary" onClick={() => setShowCampaignForm(true)}>
                  <Plus size={16} /> Новая кампания
                </button>
              )}
              {page === "staff" && role === "owner" && (
                <button className="button primary" onClick={() => setShowInviteForm(true)}>
                  <Plus size={16} /> Пригласить сотрудника
                </button>
              )}
              {page === "news" && (role === "owner" || role === "marketing") && (
                <button className="button primary" onClick={() => setShowNewsForm(true)}>
                  <Plus size={16} /> Создать новость
                </button>
              )}
            </div>
          </div>


          {notice && (
            <div className="notice success">
              <Check size={17} />
              <span>{notice}</span>
              <button onClick={() => setNotice("")} aria-label="Закрыть">
                <X size={15} />
              </button>
            </div>
          )}
          {error && (
            <div className="notice danger">
              <AlertTriangle size={17} />
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Закрыть">
                <X size={15} />
              </button>
            </div>
          )}

          {page === "overview" && (
            <OverviewPage
              overview={overview}
              campaigns={campaignsWithCounts}
              errors={errors}
              openPage={setPage}
            />
          )}
          {page === "zbt" && (
            <ZbtPage
              campaigns={campaignsWithCounts}
              zbtEnabled={zbtEnabled}
              onToggleZbt={setZbtTestingEnabled}
              keys={keys}
              selectedCampaign={selectedCampaign}
              selectCampaign={loadKeys}
              setStatus={setCampaignStatus}
              revoke={revokeKey}
              role={role}
              onCreateCampaign={() => setShowCampaignForm(true)}
              onOpenDbModal={() => setShowDbModal(true)}
              copiedKey={copiedKey}
              setCopiedKey={setCopiedKey}
            />
          )}
          {page === "players" && (
            <PlayersPage
              players={filteredPlayers}
              query={queryText}
              setQuery={setQueryText}
              statusFilter={playerStatusFilter}
              setStatusFilter={setPlayerStatusFilter}
              changeStatus={changePlayerStatus}
            />
          )}
          {page === "errors" && (
            <ErrorsPage
              errors={filteredErrors}
              query={queryText}
              setQuery={setQueryText}
              updateStatus={updateError}
            />
          )}
          {page === "news" && (
            <NewsPage
              announcements={announcements}
              onCreateNews={() => setShowNewsForm(true)}
            />
          )}
          {page === "analytics" && <AnalyticsPage overview={overview} />}
          {page === "shop" && <ShopManager items={shopItems} tags={shopTags} onSave={saveShopItem} onPublishCatalog={publishShopCatalog} />}
          {page === "sales" && <SalesDashboard orders={shopOrders} items={shopItems} onReview={reviewShopOrder} />}
          {page === "staff" && (
            <StaffPage
              staff={staff}
              onInvite={() => setShowInviteForm(true)}
            />
          )}
          {page === "audit" && <AuditPage entries={audit} />}
        </section>
      </main>

      {/* Campaign Form Modal */}
      {showCampaignForm && (
        <Modal title="Новая кампания ЗБТ" close={() => setShowCampaignForm(false)}>
          <form className="form-stack" onSubmit={createCampaign}>
            <label>
              Название кампании
              <input
                required
                maxLength={80}
                value={campaignName}
                onChange={(event) => setCampaignName(event.target.value)}
                placeholder="ЗБТ-1 (Весна 2026)"
              />
            </label>
            <label>
              Количество мест / ключей
              <input
                type="number"
                min="1"
                max="500"
                required
                value={campaignSeats}
                onChange={(event) => setCampaignSeats(Number(event.target.value))}
              />
            </label>
            <label>
              Срок действия (необязательно)
              <input
                type="datetime-local"
                value={campaignExpiry}
                onChange={(event) => setCampaignExpiry(event.target.value)}
              />
            </label>
            <p className="form-hint">
              Ключи формата FL-XXXX-XXXX-XXXX сохраняются в Realtime Database (/zbtKeys). CSV-файл сразу скачивается.
            </p>
            <div className="modal-actions">
              <button className="button secondary" type="button" onClick={() => setShowCampaignForm(false)}>
                Отмена
              </button>
              <button className="button primary" disabled={busy}>
                <Download size={15} /> Создать и скачать CSV
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Invite Staff Modal */}
      {showInviteForm && (
        <Modal title="Пригласить сотрудника в CRM" close={() => setShowInviteForm(false)}>
          <form className="form-stack" onSubmit={inviteStaff}>
            <label>
              Firebase Auth UID
              <input
                required
                value={inviteUid}
                onChange={(event) => setInviteUid(event.target.value)}
                placeholder="UID из Authentication → Users"
              />
            </label>
            <label>
              Google-почта сотрудника
              <input
                required
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="colleague@gmail.com"
              />
            </label>
            <label>
              Роль доступа
              <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Role)}>
                <option value="support">Support · Управление игроками, баны и ошибки</option>
                <option value="marketing">Marketing · Публикация новостей в лаунчер</option>
                <option value="owner">Owner · Полный административный доступ</option>
              </select>
            </label>
            <p className="form-hint">
              Документ будет создан как staff/{inviteUid || "UID"}. Email должен совпадать с Google-аккаунтом этого UID.
            </p>
            <div className="modal-actions">
              <button className="button secondary" type="button" onClick={() => setShowInviteForm(false)}>
                Отмена
              </button>
              <button className="button primary">
                <Mail size={15} /> Выдать доступ
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* News Form Modal */}
      {showNewsForm && (
        <Modal title="Новость лаунчера" close={() => setShowNewsForm(false)}>
          <form className="form-stack" onSubmit={saveNews}>
            <label>
              Заголовок новости
              <input
                required
                maxLength={120}
                value={newsTitle}
                onChange={(event) => setNewsTitle(event.target.value)}
                placeholder="Обновление F Launcher"
              />
            </label>
            <label>
              Текст публикации
              <textarea
                required
                maxLength={5000}
                rows={7}
                value={newsBody}
                onChange={(event) => setNewsBody(event.target.value)}
                placeholder="Текст новости для клиентов лаунчера..."
              />
            </label>
            <label>
              Статус публикации
              <select value={newsStatus} onChange={(event) => setNewsStatus(event.target.value)}>
                <option value="DRAFT">Черновик (не виден игрокам)</option>
                <option value="PUBLISHED">Опубликовать в лаунчере (RTDB /news)</option>
              </select>
            </label>
            <div className="modal-actions">
              <button className="button secondary" type="button" onClick={() => setShowNewsForm(false)}>
                Отмена
              </button>
              <button className="button primary">
                <FileText size={15} /> Опубликовать новость
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* RTDB Setup & Diagnostics Modal */}
      {showDbModal && (
        <Modal title="Настройка и диагностика Realtime Database" close={() => setShowDbModal(false)}>
          <div className="form-stack">
            <div style={{ padding: "12px", background: "#f3f6f1", borderRadius: "6px", fontSize: "11px", color: "#324335" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "700" }}>
                  <Server size={15} style={{ color: "#28744a" }} />
                  <span>База: furry-launcher-default-rtdb</span>
                </div>
                <a
                  href={RTDB_DATA_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="external-link"
                  style={{ fontSize: "10px" }}
                >
                  Открыть data/~2F <ExternalLink size={11} />
                </a>
              </div>
              <small className="mono" style={{ display: "block", color: "#657768", wordBreak: "break-all" }}>
                {RTDB_URL}
              </small>
            </div>

            {/* Diagnostic Results */}
            <div style={{ border: "1px solid #e1e7de", borderRadius: "6px", padding: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                <strong style={{ fontSize: "11px" }}>Проверка прав доступа:</strong>
                <button
                  type="button"
                  className="small-button"
                  onClick={() => void runRtdbDiagnostics()}
                  disabled={rtdbDiag.testing}
                >
                  <RefreshCw size={12} className={rtdbDiag.testing ? "spin" : ""} /> {rtdbDiag.testing ? "Проверка..." : "Тестировать"}
                </button>
              </div>

              {rtdbDiag.tested ? (
                <div style={{ display: "grid", gap: "6px", fontSize: "11px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span>Чтение базы:</span>
                    <span className={`status-pill ${rtdbDiag.canRead ? "status-active" : "status-banned"}`}>
                      {rtdbDiag.canRead ? "Разрешено" : "Заблокировано"}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span>Запись в базу:</span>
                    <span className={`status-pill ${rtdbDiag.canWrite ? "status-active" : "status-banned"}`}>
                      {rtdbDiag.canWrite ? "Разрешено ✅" : "Заблокировано (PERMISSION_DENIED) ❌"}
                    </span>
                  </div>
                  {rtdbDiag.message && (
                    <small style={{ color: "#b54437", marginTop: "4px" }}>{rtdbDiag.message}</small>
                  )}
                </div>
              ) : (
                <small style={{ color: "#788478" }}>Нажмите «Тестировать», чтобы проверить права чтения и записи.</small>
              )}
            </div>

            {/* Rules Configuration */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <label style={{ margin: 0, fontWeight: "700", fontSize: "11px" }}>
                  <Lock size={13} style={{ display: "inline", verticalAlign: "middle", marginRight: "4px" }} />
                  Правила для Firebase Realtime Database
                </label>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    type="button"
                    className="small-button"
                    onClick={() => {
                      void navigator.clipboard.writeText(RECOMMENDED_RTDB_RULES);
                      setCopiedRules(true);
                      setTimeout(() => setCopiedRules(false), 2000);
                    }}
                  >
                    {copiedRules ? <Check size={12} /> : <Copy size={12} />} {copiedRules ? "Скопировано!" : "Копировать"}
                  </button>
                  <a
                    href={RTDB_RULES_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="small-button"
                    style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px" }}
                  >
                    Вставить в Rules <ExternalLink size={10} />
                  </a>
                </div>
              </div>

              <p className="form-hint" style={{ marginBottom: "6px" }}>
                В рабочем режиме чтение ограничено ролями RTDB staff и MFA. Не включайте публичные правила .read/.write: true.
              </p>
              <pre style={{ margin: 0, padding: "10px", background: "#1c2e22", color: "#c8e89f", borderRadius: "5px", fontSize: "9px", overflowX: "auto", fontFamily: "ui-monospace, monospace" }}>
                {RECOMMENDED_RTDB_RULES}
              </pre>
            </div>

            {/* One-click Initializer */}
            <div style={{ border: "1px solid #d9e6dc", background: "#f7fbf8", borderRadius: "6px", padding: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "700", fontSize: "12px", color: "#245d3c", marginBottom: "6px" }}>
                <Sparkles size={16} /> Инициализация всех разделов базы
              </div>
              <p style={{ margin: "0 0 10px", fontSize: "10px", color: "#546857", lineHeight: "1.5" }}>
                Создаёт разделы: <b>/admin</b>, <b>/staff</b>, <b>/config</b>, <b>/news</b>, <b>/players</b>, <b>/bans</b>.
              </p>
              <button
                type="button"
                className="button primary"
                onClick={() => void initRtdbStructure()}
                disabled={busy}
              >
                <CheckCheck size={14} /> Создать структуру базы сейчас
              </button>
            </div>

            <div className="modal-actions">
              <button className="button secondary" type="button" onClick={() => setShowDbModal(false)}>
                Закрыть
              </button>
            </div>
          </div>
        </Modal>
      )}

      <div id="mfa-recaptcha" />
    </div>
  );
}

function LoginScreen({ onSignIn, error }: { onSignIn: () => void; error: string }) {
  return (
    <div className="login-screen">
      <div className="login-grid" />
      <div className="login-panel">
        <div className="brand-mark large">F</div>
        <p className="eyebrow">F LAUNCHER / INTERNAL</p>
        <h1>Панель<br />управления</h1>
        <p className="login-intro">
          Внутренний шлюз F Launcher CRM. Вход разрешён исключительно сотрудникам с выданными главным администратором правами.
        </p>
        {error && (
          <div className="notice danger">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}
        <button className="google-button" onClick={onSignIn}>
          <GoogleMark /> Войти через Google
        </button>
        <div className="login-security">
          <ShieldCheck size={16} />
          <span>Realtime Database · Строгая RBAC защита</span>
        </div>
        <small className="login-footer">
          Роль сотрудника проверяется по RTDB staff/{"UID"}; MFA обязательна.
        </small>
        <div id="mfa-recaptcha" />
      </div>
      <div className="login-aside">
        <span>01 — CONTROL ROOM</span>
        <div className="aside-rule" />
        <p>Операционная<br />панель лаунчера</p>
        <small>BUILD · SUPPORT · COMMUNITY</small>
      </div>
    </div>
  );
}

function AccessScreen({
  email,
  uid,
  error,
  diagnostic,
  onSignOut,
}: {
  email: string;
  uid: string;
  error: string;
  diagnostic: string;
  onSignOut: () => void;
}) {
  return (
    <div className="gate-screen">
      <div className="gate-box">
        <div className="gate-icon" style={{ background: "#fbebe8", color: "#b54437" }}>
          <ShieldAlert size={26} />
        </div>
        <p className="eyebrow" style={{ color: "#b54437" }}>ДОСТУП ЗАПРЕЩЁН</p>
        <h1 style={{ fontSize: "20px" }}>Аккаунт не авторизован</h1>
        <p style={{ lineHeight: "1.6" }}>
          Аккаунт <b>{email}</b> (UID: {uid.slice(0, 8)}...) не имеет прав доступа к панели управления F Launcher.
        </p>
        <div style={{ padding: "12px", background: "#f5f7f3", borderRadius: "6px", fontSize: "10px", color: "#627063", margin: "14px 0", textAlign: "left" }}>
          {diagnostic || `Проверьте документ RTDB staff/${uid}: email должен совпадать, роль — owner, support или marketing.`}
        </div>
        {error && <div className="notice danger" style={{ marginTop: "10px" }}><span>{error}</span></div>}
        <button className="button secondary wide" onClick={onSignOut} style={{ marginTop: "8px" }}>
          <LogOut size={15} /> Выйти из аккаунта
        </button>
      </div>
      <div id="mfa-recaptcha" />
    </div>
  );
}

function MfaScreen(props: {
  phone: string;
  setPhone: (v: string) => void;
  code: string;
  setCode: (v: string) => void;
  sent: boolean;
  start: () => void;
  finish: () => void;
  onSignOut: () => void;
  error: string;
  notice: string;
}) {
  return (
    <div className="gate-screen">
      <div className="gate-box">
        <div className="gate-icon">
          <ShieldCheck size={25} />
        </div>
        <p className="eyebrow">ЗАЩИТА СЕССИИ</p>
        <h1>Двухфакторная проверка</h1>
        <p>
          Подтвердите вход через SMS, чтобы открыть CRM.
        </p>
        {props.error && (
          <div className="notice danger">
            <AlertTriangle size={16} />
            <span>{props.error}</span>
          </div>
        )}
        {props.notice && (
          <div className="notice success">
            <Check size={16} />
            <span>{props.notice}</span>
          </div>
        )}
        <label className="mfa-label">
          Номер телефона
          <input
            type="tel"
            value={props.phone}
            onChange={(event) => props.setPhone(event.target.value)}
            placeholder="+380991234567"
          />
        </label>
        {!props.sent ? (
          <button className="button primary wide" onClick={props.start}>
            Отправить SMS-код
          </button>
        ) : (
          <>
            <label className="mfa-label">
              Код из SMS
              <input
                inputMode="numeric"
                value={props.code}
                onChange={(event) => props.setCode(event.target.value)}
                placeholder="6-значный код"
              />
            </label>
            <button className="button primary wide" onClick={props.finish}>
              Подтвердить телефон
            </button>
          </>
        )}
        <button className="text-button" onClick={props.onSignOut}>
          Выйти из аккаунта
        </button>
        <div id="mfa-recaptcha" />
      </div>
    </div>
  );
}

function OverviewPage({
  overview,
  campaigns,
  errors,
  openPage,
}: {
  overview: Overview | null;
  campaigns: Campaign[];
  errors: CrmError[];
  openPage: (page: Page) => void;
}) {
  const activeCampaigns = campaigns.filter((campaign) => campaign.status === "ACTIVE").length;
  const newErrors = errors.filter((item) => item.status === "NEW").length;
  const activatedKeysTotal = campaigns.reduce((sum, campaign) => sum + (campaign.activatedCount || 0), 0);

  return (
    <>
      <div className="summary-grid">
        <Stat
          label="Всего игроков"
          value={overview?.playerCount ?? 0}
          detail="в базе furry-launcher"
          icon={Users}
          tint="green"
        />
        <Stat
          label="Активные кампании"
          value={activeCampaigns}
          detail="ЗБТ-доступ"
          icon={KeyRound}
          tint="blue"
        />
        <Stat
          label="Новые ошибки"
          value={newErrors}
          detail="требуют внимания"
          icon={AlertTriangle}
          tint="orange"
        />
        <Stat
          label="Ключи использованы"
          value={activatedKeysTotal}
          detail="за всё время"
          icon={Check}
          tint="dark"
        />
      </div>
      <div className="section-grid">
        <section className="section-block">
          <div className="section-head">
            <div>
              <p className="eyebrow">ACCESS</p>
              <h2>Кампании ЗБТ</h2>
            </div>
            <button className="link-button" onClick={() => openPage("zbt")}>
              Все кампании <ChevronDown size={14} />
            </button>
          </div>
          {campaigns.length ? (
            <div className="compact-list">
              {campaigns.slice(0, 5).map((campaign) => (
                <div className="compact-row" key={campaign.id}>
                  <span className="status-mark" data-status={campaign.status} />
                  <div className="row-main">
                    <b>{campaign.name}</b>
                    <small>
                      {campaign.activatedCount} / {campaign.seats} мест · {campaign.status}
                    </small>
                  </div>
                  <span className="row-date">{dateLabel(campaign.createdAt)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState text="Кампаний ЗБТ пока нет" />
          )}
        </section>
        <section className="section-block">
          <div className="section-head">
            <div>
              <p className="eyebrow">SUPPORT</p>
              <h2>Ошибки лаунчера</h2>
            </div>
            <button className="link-button" onClick={() => openPage("errors")}>
              Открыть <ChevronDown size={14} />
            </button>
          </div>
          {errors.length ? (
            <div className="compact-list">
              {errors.slice(0, 5).map((item) => (
                <div className="compact-row" key={item.id}>
                  <span className="error-icon">
                    <AlertTriangle size={14} />
                  </span>
                  <div className="row-main">
                    <b>{item.title || item.area}</b>
                    <small>
                      {item.area} · {item.occurrences || 1} случаев
                    </small>
                  </div>
                  <StatusPill value={item.status} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState text="Нет зарегистрированных ошибок" />
          )}
        </section>
      </div>
      <div className="bottom-note">
        <ShieldCheck size={17} />
        <span>
          База данных: <b>{RTDB_URL}/</b> активна и синхронизирована с CRM.
        </span>
      </div>
    </>
  );
}

function ZbtPage(props: {
  campaigns: Campaign[];
  zbtEnabled: boolean;
  onToggleZbt: (enabled: boolean) => void;
  keys: ZbtKey[];
  selectedCampaign: string;
  selectCampaign: (id: string) => void;
  setStatus: (id: string, status: string) => void;
  revoke: (id: string, storagePath?: "keys" | "zbtKeys") => void;
  role: Role;
  onCreateCampaign: () => void;
  onOpenDbModal: () => void;
  copiedKey: string;
  setCopiedKey: (k: string) => void;
}) {
  return (
    <div className="data-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">BETA ACCESS</p>
          <h2>Кампании и активации ЗБТ ({props.campaigns.length})</h2>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          {props.role === "owner" && (
            <label className="shop-checkbox" style={{ margin: 0 }}>
              <input type="checkbox" checked={props.zbtEnabled} onChange={(event) => void props.onToggleZbt(event.target.checked)} />
              Тестирование ЗБТ
            </label>
          )}
          <button
            className="button secondary"
            style={{ height: "30px", fontSize: "10px", padding: "0 10px" }}
            onClick={props.onOpenDbModal}
            title="Проверить статус подключения к Realtime Database"
          >
            <Lock size={12} /> Правила RTDB
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>КАМПАНИЯ</th>
              <th>СОСТОЯНИЕ</th>
              <th>МЕСТА</th>
              <th>СОЗДАНА</th>
              <th>ДЕЙСТВИЯ</th>
            </tr>
          </thead>
          <tbody>
            {props.campaigns.map((campaign) => (
              <tr key={campaign.id} className={props.selectedCampaign === campaign.id ? "selected-row" : ""}>
                <td>
                  <button className="table-primary" onClick={() => props.selectCampaign(campaign.id)}>
                    {campaign.name}
                  </button>
                  <small className="cell-id">{campaign.id}</small>
                </td>
                <td>
                  <StatusPill value={campaign.status} />
                </td>
                <td>
                  <b>{campaign.activatedCount}</b>
                  <span className="muted"> / {campaign.seats}</span>
                </td>
                <td>{dateLabel(campaign.createdAt)}</td>
                <td>
                  <div className="table-actions">
                    <button className="small-button" onClick={() => props.selectCampaign(campaign.id)}>
                      Ключи ({campaign.activatedCount})
                    </button>
                    {props.role === "owner" && (
                      <button
                        className="small-button"
                        onClick={() =>
                          props.setStatus(campaign.id, campaign.status === "ACTIVE" ? "CLOSED" : "ACTIVE")
                        }
                      >
                        {campaign.status === "ACTIVE" ? "Закрыть" : "Открыть"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!props.campaigns.length && (
              <tr>
                <td colSpan={5}>
                  <div style={{ padding: "20px", textAlign: "center" }}>
                    <p style={{ margin: "0 0 10px", fontSize: "11px", color: "#788478" }}>
                      Кампаний ЗБТ пока нет.
                    </p>
                    {props.role === "owner" && (
                      <button className="button primary" onClick={props.onCreateCampaign}>
                        <Plus size={15} /> Создать кампанию
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {props.selectedCampaign && (
        <div className="key-list">
          <div className="section-head">
            <div>
              <p className="eyebrow">CAMPAIGN KEYS</p>
              <h3>Ключи выбранной кампании ({props.keys.length})</h3>
            </div>
            <span className="subtle">Ключи хранятся в RTDB /zbtKeys и /keys</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>КЛЮЧ ЗБТ</th>
                  <th>СТАТУС</th>
                  <th>ИГРОК</th>
                  <th>UID ИГРОКА</th>
                  <th>ДАТА СОЗДАНИЯ / АКТИВАЦИИ</th>
                  <th>ДЕЙСТВИЕ</th>
                </tr>
              </thead>
              <tbody>
                {props.keys.map((item) => {
                  const raw = item.rawKey || item.id;
                  const isCopied = props.copiedKey === item.id;
                  return (
                    <tr key={item.id}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <code className="mono" style={{ fontWeight: "700", color: "#19422b", fontSize: "10px", background: "#f0f5ee", padding: "2px 6px", borderRadius: "3px" }}>
                            {raw}
                          </code>
                          <button
                            type="button"
                            className="icon-button"
                            style={{ width: "22px", height: "22px" }}
                            onClick={() => {
                              void navigator.clipboard.writeText(raw);
                              props.setCopiedKey(item.id);
                              setTimeout(() => props.setCopiedKey(""), 2000);
                            }}
                            title="Скопировать ключ"
                          >
                            {isCopied ? <Check size={12} style={{ color: "#28744a" }} /> : <Copy size={12} />}
                          </button>
                        </div>
                      </td>
                      <td>
                        <StatusPill value={item.status} />
                      </td>
                      <td>{item.nickname || "—"}</td>
                      <td className="mono">{item.activatedBy || "—"}</td>
                      <td>{dateLabel(item.activatedAt || item.createdAt)}</td>
                      <td>
                        {props.role === "owner" && item.status !== "REVOKED" && (
                          <button
                            className="icon-button danger-icon"
                            onClick={() => props.revoke(item.id, item.storagePath)}
                            title="Отозвать ключ ЗБТ"
                          >
                            <Ban size={15} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!props.keys.length && (
                  <tr>
                    <td colSpan={6}>
                      <EmptyState text="Для этой кампании пока нет записей ключей" />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function PlayersPage(props: {
  players: Player[];
  query: string;
  setQuery: (v: string) => void;
  statusFilter: "ALL" | "ACTIVE" | "BANNED";
  setStatusFilter: (v: "ALL" | "ACTIVE" | "BANNED") => void;
  changeStatus: (player: Player) => void;
}) {
  const activeCount = props.players.filter((p) => p.status !== "BANNED").length;
  const bannedCount = props.players.filter((p) => p.status === "BANNED").length;

  return (
    <div className="data-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">PLAYER DIRECTORY & BANS</p>
          <h2>База игроков и блокировки ({props.players.length})</h2>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {/* Segmented Filter */}
          <div style={{ display: "flex", background: "#edf1ea", padding: "2px", borderRadius: "5px", gap: "2px" }}>
            <button
              className="small-button"
              style={props.statusFilter === "ALL" ? { background: "#fff", fontWeight: "700" } : { background: "transparent", border: "none" }}
              onClick={() => props.setStatusFilter("ALL")}
            >
              Все ({props.players.length})
            </button>
            <button
              className="small-button"
              style={props.statusFilter === "ACTIVE" ? { background: "#fff", fontWeight: "700" } : { background: "transparent", border: "none" }}
              onClick={() => props.setStatusFilter("ACTIVE")}
            >
              Активные ({activeCount})
            </button>
            <button
              className="small-button"
              style={props.statusFilter === "BANNED" ? { background: "#fff", fontWeight: "700", color: "#b54437" } : { background: "transparent", border: "none" }}
              onClick={() => props.setStatusFilter("BANNED")}
            >
              Заблокированные ({bannedCount})
            </button>
          </div>
          <SearchBox
            value={props.query}
            setValue={props.setQuery}
            placeholder="Ник, почта или UID"
          />
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ИГРОК</th>
              <th>КОНТАКТ</th>
              <th>СТАТУС В БАЗЕ</th>
              <th>КАМПАНИЯ</th>
              <th>СТАТИСТИКА</th>
              <th>ПОСЛЕДНЯЯ АКТИВНОСТЬ</th>
              <th>БЛОКИРОВКА (RTDB /bans)</th>
            </tr>
          </thead>
          <tbody>
            {props.players.map((player) => {
              const isBanned = player.status === "BANNED";
              return (
                <tr key={player.uid} style={isBanned ? { background: "#fff5f4" } : {}}>
                  <td>
                    <b>{player.nickname || "Игрок без ника"}</b>
                    <small className="cell-id mono">{player.uid}</small>
                  </td>
                  <td>{player.contactEmail || "—"}</td>
                  <td>
                    <StatusPill value={player.status || "ACTIVE"} />
                  </td>
                  <td>{player.zbtCampaignId || "—"}</td>
                  <td>{player.launchCount || 0} запусков<small>{Math.floor((player.totalPlayMinutes || 0) / 60)} ч в игре · {player.lastVersion || "версия не записана"}</small></td>
                  <td>{dateLabel(player.lastSeenAt)}</td>
                  <td>
                    <button
                      className={`small-button ${isBanned ? "" : "danger-button"}`}
                      onClick={() => props.changeStatus(player)}
                    >
                      {isBanned ? "Разблокировать (снять бан)" : "Заблокировать (бан)"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {!props.players.length && (
              <tr>
                <td colSpan={7}>
                  <EmptyState text="Игроки появятся после первого входа в лаунчер или активации ЗБТ" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ErrorsPage(props: {
  errors: CrmError[];
  query: string;
  setQuery: (v: string) => void;
  updateStatus: (item: CrmError, status: string) => void;
}) {
  return (
    <div className="data-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">ISSUE TRIAGE</p>
          <h2>Журнал ошибок лаунчера ({props.errors.length})</h2>
        </div>
        <SearchBox
          value={props.query}
          setValue={props.setQuery}
          placeholder="Поиск по тексту ошибки или модулю"
        />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ОШИБКА</th>
              <th>СТАТУС</th>
              <th>СЛУЧАЕВ</th>
              <th>ИГРОКОВ</th>
              <th>ПОСЛЕДНИЙ СЛУЧАЙ</th>
              <th>ИЗМЕНИТЬ СТАТУС</th>
            </tr>
          </thead>
          <tbody>
            {props.errors.map((item) => (
              <tr key={item.id}>
                <td>
                  <b>{item.title || item.area || "Неизвестная ошибка"}</b>
                  <small className="cell-id">
                    {item.area} · {item.version || "версия неизвестна"}
                  </small>
                </td>
                <td>
                  <StatusPill value={item.status || "NEW"} />
                </td>
                <td>{item.occurrences || 1}</td>
                <td>{item.affectedPlayers || 1}</td>
                <td>{dateLabel(item.updatedAt)}</td>
                <td>
                  <select
                    className="table-select"
                    value={item.status || "NEW"}
                    onChange={(event) => props.updateStatus(item, event.target.value)}
                  >
                    <option value="NEW">Новая (NEW)</option>
                    <option value="IN_PROGRESS">В работе (IN_PROGRESS)</option>
                    <option value="RESOLVED">Решена (RESOLVED)</option>
                    <option value="IGNORED">Игнорировать (IGNORED)</option>
                  </select>
                </td>
              </tr>
            ))}
            {!props.errors.length && (
              <tr>
                <td colSpan={6}>
                  <EmptyState text="Ошибок не зафиксировано. Лаунчер работает стабильно!" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NewsPage({
  announcements,
  onCreateNews,
}: {
  announcements: Announcement[];
  onCreateNews: () => void;
}) {
  return (
    <div className="data-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">PLAYER COMMUNICATION</p>
          <h2>Новости лаунчера ({announcements.length})</h2>
        </div>
        <span className="subtle">Публикация в Realtime Database (/news) для клиентов лаунчера</span>
      </div>
      <div className="news-list">
        {announcements.map((item) => (
          <article className="news-row" key={item.id}>
            <div className="news-date">
              <Clock3 size={15} />
              {dateLabel(item.updatedAt)}
            </div>
            <div className="news-copy">
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </div>
            <StatusPill value={item.status} />
          </article>
        ))}
        {!announcements.length && (
          <div style={{ padding: "30px", textAlign: "center" }}>
            <p style={{ margin: "0 0 12px", fontSize: "11px", color: "#778478" }}>
              Новостей пока нет. Создайте новость для отображения в лаунчере.
            </p>
            <button className="button primary" onClick={onCreateNews}>
              <Plus size={15} /> Создать новость
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AnalyticsPage({ overview }: { overview: Overview | null }) {
  const daily = overview?.daily ?? [];
  return (
    <div className="data-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">PRODUCT SIGNALS</p>
          <h2>Аналитика активности</h2>
        </div>
        <span className="subtle">Статистика за последние 30 дней</span>
      </div>
      <div className="summary-grid analytics-summary">
        <Stat
          label="Всего игроков"
          value={overview?.playerCount ?? 0}
          detail="в базе лаунчера"
          icon={Users}
          tint="green"
        />
        <Stat
          label="Дней в выборке"
          value={daily.length}
          detail="записей в базе"
          icon={Activity}
          tint="blue"
        />
        <Stat
          label="Событий за сутки"
          value={daily[0]?.events ?? 0}
          detail="активность игроков"
          icon={Clock3}
          tint="orange"
        />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ДАТА</th>
              <th>АКТИВНЫЕ ИГРОКИ</th>
              <th>КОЛИЧЕСТВО СОБЫТИЙ</th>
            </tr>
          </thead>
          <tbody>
            {daily.map((day) => (
              <tr key={day.id}>
                <td>{day.date || day.id}</td>
                <td>{day.activePlayers ?? "—"}</td>
                <td>{day.events ?? 0}</td>
              </tr>
            ))}
            {!daily.length && (
              <tr>
                <td colSpan={3}>
                  <EmptyState text="Дневная статистика появится по мере активности игроков" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StaffPage({
  staff,
  onInvite,
}: {
  staff: StaffMember[];
  onInvite: () => void;
}) {
  return (
    <div className="data-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">ACCESS CONTROL</p>
          <h2>Сотрудники и права доступа ({staff.length})</h2>
        </div>
        <button className="button primary" onClick={onInvite}>
          <Plus size={14} /> Пригласить сотрудника
        </button>
      </div>
      <div className="role-strip">
        <span>
          <b>Owner</b> Полный контроль CRM
        </span>
        <span>
          <b>Support</b> Игроки, баны и разбор ошибок
        </span>
        <span>
          <b>Marketing</b> Публикация новостей
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>СОТРУДНИК</th>
              <th>РОЛЬ</th>
              <th>СТАТУС В БАЗЕ</th>
              <th>ДАТА ДОБАВЛЕНИЯ</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((member) => {
              const isChief = member.role === "owner";
              return (
                <tr key={member.id || member.email} style={isChief ? { background: "#f8fbf6" } : {}}>
                  <td>
                    <b>{member.displayName || member.email} {isChief && "👑"}</b>
                    <small className="cell-id">{member.email}</small>
                  </td>
                  <td>
                    <span className={`role-pill ${member.role === "owner" ? "owner" : ""}`}>
                      {member.role}
                    </span>
                  </td>
                  <td>
                    <span className="permission-check">
                      <Check size={14} /> Подтверждён в CRM
                    </span>
                  </td>
                  <td>{dateLabel(member.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AuditPage({ entries }: { entries: AuditEntry[] }) {
  return (
    <div className="data-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">ADMIN AUDIT</p>
          <h2>Журнал аудита ({entries.length})</h2>
        </div>
        <span className="subtle">Синхронизируется в RTDB /auditLog</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ВРЕМЯ</th>
              <th>СОТРУДНИК (UID)</th>
              <th>ДЕЙСТВИЕ</th>
              <th>ДЕТАЛИ ОПЕРАЦИИ</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{dateLabel(entry.at)}</td>
                <td className="mono">{entry.actorUid}</td>
                <td>
                  <span className="role-pill">{entry.action}</span>
                </td>
                <td className="audit-detail">{JSON.stringify(entry.payload)}</td>
              </tr>
            ))}
            {!entries.length && (
              <tr>
                <td colSpan={4}>
                  <EmptyState text="Журнал аудита пуст. Все действия будут фиксироваться здесь." />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
  icon: Icon,
  tint,
}: {
  label: string;
  value: React.ReactNode;
  detail: string;
  icon: typeof Users;
  tint: string;
}) {
  return (
    <div className="stat">
      <div className={`stat-icon ${tint}`}>
        <Icon size={18} />
      </div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function StatusPill({ value }: { value: string }) {
  const normalized = (value || "").toUpperCase();
  const label: Record<string, string> = {
    ACTIVE: "Активен",
    CLOSED: "Закрыта",
    UNUSED: "Не использован",
    ACTIVATED: "Активирован",
    REVOKED: "Отозван",
    EXPIRED: "Истёк",
    BANNED: "Заблокирован",
    NEW: "Новая",
    IN_PROGRESS: "В работе",
    RESOLVED: "Решена",
    IGNORED: "Игнор",
    PUBLISHED: "Опубликовано",
    DRAFT: "Черновик",
  };

  return (
    <span className={`status-pill status-${normalized.toLowerCase()}`}>
      {label[normalized] || value}
    </span>
  );
}

function SearchBox({
  value,
  setValue,
  placeholder,
}: {
  value: string;
  setValue: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search-box">
      <Search size={16} />
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <span>
        <FileText size={18} />
      </span>
      <p>{text}</p>
    </div>
  );
}

function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section className="modal">
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={close} title="Закрыть">
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function GoogleMark() {
  return <span className="google-mark" aria-hidden="true">G</span>;
}
