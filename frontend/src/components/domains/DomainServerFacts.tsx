import React, { useState } from "react";

import { Domain, useReadDomainFacts, useUpdateDomain } from "../../api/domains";
import { Server } from "../../api/servers";
import { SSL_BADGE, isFactsStale, sslState } from "../../lib/domainFacts";
import {
  type FieldSource,
  dbNameSource,
  dbUserSource,
  ftpLoginSource,
  phpVersionSource,
  samePath,
  siteOwnerSource,
  sitePathSource,
  sslExpiresSource,
  sslIssuerSource,
} from "../../lib/domainDrift";
import { formatExpiryDate } from "../../lib/domainExpiry";
import { BLOB_KIND } from "../../lib/secretBlob";
import { isTauri } from "../../lib/runtime";
import { useSecretSave } from "../../hooks/useSecretSave";
import { RevealSecret } from "../RevealSecret";
import { Badge, Btn, Inp, formatAgoStale } from "../ui/Primitives";

/**
 * Секция «состояние на сервере» — ЕДИНСТВЕННОЕ место карточки, отвечающее на
 * вопрос «что с сайтом».
 *
 * Раньше на тот же вопрос отвечал и двухколоночный блок наверху: он печатал
 * НАШУ запись (снимок момента provision из колонок домена), а секция — живое
 * чтение с сервера, и восемь полей у них совпадали. Блок снят (фаза 3), а его
 * значения приехали сюда — но не второй колонкой, а ответом `lib/domainDrift`:
 * значением поля остаётся факт, наша запись всплывает строкой «при
 * развёртывании: X» ровно тогда, когда РАСХОДИТСЯ с фактом, и становится
 * значением (приглушённым, с честной подписью) там, где факта нет вовсе.
 *
 * Порог протухания и лестница SSL живут в `lib/domainFacts`, само правило
 * расхождения — в `lib/domainDrift`, а не здесь: три экрана про сервер уже
 * разъезжались, когда правило жило в компоненте.
 *
 * Про язык подписей: проза секции английская, но три строки этой фазы — «при
 * развёртывании: X», «из provision, на сервере не проверено» и «Сервер ещё не
 * читали» — оставлены по-русски дословно, как их задаёт план и повторяют его
 * acceptance criteria. Они один смысловой блок и приезжают вместе; файл к тому
 * же двуязычен и без них (кнопки «Проверить на сервере», «Задать пароль»).
 */

/**
 * Порт FTP у FastPanel — стандартный 21 (pure-ftpd/proftpd слушают его). Отдельным
 * полем домен/сервер его не хранит; при живом прогоне это и подтвердится.
 */
const FTP_PORT = 21;

const NONE = "—";

/** Приглушённый серый — им набраны и приписки, и значения «только из provision». */
const MUTED = "#9ca3af";

/** Ширина колонки подписи; приписка выравнивается под значение по ней же. */
const KEY_WIDTH = 84;
const KEY_GAP = 6;

/** Строка «подпись: значение» в стиле карточки; пустое — прочерк, а не пустота. */
function Row({ k, v }: { k: string; v: React.ReactNode }) {
  const empty = v === null || v === undefined || v === "";
  return (
    <div style={{ display: "flex", gap: KEY_GAP, fontSize: 13, color: "#374151" }}>
      <b style={{ color: "#6b7280", fontWeight: 600, minWidth: KEY_WIDTH }}>{k}</b>
      <span style={{ wordBreak: "break-all" }}>{empty ? NONE : v}</span>
    </div>
  );
}

/**
 * Серая приписка под значением поля (12px, #9ca3af — как задано планом).
 *
 * Отступ считается от `KEY_WIDTH`, а колонка подписи задана `minWidth`, так что
 * выравнивание держится ровно пока ни одна подпись не шире 84px. Сегодня самая
 * длинная — «Databases»; заведёте длиннее — приписка съедет, и чинить это надо
 * будет здесь, а не подгонкой числа.
 */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12, color: MUTED, paddingLeft: KEY_WIDTH + KEY_GAP, wordBreak: "break-all" }}>
      {children}
    </div>
  );
}

