import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity, AlertTriangle, Ban, Check, ChevronDown, CircleHelp,
  Clock3, FileText, KeyRound, LayoutDashboard, LogOut, Mail, Menu, Plus, RefreshCw,
  Search, ShieldCheck, ShieldAlert, Users, X,
} from "lucide-react";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  collection, doc, getCountFromServer, getDoc, getDocs, limit, orderBy, query,
  where, type QueryConstraint,
} from "firebase/firestore";
import {
  auth, beginGoogleSignIn, call, db, enrollPhoneMfa, isSecondFactorSession, multiFactor,
  RecaptchaVerifier, signOut,
} from "./firebase";

type Role = "owner" | "support" | "marketing";
type Page = "overview" | "zbt" | "players" | "errors" | "news" | "staff" | "analytics" | "audit";
type Campaign = { id: string; name: string; seats: number; status: string; activatedCount: number; createdAt?: number; expiresAt?: number | null };
type Player = { uid: string; nickname: string; contactEmail: string; status: string; zbtCampaignId?: string; lastSeenAt?: number };
type ZbtKey = { id: string; status: string; activatedBy?: string; nickname?: string; installId?: string; activatedAt?: number };
type CrmError = { id: string; fingerprint: string; title: string; area: string; status: string; occurrences: number; affectedPlayers: number; updatedAt?: number; version?: string };
type Announcement = { id: string; title: string; body: string; status: string; updatedAt?: number };
type StaffMember = { id: string; email: string; displayName?: string; role: Role };
type AuditEntry = { id: string; actorUid: string; action: string; payload: Record<string, unknown>; at?: number };
type Overview = { playerCount: number; campaigns: Campaign[]; errors: CrmError[]; daily: Array<{ id: string; date?: string; activePlayers?: number; events?: number }> };

const nav: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Обзор", icon: LayoutDashboard },
  { id: "zbt", label: "ЗБТ-ключи", icon: KeyRound },
  { id: "players", label: "Игроки", icon: Users },
  { id: "errors", label: "Ошибки", icon: AlertTriangle },
  { id: "news", label: "Новости", icon: FileText },
  { id: "analytics", label: "Аналитика", icon: Activity },
  { id: "staff", label: "Сотрудники", icon: ShieldCheck },
  { id: "audit", label: "Журнал действий", icon: Clock3 },
];

function dateLabel(value?: number) {
  return value ? new Date(value).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function errorText(error: unknown) {
  if (typeof error === "object" && error && "code" in error && error.code === "functions/internal") {
    return "Cloud Function вернула INTERNAL. В Firebase Console откройте логи функции, вызванной этой операцией.";
  }
  if (typeof error === "object" && error && "message" in error) {
    const message = String(error.message).replace(/^Firebase: /, "");
    if (message.toLowerCase().includes("client is offline")) {
      return "CRM не может подключиться к Firestore. В Netlify проверьте VITE_FIREBASE_PROJECT_ID=furry-launcher; в Firebase Console убедитесь, что Firestore создан в проекте furry-launcher. Также проверьте соединение и блокировщики запросов к firestore.googleapis.com.";
    }
    return message;
  }
  return "Не удалось выполнить операцию.";
}

function timestampMillis(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") {
    return value.toMillis();
  }
  return undefined;
}

function firestoreRow<T>(id: string, data: Record<string, unknown>): T {
  return {
    ...data,
    id,
    createdAt: timestampMillis(data.createdAt),
    expiresAt: timestampMillis(data.expiresAt),
    lastSeenAt: timestampMillis(data.lastSeenAt),
    activatedAt: timestampMillis(data.activatedAt),
    updatedAt: timestampMillis(data.updatedAt),
    publishedAt: timestampMillis(data.publishedAt),
    firstSeenAt: timestampMillis(data.firstSeenAt),
    at: timestampMillis(data.at),
  } as unknown as T;
}

async function readRows<T>(path: string, ...constraints: QueryConstraint[]): Promise<T[]> {
  const result = await getDocs(query(collection(db, path), ...constraints));
  return result.docs.map((item) => firestoreRow<T>(item.id, item.data()));
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
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [errors, setErrors] = useState<CrmError[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [keys, setKeys] = useState<ZbtKey[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCampaignForm, setShowCampaignForm] = useState(false);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [showNewsForm, setShowNewsForm] = useState(false);
  const [campaignName, setCampaignName] = useState("");
  const [campaignSeats, setCampaignSeats] = useState(50);
  const [campaignExpiry, setCampaignExpiry] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("support");
  const [newsTitle, setNewsTitle] = useState("");
  const [newsBody, setNewsBody] = useState("");
  const [newsStatus, setNewsStatus] = useState("DRAFT");
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [mfaVerificationId, setMfaVerificationId] = useState("");
  const mfaVerifier = useRef<RecaptchaVerifier | null>(null);

  useEffect(() => onAuthStateChanged(auth, async (currentUser) => {
    setUser(currentUser);
    setRole(null);
    setSecondFactor(false);
    setLoading(true);
    if (!currentUser) { setLoading(false); return; }
    try {
      const staffSnapshot = await getDoc(doc(db, "staff", currentUser.uid));
      const staffData = staffSnapshot.exists() ? staffSnapshot.data() : null;
      const tokenEmail = currentUser.email?.trim().toLowerCase() || "";
      const staffEmail = String(staffData?.email || "").trim().toLowerCase();
      const roleValue = staffData?.role;
      const roleValid = roleValue === "owner" || roleValue === "support" || roleValue === "marketing";
      const role = roleValid && staffEmail === tokenEmail ? roleValue as Role : null;
      setRole(role);
      setAccessDiagnostic(!staffSnapshot.exists
        ? `Не найден документ staff/${currentUser.uid} в выбранном Firebase-проекте.`
        : !roleValid
          ? `Документ найден, но роль «${String(roleValue || "пустая")}» недопустима. Разрешены owner, support, marketing.`
          : staffEmail !== tokenEmail
            ? `Email Google (${currentUser.email || "нет"}) не совпадает с email в Firestore (${String(staffData?.email || "нет")}).`
            : "Роль найдена. Если вход всё ещё закрыт, включите и подтвердите MFA, затем войдите снова.");
      setSecondFactor(await isSecondFactorSession(currentUser));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }), []);

  useEffect(() => {
    if (!user || !secondFactor || !role) return;
    void loadPage(page);
  }, [user, secondFactor, role, page]);

  async function loadPage(target: Page) {
    setBusy(true);
    setError("");
    try {
      if (target === "overview" || target === "analytics") {
        const [playerCount, campaignRows, errorRows, dailyRows] = await Promise.all([
          role === "marketing" ? Promise.resolve(0) : getCountFromServer(collection(db, "players")).then((count) => count.data().count),
          role === "marketing" ? Promise.resolve([] as Campaign[]) : readRows<Campaign>("zbtCampaigns", orderBy("createdAt", "desc"), limit(50)),
          role === "marketing" ? Promise.resolve([] as CrmError[]) : readRows<CrmError>("errorGroups", orderBy("updatedAt", "desc"), limit(20)),
          readRows<{ id: string; date?: string; activePlayers?: number; events?: number }>("dailyAnalytics", orderBy("date", "desc"), limit(30)),
        ]);
        setOverview({ playerCount, campaigns: campaignRows, errors: errorRows, daily: dailyRows });
        setCampaigns(campaignRows);
        setErrors(errorRows);
      }
      if (target === "zbt") {
        const campaignRows = await readRows<Campaign>("zbtCampaigns", orderBy("createdAt", "desc"), limit(50));
        setCampaigns(campaignRows);
        if (selectedCampaign) await loadKeys(selectedCampaign);
      }
      if (target === "players") {
        const playerRows = await readRows<Omit<Player, "uid"> & { id: string }>("players", orderBy("lastSeenAt", "desc"), limit(200));
        setPlayers(playerRows.map(({ id, ...player }) => ({ ...player, uid: id })));
      }
      if (target === "errors") setErrors(await readRows<CrmError>("errorGroups", orderBy("updatedAt", "desc"), limit(100)));
      if (target === "news") setAnnouncements(await readRows<Announcement>("announcements", orderBy("updatedAt", "desc"), limit(100)));
      if (target === "staff") setStaff(await readRows<StaffMember>("staff", orderBy("email", "asc")));
      if (target === "audit") setAudit(await readRows<AuditEntry>("auditLog", orderBy("at", "desc"), limit(200)));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function loadKeys(campaignId: string) {
    setSelectedCampaign(campaignId);
    setKeys(await readRows<ZbtKey>("zbtKeys", where("campaignId", "==", campaignId), limit(500)));
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
      if (!mfaVerifier.current) mfaVerifier.current = new RecaptchaVerifier(auth, "mfa-recaptcha", { size: "invisible" });
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
      setNotice("Телефон подтверждён как второй фактор. Войдите снова и подтвердите SMS-код.");
      setMfaVerificationId("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function createCampaign(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await call<{ campaignId: string; name: string; keys: string[]; csv: string; warning: string }>("createZbtCampaign", {
        name: campaignName,
        seats: campaignSeats,
        expiresAtMs: campaignExpiry ? new Date(campaignExpiry).getTime() : null,
      });
      const file = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(file);
      link.download = `${result.name.replace(/[^\p{L}\p{N}-]+/gu, "-")}-keys.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
      setNotice(result.warning);
      setCampaignName("");
      setShowCampaignForm(false);
      await loadPage("zbt");
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function setCampaignStatus(campaignId: string, status: string) {
    try { await call("setCampaignStatus", { campaignId, status }); await loadPage("zbt"); }
    catch (cause) { setError(errorText(cause)); }
  }

  async function revokeKey(keyId: string) {
    if (!window.confirm("Отозвать этот ключ? Доступ игрока будет отключён.")) return;
    try { await call("revokeZbtKey", { keyId }); await loadKeys(selectedCampaign); }
    catch (cause) { setError(errorText(cause)); }
  }

  async function inviteStaff(event: FormEvent) {
    event.preventDefault();
    try {
      await call("inviteStaff", { email: inviteEmail, role: inviteRole });
      setInviteEmail(""); setShowInviteForm(false); setNotice("Приглашение сохранено."); await loadPage("staff");
    } catch (cause) { setError(errorText(cause)); }
  }

  async function changePlayerStatus(player: Player) {
    const status = player.status === "BANNED" ? "ACTIVE" : "BANNED";
    if (!window.confirm(status === "BANNED" ? `Заблокировать ${player.nickname || player.uid}?` : "Снять блокировку?")) return;
    try { await call("setPlayerStatus", { uid: player.uid, status }); await loadPage("players"); }
    catch (cause) { setError(errorText(cause)); }
  }

  async function updateError(errorItem: CrmError, status: string) {
    try { await call("updateErrorStatus", { fingerprint: errorItem.fingerprint, status }); await loadPage("errors"); }
    catch (cause) { setError(errorText(cause)); }
  }

  async function saveNews(event: FormEvent) {
    event.preventDefault();
    try {
      await call("saveAnnouncement", { title: newsTitle, body: newsBody, status: newsStatus });
      setNewsTitle(""); setNewsBody(""); setShowNewsForm(false); setNotice("Новость сохранена."); await loadPage("news");
    } catch (cause) { setError(errorText(cause)); }
  }

  async function signOutUser() {
    await signOut(auth);
    setRole(null); setOverview(null); setNotice(""); setError("");
  }

  if (loading) return <div className="boot"><span className="loader" />Проверяем защищённую сессию</div>;
  if (!user) return <LoginScreen onSignIn={signIn} error={error} />;
  if (!role) return <AccessScreen email={user.email || ""} uid={user.uid} error={error} diagnostic={accessDiagnostic} onSignOut={signOutUser} />;
  if (!secondFactor) return <MfaScreen
    phone={phone} setPhone={setPhone} code={smsCode} setCode={setSmsCode}
    sent={Boolean(mfaVerificationId)} start={startMfaEnrollment} finish={finishMfaEnrollment}
    onSignOut={signOutUser} error={error} notice={notice}
  />;

  const currentPage = nav.find((item) => item.id === page)!;
  const visibleNav = nav.filter((item) => {
    if (item.id === "staff" || item.id === "audit") return role === "owner";
    if (role === "marketing") return !["zbt", "players", "errors"].includes(item.id);
    return true;
  });
  const filteredPlayers = players.filter((player) => `${player.nickname} ${player.contactEmail} ${player.uid}`.toLowerCase().includes(query.toLowerCase()));
  const filteredErrors = errors.filter((item) => `${item.title} ${item.area} ${item.status}`.toLowerCase().includes(query.toLowerCase()));

  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? "is-open" : ""}`}>
      <div className="brand"><div className="brand-mark">F</div><div><strong>F Launcher</strong><span>Control room</span></div></div>
      <div className="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <nav className="primary-nav" aria-label="Разделы CRM">
        {visibleNav.map(({ id, label, icon: Icon }) => <button key={id} className={page === id ? "nav-item active" : "nav-item"} onClick={() => { setPage(id); setMenuOpen(false); }}>
          <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
          {id === "errors" && errors.some((item) => item.status === "NEW") && <i className="nav-dot" />}
        </button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="secure-note"><ShieldCheck size={16} /><span>Защищённая сессия<br /><b>Firebase MFA включена</b></span></div>
        <button className="profile-row" onClick={signOutUser} title="Выйти из CRM">
          <span className="avatar">{(user.displayName || user.email || "A").slice(0, 1).toUpperCase()}</span>
          <span className="profile-copy"><b>{user.displayName || user.email}</b><small>{role}</small></span>
          <LogOut size={15} />
        </button>
      </div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        <button className="icon-button mobile-menu" onClick={() => setMenuOpen(!menuOpen)} aria-label="Открыть меню"><Menu size={19} /></button>
        <div className="breadcrumbs"><span>F Launcher</span><b>/</b><strong>{currentPage.label}</strong></div>
        <div className="top-actions">
          <span className="live-indicator"><i /> Firebase подключён</span>
          <button className="icon-button" onClick={() => loadPage(page)} title="Обновить данные"><RefreshCw size={17} className={busy ? "spin" : ""} /></button>
          <button className="help-button" title="Справка"><CircleHelp size={17} /></button>
        </div>
      </header>

      <section className="page-content">
        <div className="page-heading">
          <div><p className="eyebrow">F LAUNCHER / CONTROL</p><h1>{currentPage.label}</h1></div>
          <div className="heading-actions">
            {page === "zbt" && role === "owner" && <button className="button primary" onClick={() => setShowCampaignForm(true)}><Plus size={16} /> Новая кампания</button>}
            {page === "staff" && role === "owner" && <button className="button primary" onClick={() => setShowInviteForm(true)}><Plus size={16} /> Пригласить сотрудника</button>}
            {page === "news" && (role === "owner" || role === "marketing") && <button className="button primary" onClick={() => setShowNewsForm(true)}><Plus size={16} /> Создать новость</button>}
          </div>
        </div>

        {notice && <div className="notice success"><Check size={17} /><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Закрыть"><X size={15} /></button></div>}
        {error && <div className="notice danger"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => setError("")} aria-label="Закрыть"><X size={15} /></button></div>}

        {page === "overview" && <OverviewPage overview={overview} campaigns={campaigns} errors={errors} openPage={setPage} />}
        {page === "zbt" && <ZbtPage campaigns={campaigns} keys={keys} selectedCampaign={selectedCampaign} selectCampaign={loadKeys}
          setStatus={setCampaignStatus} revoke={revokeKey} role={role} />}
        {page === "players" && <PlayersPage players={filteredPlayers} query={query} setQuery={setQuery} changeStatus={changePlayerStatus} />}
        {page === "errors" && <ErrorsPage errors={filteredErrors} query={query} setQuery={setQuery} updateStatus={updateError} />}
        {page === "news" && <NewsPage announcements={announcements} />}
        {page === "analytics" && <AnalyticsPage overview={overview} />}
        {page === "staff" && <StaffPage staff={staff} />}
        {page === "audit" && <AuditPage entries={audit} />}
      </section>
    </main>

    {showCampaignForm && <Modal title="Новая кампания ЗБТ" close={() => setShowCampaignForm(false)}>
      <form className="form-stack" onSubmit={createCampaign}>
        <label>Название кампании<input required maxLength={80} value={campaignName} onChange={(event) => setCampaignName(event.target.value)} placeholder="ЗБТ-1" /></label>
        <label>Количество мест<input type="number" min="1" max="500" required value={campaignSeats} onChange={(event) => setCampaignSeats(Number(event.target.value))} /></label>
        <label>Срок действия (необязательно)<input type="datetime-local" value={campaignExpiry} onChange={(event) => setCampaignExpiry(event.target.value)} /></label>
        <p className="form-hint">Открытые ключи появятся только в скачанном CSV. Повторно получить их из базы нельзя.</p>
        <div className="modal-actions"><button className="button secondary" type="button" onClick={() => setShowCampaignForm(false)}>Отмена</button><button className="button primary" disabled={busy}><KeyRound size={15} /> Создать и скачать CSV</button></div>
      </form>
    </Modal>}
    {showInviteForm && <Modal title="Пригласить сотрудника" close={() => setShowInviteForm(false)}>
      <form className="form-stack" onSubmit={inviteStaff}>
        <label>Google-почта<input required type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="name@example.com" /></label>
        <label>Роль<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Role)}><option value="support">Support · игроки и ошибки</option><option value="marketing">Marketing · новости</option><option value="owner">Owner · полный доступ</option></select></label>
        <p className="form-hint">Роль назначается сервером через Firebase Admin SDK. Для CRM также обязательна MFA.</p>
        <div className="modal-actions"><button className="button secondary" type="button" onClick={() => setShowInviteForm(false)}>Отмена</button><button className="button primary"><Mail size={15} /> Сохранить приглашение</button></div>
      </form>
    </Modal>}
    {showNewsForm && <Modal title="Новость лаунчера" close={() => setShowNewsForm(false)}>
      <form className="form-stack" onSubmit={saveNews}>
        <label>Заголовок<input required maxLength={120} value={newsTitle} onChange={(event) => setNewsTitle(event.target.value)} /></label>
        <label>Текст<textarea required maxLength={5000} rows={7} value={newsBody} onChange={(event) => setNewsBody(event.target.value)} /></label>
        <label>Публикация<select value={newsStatus} onChange={(event) => setNewsStatus(event.target.value)}><option value="DRAFT">Черновик</option><option value="PUBLISHED">Опубликовать</option></select></label>
        <div className="modal-actions"><button className="button secondary" type="button" onClick={() => setShowNewsForm(false)}>Отмена</button><button className="button primary"><FileText size={15} /> Сохранить</button></div>
      </form>
    </Modal>}
    <div id="mfa-recaptcha" />
  </div>;
}

function LoginScreen({ onSignIn, error }: { onSignIn: () => void; error: string }) {
  return <div className="login-screen"><div className="login-grid" />
    <div className="login-panel"><div className="brand-mark large">F</div><p className="eyebrow">F LAUNCHER / INTERNAL</p><h1>Панель<br />управления</h1>
      <p className="login-intro">Внутренний инструмент команды F Launcher. Вход доступен только сотрудникам с выданной ролью и двухфакторной защитой.</p>
      {error && <div className="notice danger"><AlertTriangle size={16} /><span>{error}</span></div>}
      <button className="google-button" onClick={onSignIn}><GoogleMark /> Продолжить с Google</button>
      <div className="login-security"><ShieldCheck size={16} /><span>Google OAuth · Firebase Authentication · MFA</span></div>
      <small className="login-footer">Доступ контролируется сервером. Незнакомые аккаунты не получают данные.</small>
      <div id="mfa-recaptcha" />
    </div><div className="login-aside"><span>01 — SECURE ACCESS</span><div className="aside-rule" /><p>Операционная<br />панель лаунчера</p><small>BUILD · SUPPORT · COMMUNITY</small></div>
  </div>;
}

function AccessScreen({ email, uid, error, diagnostic, onSignOut }: { email: string; uid: string; error: string; diagnostic: string; onSignOut: () => void }) {
  return <div className="gate-screen"><div className="gate-box"><div className="gate-icon"><ShieldAlert size={25} /></div><p className="eyebrow">ДОСТУП НЕ ВЫДАН</p><h1>CRM не подтвердила доступ</h1><p>{error || diagnostic || `Google: ${email}. UID: ${uid}. Проверьте документ staff/${uid} в Firestore.`}</p><button className="button secondary" onClick={onSignOut}><LogOut size={15} /> Выйти</button></div><div id="mfa-recaptcha" /></div>;
}

function MfaScreen(props: { phone: string; setPhone: (v: string) => void; code: string; setCode: (v: string) => void; sent: boolean; start: () => void; finish: () => void; onSignOut: () => void; error: string; notice: string }) {
  return <div className="gate-screen"><div className="gate-box"><div className="gate-icon"><ShieldCheck size={25} /></div><p className="eyebrow">ТРЕБУЕТСЯ ВТОРОЙ ФАКТОР</p><h1>Защитите аккаунт</h1><p>Для операций CRM обязательна Firebase MFA по SMS. Добавьте телефон один раз, затем подтверждайте вход кодом.</p>
    {props.error && <div className="notice danger"><AlertTriangle size={16} /><span>{props.error}</span></div>}
    {props.notice && <div className="notice success"><Check size={16} /><span>{props.notice}</span></div>}
    <label className="mfa-label">Телефон<input type="tel" value={props.phone} onChange={(event) => props.setPhone(event.target.value)} placeholder="+380..." /></label>
    {!props.sent ? <button className="button primary wide" onClick={props.start}>Отправить код</button> : <><label className="mfa-label">Код из SMS<input inputMode="numeric" value={props.code} onChange={(event) => props.setCode(event.target.value)} /></label><button className="button primary wide" onClick={props.finish}>Подтвердить телефон</button></>}
    <button className="text-button" onClick={props.onSignOut}>Выйти из аккаунта</button><div id="mfa-recaptcha" />
  </div></div>;
}

function OverviewPage({ overview, campaigns, errors, openPage }: { overview: Overview | null; campaigns: Campaign[]; errors: CrmError[]; openPage: (page: Page) => void }) {
  const activeCampaigns = campaigns.filter((campaign) => campaign.status === "ACTIVE").length;
  const newErrors = errors.filter((item) => item.status === "NEW").length;
  return <>
    <div className="summary-grid">
      <Stat label="Игроки" value={overview?.playerCount ?? "—"} detail="зарегистрированы в базе" icon={Users} tint="green" />
      <Stat label="Активные кампании" value={activeCampaigns} detail="ЗБТ-доступ" icon={KeyRound} tint="blue" />
      <Stat label="Новые ошибки" value={newErrors} detail="требуют разбора" icon={AlertTriangle} tint="orange" />
      <Stat label="Ключи использованы" value={campaigns.reduce((sum, campaign) => sum + campaign.activatedCount, 0)} detail="за всё время" icon={Check} tint="dark" />
    </div>
    <div className="section-grid">
      <section className="section-block"><div className="section-head"><div><p className="eyebrow">ACCESS</p><h2>Кампании ЗБТ</h2></div><button className="link-button" onClick={() => openPage("zbt")}>Все кампании <ChevronDown size={14} /></button></div>
        {campaigns.length ? <div className="compact-list">{campaigns.slice(0, 5).map((campaign) => <div className="compact-row" key={campaign.id}><span className="status-mark" data-status={campaign.status} /><div className="row-main"><b>{campaign.name}</b><small>{campaign.activatedCount} / {campaign.seats} мест · {campaign.status}</small></div><span className="row-date">{dateLabel(campaign.createdAt)}</span></div>)}</div> : <EmptyState text="Кампаний пока нет" />}
      </section>
      <section className="section-block"><div className="section-head"><div><p className="eyebrow">SUPPORT</p><h2>Последние ошибки</h2></div><button className="link-button" onClick={() => openPage("errors")}>Открыть <ChevronDown size={14} /></button></div>
        {errors.length ? <div className="compact-list">{errors.slice(0, 5).map((item) => <div className="compact-row" key={item.id}><span className="error-icon"><AlertTriangle size={14} /></span><div className="row-main"><b>{item.title || item.area}</b><small>{item.area} · {item.occurrences || 0} случаев</small></div><StatusPill value={item.status} /></div>)}</div> : <EmptyState text="Нет сгруппированных ошибок" />}
      </section>
    </div>
    <div className="bottom-note"><ShieldCheck size={17} /><span>Админ-действия записываются в журнал аудита и выполняются Cloud Functions.</span></div>
  </>;
}

function ZbtPage(props: { campaigns: Campaign[]; keys: ZbtKey[]; selectedCampaign: string; selectCampaign: (id: string) => void; setStatus: (id: string, status: string) => void; revoke: (id: string) => void; role: Role }) {
  return <div className="data-section"><div className="section-head"><div><p className="eyebrow">BETA ACCESS</p><h2>Кампании и активации</h2></div><span className="subtle">Ключи хранятся в Firestore только в виде HMAC</span></div>
    <div className="table-wrap"><table><thead><tr><th>КАМПАНИЯ</th><th>СОСТОЯНИЕ</th><th>МЕСТА</th><th>СОЗДАНА</th><th>ДЕЙСТВИЯ</th></tr></thead><tbody>
      {props.campaigns.map((campaign) => <tr key={campaign.id} className={props.selectedCampaign === campaign.id ? "selected-row" : ""}>
        <td><button className="table-primary" onClick={() => props.selectCampaign(campaign.id)}>{campaign.name}</button><small className="cell-id">{campaign.id}</small></td>
        <td><StatusPill value={campaign.status} /></td><td><b>{campaign.activatedCount}</b><span className="muted"> / {campaign.seats}</span></td><td>{dateLabel(campaign.createdAt)}</td>
        <td><div className="table-actions"><button className="small-button" onClick={() => props.selectCampaign(campaign.id)}>Ключи</button>{props.role === "owner" && <button className="small-button" onClick={() => props.setStatus(campaign.id, campaign.status === "ACTIVE" ? "CLOSED" : "ACTIVE")}>{campaign.status === "ACTIVE" ? "Закрыть" : "Открыть"}</button>}</div></td>
      </tr>)}
      {!props.campaigns.length && <tr><td colSpan={5}><EmptyState text="Создайте первую кампанию ЗБТ" /></td></tr>}
    </tbody></table></div>
    {props.selectedCampaign && <div className="key-list"><div className="section-head"><div><p className="eyebrow">CAMPAIGN KEYS</p><h3>Состояние ключей</h3></div><span className="subtle">Открытые значения не хранятся и не показываются повторно</span></div>
      <div className="table-wrap"><table><thead><tr><th>СТАТУС</th><th>ИГРОК</th><th>UID</th><th>АКТИВИРОВАН</th><th /></tr></thead><tbody>{props.keys.map((item) => <tr key={item.id}><td><StatusPill value={item.status} /></td><td>{item.nickname || "—"}</td><td className="mono">{item.activatedBy || "—"}</td><td>{dateLabel(item.activatedAt)}</td><td>{props.role === "owner" && item.status !== "REVOKED" && <button className="icon-button danger-icon" onClick={() => props.revoke(item.id)} title="Отозвать ключ"><Ban size={15} /></button>}</td></tr>)}</tbody></table></div>
    </div>}
  </div>;
}

function PlayersPage(props: { players: Player[]; query: string; setQuery: (v: string) => void; changeStatus: (player: Player) => void }) {
  return <div className="data-section"><div className="section-head"><div><p className="eyebrow">PLAYER DIRECTORY</p><h2>Пользователи лаунчера</h2></div><SearchBox value={props.query} setValue={props.setQuery} placeholder="Ник, email или UID" /></div>
    <div className="table-wrap"><table><thead><tr><th>ИГРОК</th><th>КОНТАКТ</th><th>СТАТУС</th><th>КАМПАНИЯ</th><th>ПОСЛЕДНЯЯ АКТИВНОСТЬ</th><th /></tr></thead><tbody>{props.players.map((player) => <tr key={player.uid}><td><b>{player.nickname || "Без ника"}</b><small className="cell-id mono">{player.uid}</small></td><td>{player.contactEmail || "—"}</td><td><StatusPill value={player.status} /></td><td>{player.zbtCampaignId || "—"}</td><td>{dateLabel(player.lastSeenAt)}</td><td><button className={`small-button ${player.status === "BANNED" ? "" : "danger-button"}`} onClick={() => props.changeStatus(player)}>{player.status === "BANNED" ? "Разблокировать" : "Заблокировать"}</button></td></tr>)}{!props.players.length && <tr><td colSpan={6}><EmptyState text="Пользователи появятся после активации ЗБТ" /></td></tr>}</tbody></table></div>
  </div>;
}

function ErrorsPage(props: { errors: CrmError[]; query: string; setQuery: (v: string) => void; updateStatus: (item: CrmError, status: string) => void }) {
  return <div className="data-section"><div className="section-head"><div><p className="eyebrow">ISSUE TRIAGE</p><h2>Группы ошибок</h2></div><SearchBox value={props.query} setValue={props.setQuery} placeholder="Поиск по тексту или зоне" /></div>
    <div className="table-wrap"><table><thead><tr><th>ОШИБКА</th><th>СТАТУС</th><th>СЛУЧАЕВ</th><th>ИГРОКОВ</th><th>ПОСЛЕДНИЙ СЛУЧАЙ</th><th>ДЕЙСТВИЕ</th></tr></thead><tbody>{props.errors.map((item) => <tr key={item.id}><td><b>{item.title || "Без заголовка"}</b><small className="cell-id">{item.area} · {item.version || "версия неизвестна"}</small></td><td><StatusPill value={item.status} /></td><td>{item.occurrences || 0}</td><td>{item.affectedPlayers || 0}</td><td>{dateLabel(item.updatedAt)}</td><td><select className="table-select" value={item.status} onChange={(event) => props.updateStatus(item, event.target.value)}><option>NEW</option><option>IN_PROGRESS</option><option>RESOLVED</option><option>IGNORED</option></select></td></tr>)}{!props.errors.length && <tr><td colSpan={6}><EmptyState text="Ошибок пока нет" /></td></tr>}</tbody></table></div>
  </div>;
}

function NewsPage({ announcements }: { announcements: Announcement[] }) {
  return <div className="data-section"><div className="section-head"><div><p className="eyebrow">PLAYER COMMUNICATION</p><h2>Новости лаунчера</h2></div><span className="subtle">Черновики и публикации</span></div>
    <div className="news-list">{announcements.map((item) => <article className="news-row" key={item.id}><div className="news-date"><Clock3 size={15} />{dateLabel(item.updatedAt)}</div><div className="news-copy"><h3>{item.title}</h3><p>{item.body}</p></div><StatusPill value={item.status} /></article>)}{!announcements.length && <EmptyState text="Новостей пока нет" />}</div>
  </div>;
}

function AnalyticsPage({ overview }: { overview: Overview | null }) {
  const daily = overview?.daily ?? [];
  return <div className="data-section"><div className="section-head"><div><p className="eyebrow">PRODUCT SIGNALS</p><h2>Активность</h2></div><span className="subtle">Последние 30 дней · только согласованные события</span></div>
    <div className="summary-grid analytics-summary"><Stat label="Всего игроков" value={overview?.playerCount ?? "—"} detail="в базе лаунчера" icon={Users} tint="green" /><Stat label="Дней в выборке" value={daily.length} detail="события в Firestore" icon={Activity} tint="blue" /><Stat label="События сегодня" value={daily[0]?.events ?? 0} detail="анонимизированный счётчик" icon={Clock3} tint="orange" /></div>
    <div className="table-wrap"><table><thead><tr><th>ДАТА</th><th>АКТИВНЫЕ ИГРОКИ</th><th>СОБЫТИЯ</th></tr></thead><tbody>{daily.map((day) => <tr key={day.id}><td>{day.date || day.id}</td><td>{day.activePlayers ?? "—"}</td><td>{day.events ?? 0}</td></tr>)}{!daily.length && <tr><td colSpan={3}><EmptyState text="Данные появятся после подключения серверного сбора аналитики" /></td></tr>}</tbody></table></div>
  </div>;
}

function StaffPage({ staff }: { staff: StaffMember[] }) {
  return <div className="data-section"><div className="section-head"><div><p className="eyebrow">ACCESS CONTROL</p><h2>Сотрудники и роли</h2></div><span className="subtle">Доступ выдаёт только owner</span></div>
    <div className="role-strip"><span><b>Owner</b> полный доступ и роли</span><span><b>Support</b> игроки и ошибки</span><span><b>Marketing</b> новости</span><span><b>2FA</b> SMS-фактор обязателен</span></div>
    <div className="table-wrap"><table><thead><tr><th>СОТРУДНИК</th><th>РОЛЬ</th><th>ДОСТУП</th></tr></thead><tbody>{staff.map((member) => <tr key={member.id}><td><b>{member.displayName || member.email}</b><small className="cell-id">{member.email}</small></td><td><span className={`role-pill ${member.role === "owner" ? "owner" : ""}`}>{member.role}</span></td><td><span className="permission-check"><Check size={14} /> Firestore role</span></td></tr>)}</tbody></table></div>
  </div>;
}

function Stat({ label, value, detail, icon: Icon, tint }: { label: string; value: React.ReactNode; detail: string; icon: typeof Users; tint: string }) {
  return <div className="stat"><div className={`stat-icon ${tint}`}><Icon size={18} /></div><div><p>{label}</p><strong>{value}</strong><small>{detail}</small></div></div>;
}

function StatusPill({ value }: { value: string }) {
  const normalized = value.toUpperCase();
  const label: Record<string, string> = { ACTIVE: "Активна", CLOSED: "Закрыта", UNUSED: "Не использован", ACTIVATED: "Активирован", REVOKED: "Отозван", EXPIRED: "Истёк", BANNED: "Заблокирован", NEW: "Новая", IN_PROGRESS: "В работе", RESOLVED: "Решена", IGNORED: "Игнор", PUBLISHED: "Опубликовано", DRAFT: "Черновик" };
  return <span className={`status-pill status-${normalized.toLowerCase()}`}>{label[normalized] || value}</span>;
}

function SearchBox({ value, setValue, placeholder }: { value: string; setValue: (v: string) => void; placeholder: string }) {
  return <label className="search-box"><Search size={16} /><input value={value} onChange={(event) => setValue(event.target.value)} placeholder={placeholder} /></label>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state"><span><FileText size={18} /></span><p>{text}</p></div>;
}

function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) { if (event.key === "Escape") close(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal"><header><h2>{title}</h2><button className="icon-button" onClick={close} title="Закрыть"><X size={18} /></button></header>{children}</section></div>;
}

function GoogleMark() {
  return <span className="google-mark" aria-hidden="true">G</span>;
}

function AuditPage({ entries }: { entries: AuditEntry[] }) {
  return <div className="data-section"><div className="section-head"><div><p className="eyebrow">ADMIN HISTORY</p><h2>Последние действия</h2></div><span className="subtle">Только owner · последние 200 записей</span></div>
    <div className="table-wrap"><table><thead><tr><th>ВРЕМЯ</th><th>СОТРУДНИК UID</th><th>ДЕЙСТВИЕ</th><th>ДЕТАЛИ</th></tr></thead><tbody>
      {entries.map((entry) => <tr key={entry.id}><td>{dateLabel(entry.at)}</td><td className="mono">{entry.actorUid}</td><td><span className="role-pill">{entry.action}</span></td><td className="audit-detail">{JSON.stringify(entry.payload)}</td></tr>)}
      {!entries.length && <tr><td colSpan={4}><EmptyState text="Журнал пока пуст" /></td></tr>}
    </tbody></table></div>
  </div>;
}