/**
 * Есть ли у секции снимок сервера. Контекст, а не проп у каждого поля.
 *
 * Проп пришлось бы повторять у восьми полей, и он необязателен по природе:
 * новое поле, заведённое через год без него, молча вернуло бы прочерк под
 * доменом, который ни разу не читали, — тип этого не поймает, а теста на новое
 * поле никто не напишет. Ответ же тут один на всю секцию, и держать его в одном
 * месте честнее, чем восемь раз повторять (та же причина, по которой три исхода
 * рисует одна карта `DRAW`, а не ветвление в семи экземплярах).
 */
const HasSnapshot = React.createContext(true);

/** Значение поля и приписка под ним — то, что отличает три исхода `FieldSource`. */
type Drawn = { value: React.ReactNode; note: React.ReactNode };

/**
 * Как выглядит поле при КАЖДОМ из трёх исходов — карта, а не ветвление по месту
 * в JSX.
 *
 * Ветвление по месту здесь было бы дырой в семи экземплярах: `FieldSource` —
 * размеченное объединение, но читателя ничто не заставляет разобрать все ветки,
 * и `src.kind === "drift" ? … : null` компилируется молча, превращая незнание
 * (`recorded-only`) в прочерк — ровно то, что запрещает принцип №6 CLAUDE.md.
 * `Record<FieldSource["kind"], …>` же не даст завести четвёртый исход, забыв его
 * нарисовать: пропуск станет ошибкой типов (тот же приём, что у `SSL_BADGE`).
 */
const DRAW: Record<FieldSource["kind"], (fact: React.ReactNode, recorded: React.ReactNode) => Drawn> = {
  // Факт есть, наша запись с ним совпала — дорисовывать нечего.
  agree: (fact) => ({ value: fact, note: null }),
  // Факт есть, наша запись другая — значением остаётся факт (он измерен), а
  // наша запись уходит вниз серой строкой.
  drift: (fact, recorded) => ({ value: fact, note: <Note>при развёртывании: {recorded}</Note> }),
  // Факта нет — значением становится наша запись, но приглушённо и с подписью:
  // выдать её за прочитанное с сервера нельзя.
  "recorded-only": (_fact, recorded) => ({
    value: <span style={{ color: MUTED }}>{recorded}</span>,
    note: <Note>из provision, на сервере не проверено</Note>,
  }),
};

/** Печать нашей записи по умолчанию — как есть, без переформатирования. */
const AS_IS = (recorded: string) => recorded;

/**
 * Поле секции: факт с сервера плюс то, что о нём говорит наша запись.
 *
 * Два поведения зависят от того, есть ли у секции снимок (контекст
 * `HasSnapshot`), и оба — про честность, а не про вёрстку:
 *
 * 1. **Пустое поле прячется целиком.** Прочерк читается как «сервер спросили,
 *    там пусто», а спрашивать мы не ходили.
 * 2. **Приписка `recorded-only` не печатается у каждого поля.** Ровно это уже
 *    сказано ОДИН раз легендой над сеткой, дословно теми же словами; восемь её
 *    копий подряд — самый частый экран продукта (только что развёрнутый домен)
 *    и теснота без нового знания (принцип №2 CLAUDE.md). Приглушённый цвет
 *    значения при этом остаётся, и он же связывает поле с легендой. В смешанном
 *    случае — снимок ЕСТЬ, а факта у конкретного поля нет — приписка печатается:
 *    там она несёт то, чего больше нигде не сказано.
 *
 * @param fact         значение, прочитанное с сервера (уже готовое к показу).
 * @param src          ответ `lib/domainDrift`; по умолчанию — «сказать нечего».
 * @param showRecorded как печатать нашу запись (даты — по-человечески).
 * @param hideEmpty    прятать пустое поле ДАЖЕ под снимком. Нужно там, где
 *                     факта не бывает по построению (`DB user`): прочерк в нём
 *                     обещал бы измерение, которого не будет никогда.
 */
function FactRow({
  k,
  fact,
  src = { kind: "agree" },
  showRecorded,
  hideEmpty = false,
}: {
  k: string;
  fact?: React.ReactNode;
  src?: FieldSource;
  showRecorded?: (recorded: string) => React.ReactNode;
  hideEmpty?: boolean;
}) {
  const hasSnapshot = React.useContext(HasSnapshot);
  const recorded = src.kind === "agree" ? null : (showRecorded ?? AS_IS)(src.recorded);
  const { value, note } = DRAW[src.kind](fact, recorded);
  const shownNote = hasSnapshot ? note : null;
  const empty = value === null || value === undefined || value === "";
  // Прячем, только когда сказать нечего ВООБЩЕ: приписка без значения
  // невозможна по построению правила, но если бы стала возможной, она не должна
  // уехать с экрана вместе с пустотой.
  if ((hideEmpty || !hasSnapshot) && empty && shownNote === null) return null;
  return (
    // `data-source` — исход правила, ставший видимым: по нему тест отличает
    // «показано как факт» от «показано как наша запись», не привязываясь к
    // инлайн-цвету (тот уедет в токены вместе с редизайном).
    <div data-source={src.kind} style={{ display: "grid", gap: 2 }}>
      <Row k={k} v={value} />
      {shownNote}
    </div>
  );
}

/** Заголовок под-блока секции. */
function SubTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, color: "#111", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>
      {children}
    </div>
  );
}

export default function DomainServerFacts({
  domain,
  server,
  now,
}: {
  domain: Domain;
  server: Server | undefined;
  now: number;
}) {
  // Снимок читается ТОЛЬКО вместе со своей отметкой времени: «когда сняли» —
  // часть самого снимка, а не украшение. Бэкенд пишет обе колонки одной
  // транзакцией (`domain_service.record_facts`), так что пара «факты есть,
  // отметки нет» не должна возникать; гейт — чтобы, если она возникнет, секция
  // не сказала «Сервер ещё не читали» и тут же не напечатала эти факты списком
  // аккаунтов. Одна истина вместо двух независимых.
  const facts = domain.fp_facts_at ? domain.fp_facts ?? null : null;
  const desktop = isTauri();
  const read = useReadDomainFacts(domain.id);

  // Свежесть считается от `fp_facts_at` (когда снят снимок), НЕ от `fp_checked_at`
  // (когда была последняя попытка): протухший снимок не должен молодеть от
  // проваленной проверки. «never checked» — отдельное слово, а не прочерк.
  const factsStale = isFactsStale(domain.fp_facts_at, now);
  const freshness = domain.fp_facts_at
    ? `Checked ${formatAgoStale(domain.fp_facts_at, factsStale, now)}`
    : "Never checked";

  const ssl = sslState(facts?.ssl, domain.fp_facts_at, now);
  const sslBadge = SSL_BADGE[ssl];

  /**
   * Удачного снимка не было ни разу. Тогда решётка прочерков — враньё: прочерк
   * в поле читается как «сервер спросили, там пусто», а спрашивать мы ещё не
   * ходили. Поэтому поля, которым нечего сказать, прячутся целиком, а вместо
   * них секция говорит это ОДИН раз словами.
   */
  const noSnapshot = !domain.fp_facts_at;

  /**
   * Наша запись против факта — все восемь вопросов в ОДНОМ месте.
   *
   * Собраны сюда намеренно: вызовы почти одинаковы (`(recorded, facts)`), и
   * подмена аргумента — `phpVersionSource(domain.site_user, facts)` — исправно
   * компилируется. Здесь рассинхрон виден одним взглядом по столбику, а
   * разбросанный по восьми точкам JSX его пришлось бы искать.
   */
  const src = {
    ftpLogin: ftpLoginSource(domain.ftp_user, facts),
    sslExpires: sslExpiresSource(domain.ssl_expires_at, facts),
    sslIssuer: sslIssuerSource(domain.ssl_issuer, facts),
    sitePath: sitePathSource(domain.site_path, facts),
    siteOwner: siteOwnerSource(domain.site_user, facts),
    php: phpVersionSource(domain.php_version, facts),
    dbName: dbNameSource(domain.db_name, facts),
    // Единственная функция без снимка: пользователей баз FastPanel CLI не
    // отдаёт вовсе, сверять не с чем ни при каком чтении.
    dbUser: dbUserSource(domain.db_user),
  };

  /**
   * Логин FTP, прочитанный с СЕРВЕРА, — и это правка сути, а не формы.
   *
   * До фазы 4 здесь стояло `domain.ftp_user || facts[0]?.login`: наша запись
   * заслоняла факт, и удалённый с сервера аккаунт печатался как живой — то
   * есть поле отвечало «чем мы подключались», притворяясь ответом «что на
   * сервере есть». Теперь значение — всегда факт, а наша запись приходит
   * строкой расхождения от `ftpLoginSource`.
   *
   * Представителя списка выбираем так: если наш логин в списке ЕСТЬ (об этом и
   * говорит `agree`), он и есть представитель — «да, тот самый»; либо нашей
   * записи нет вовсе — `agree` значит и это тоже, и тогда представителя даёт
   * `||` справа. Своего сравнения здесь нет намеренно — оно всё в
   * `ftpLoginSource`, который смотрит ВЕСЬ список: «первый = основной» остаётся
   * выбором показа и никогда не становится правилом сверки
   * (`filter_ftp_by_domain` основного не размечает, порядок — просто порядок
   * вывода CLI).
   *
   * `trim()` тут обязателен: правило чистит запись перед сравнением, поэтому
   * `ftp_user` из одних пробелов даёт `agree`, — а сырая строка при этом
   * truthy и заслонила бы собой живой аккаунт сервера, то есть вернула бы ровно
   * тот дефект, ради снятия которого это место и переписано.
   */
  const factFtpLogin =
    (src.ftpLogin.kind === "agree" ? domain.ftp_user?.trim() || null : null) ||
    facts?.ftp_accounts[0]?.login ||
    null;

  /**
   * Значение поля, факт которого — СПИСОК (аккаунты FTP, базы).
   *
   * Пустой список прочерком печатать нельзя: `compareInList` в том же
   * `lib/domainDrift` считает его «мы не прочитали», а не «на сервере пусто», —
   * провод их не различает (`ssh/fastpanel_facts.rs` схлопывает в `[]` и
   * упавшую команду, и слабый mysql-фолбэк, про который его же комментарий
   * говорит, что тот скорее всего не поймает ничего). Прочерк же читается ровно
   * как измерение «спросили, там пусто». Одно и то же свидетельство обязано
   * получать один вердикт в правиле и на экране (принцип №6 CLAUDE.md), иначе
   * импортированный домен с пустым `db_name` увидит уверенный прочерк там, где
   * мы ничего не знаем.
   *
   * Без снимка — пустота: поле спрячется целиком, и говорить «not read» второй
   * раз после легенды «Сервер ещё не читали» незачем.
   */
  const listFact = (value: string | null): React.ReactNode =>
    value ?? (noSnapshot ? null : <span style={{ color: MUTED }}>not read</span>);

  return (
    <div style={{ marginTop: 20, borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#111" }}>Server state</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: factsStale ? "#8a8580" : "#6b7280" }}>{freshness}</span>
          {/* Только десктоп: чтение идёт по SSH, веб этого не умеет. */}
          {desktop ? (
            <Btn
              size="sm"
              variant="secondary"
              onClick={read.run}
              disabled={read.pending}
              title="Read SSL, FTP, PHP, site and databases from the server over one SSH session"
            >
              {read.pending ? "Checking…" : "Проверить на сервере"}
            </Btn>
          ) : null}
        </div>
      </div>

      {/* Ошибка последней ПОПЫТКИ — под шапкой. Снимок при этом остаётся прежним
          (сервер не трогает `fp_facts` при провале), и его свежесть — выше. */}
      {domain.fp_check_error ? (
        <div role="alert" style={{ fontSize: 12, color: "#b91c1c", marginBottom: 8 }}>
          Last check failed: {domain.fp_check_error}
        </div>
      ) : null}

      {/* Снимка не было ни разу — говорим это словами ОДИН раз, вместо того
          чтобы повторять прочерком в каждом поле, а подписью «из provision, на
          сервере не проверено» — под каждым восьмым. Легенда несёт ту же
          подпись дословно и связывает её с приглушённым цветом значений.
          Кнопка чтения — в шапке выше (и только в десктопе: в вебе SSH нет). */}
      {noSnapshot ? (
        <div style={{ fontSize: 12.5, color: "#6b7280", marginBottom: 8 }}>
          Сервер ещё не читали. Приглушённые значения — из provision, на сервере не проверено.
        </div>
      ) : null}

      <HasSnapshot.Provider value={!noSnapshot}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 8 }}>
          {/* ─── FTP ─────────────────────────────────────────────────────── */}
          <div style={{ display: "grid", gap: 6, alignContent: "start" }}>
            <SubTitle>FTP access</SubTitle>
            {/* Host и Port — не про снимок: адрес берётся у сервера, порт
                константа. У домена без сервера Host остаётся прочерком. */}
            <Row k="Host" v={server?.ip_address} />
            <Row k="Port" v={FTP_PORT} />
            <FactRow k="Login" fact={listFact(factFtpLogin)} src={src.ftpLogin} />
            <FtpPassword domain={domain} desktop={desktop} />
            {facts && facts.ftp_accounts.length > 0 ? (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>Accounts on server</div>
                {facts.ftp_accounts.map((a) => (
                  <div key={a.login} style={{ fontSize: 12.5, color: "#374151" }}>
                    {a.login}
                    {/* `home` печатаем, только когда он ОТЛИЧАЕТСЯ от пути сайта:
                        у типового аккаунта это тот же путь, и он уже стоит в
                        Site → Path — третья его копия на экране ничего не
                        добавляет. Вопрос «та же ли это папка» задаём тем же
                        `samePath`, что и правило расхождения, а не своим
                        сравнением строк: хвостовой слэш стороны пишут как
                        придётся, и вторая нормализация разъехалась бы с первой. */}
                    {a.home && !samePath(a.home, facts.site?.site_path) ? (
                      <span style={{ color: MUTED }}> · {a.home}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
  
          {/* ─── SSL ─────────────────────────────────────────────────────── */}
          <div style={{ display: "grid", gap: 6, alignContent: "start" }}>
            <SubTitle>SSL</SubTitle>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <b style={{ color: "#6b7280", fontWeight: 600, minWidth: KEY_WIDTH }}>State</b>
              <Badge variant={sslBadge.variant}>{sslBadge.label}</Badge>
            </div>
            {/* «Сертификата нет» — отдельное слово, отличимое от «не проверяли». */}
            {ssl === "missing" ? (
              <div style={{ fontSize: 12.5, color: "#b91c1c" }}>No certificate on the server.</div>
            ) : null}
            {facts?.ssl.error ? (
              <div style={{ fontSize: 12.5, color: "#b91c1c" }}>{facts.ssl.error}</div>
            ) : null}
            {/* `ssl.expires_at` — полный datetime: печатаем в зоне ЧИТАТЕЛЯ
                (`formatExpiryDate` сам это решает по форме iso), не в UTC. Иначе
                далеко от UTC дата съедет на день и разойдётся с остальным кодом
                (правило в `domainExpiry.ts`). Наша запись — тем же
                `formatExpiryDate`: сырой ISO под человеческой датой читался бы
                расхождением там, где его нет. */}
            <FactRow
              k="Expires"
              fact={facts?.ssl.expires_at ? formatExpiryDate(facts.ssl.expires_at) : null}
              src={src.sslExpires}
              showRecorded={formatExpiryDate}
            />
            <FactRow k="Issuer" fact={facts?.ssl.issuer} src={src.sslIssuer} />
          </div>
  
          {/* ─── Site ────────────────────────────────────────────────────── */}
          <div style={{ display: "grid", gap: 6, alignContent: "start", gridColumn: "1 / -1" }}>
            <SubTitle>Site</SubTitle>
            <FactRow k="Path" fact={facts?.site?.site_path} src={src.sitePath} />
            <FactRow k="Owner" fact={facts?.site?.site_user} src={src.siteOwner} />
            <FactRow
              k="PHP"
              fact={
                facts?.php_version
                  ? `${facts.php_version}${facts.php_handler ? ` · ${facts.php_handler}` : ""}`
                  : facts?.site?.php_version || null
              }
              src={src.php}
            />
            <FactRow
              k="Databases"
              fact={listFact(facts && facts.databases.length > 0 ? facts.databases.join(", ") : null)}
              src={src.dbName}
            />
            {/* Пользователь базы — единственное поле с `hideEmpty`: пустое, оно
                прячется даже ПОД снимком, потому что факта у него не бывает ни
                при каком чтении (`docs/FASTPANEL_CLI.md`), и прочерк обещал бы
                измерение, которого не будет никогда. Нет записи — нет и строки. */}
            <FactRow k="DB user" src={src.dbUser} hideEmpty />
            <FactRow
              k="Logs"
              fact={
                facts && facts.logs.length > 0 ? (
                  <span>
                    {facts.logs.map((l) => (
                      <span key={l.path} style={{ display: "block", color: l.exists ? "#374151" : MUTED }}>
                        {l.path}
                      </span>
                    ))}
                  </span>
                ) : null
              }
            />
          </div>
        </div>
      </HasSnapshot.Provider>
    </div>
  );
}

/**
 * Пароль FTP: показ через `RevealSecret` и ручной ввод «Задать пароль».
 *
 * Плейнтекст живёт ТОЛЬКО внутри `useSecretSave` — не в нашем `useState` и не в
 * `variables` мутации (`PUT /domains/{id}` получает лишь id блоба). Ручной ввод
 * — десктоп: `putSecretBlob` шифрует Rust'ом мастер-ключом из keychain.
 */
function FtpPassword({ domain, desktop }: { domain: Domain; desktop: boolean }) {
  const [editing, setEditing] = useState(false);
  const ftpPw = useSecretSave("FTP password");
  const updateDomain = useUpdateDomain(domain.id);

  const close = () => {
    ftpPw.reset();
    setEditing(false);
  };

  const save = async () => {
    const ok = await ftpPw.save({
      blobKind: BLOB_KIND.domainFtpPassword,
      // Правка: если пароль уже задан — переписываем ТОТ ЖЕ блоб (версии ведёт
      // сервер внутри одного id). Новый id оставил бы домен со ссылкой на старый.
      existingBlobId: domain.ftp_password_blob_id ?? null,
      persist: async (blobId) => {
        await updateDomain.mutateAsync({ ftp_password_blob_id: blobId });
      },
    });
    if (ok) close();
  };

  if (editing) {
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <Inp
          type="password"
          value={ftpPw.value}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => ftpPw.setValue(e.target.value)}
          placeholder="Enter FTP password"
          aria-label="FTP password"
        />
        {ftpPw.error ? (
          <div role="alert" style={{ fontSize: 12, color: "#b91c1c" }}>
            {ftpPw.error}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 6 }}>
          <Btn size="sm" variant="primary" onClick={() => void save()} disabled={ftpPw.saving}>
            {ftpPw.saving ? "Saving…" : "Save"}
          </Btn>
          <Btn size="sm" variant="secondary" onClick={close} disabled={ftpPw.saving}>
            Cancel
          </Btn>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <b style={{ color: "#6b7280", fontWeight: 600, minWidth: 84, fontSize: 13 }}>Password</b>
      {domain.ftp_password_blob_id ? (
        <RevealSecret blobId={domain.ftp_password_blob_id} label="Show FTP password" />
      ) : (
        <span style={{ fontSize: 13, color: "#9ca3af" }}>not set</span>
      )}
      {/* Ручной ввод — только десктоп: запись секрета в вебе невозможна. */}
      {desktop ? (
        <Btn size="sm" variant="secondary" onClick={() => setEditing(true)}>
          Задать пароль
        </Btn>
      ) : null}
    </div>
  );
}
