import React, { useState } from "react";

import { Domain, useReadDomainFacts, useUpdateDomain } from "../../api/domains";
import { Server } from "../../api/servers";
import { isFactsStale } from "../../lib/domainFacts";
import {
  dbNameSource,
  dbUserSource,
  ftpLoginSource,
  phpVersionSource,
  samePath,
  siteOwnerSource,
  sitePathSource,
} from "../../lib/domainDrift";
import { BLOB_KIND } from "../../lib/secretBlob";
import { isTauri } from "../../lib/runtime";
import { useSecretSave } from "../../hooks/useSecretSave";
import { RevealSecret } from "../RevealSecret";
import { Btn, Inp, formatAgoStale } from "../ui/Primitives";
import { FactRow, HasSnapshot, MUTED, Row, SubTitle } from "./facts/fields";

/**
 * Секция «состояние на сервере» — ЕДИНСТВЕННОЕ место карточки, отвечающее на
 * вопрос «что развёрнуто на сервере»: доступ по FTP и сам сайт (путь, владелец,
 * PHP, базы). Сертификат отвечает на свой вопрос и живёт своей карточкой на
 * Overview — из того же снимка, но не здесь (см. ниже).
 *
 * Раньше на тот же вопрос отвечал и двухколоночный блок наверху: он печатал
 * НАШУ запись (снимок момента provision из колонок домена), а секция — живое
 * чтение с сервера, и восемь полей у них совпадали. Блок снят (фаза 3), а его
 * значения приехали сюда — но не второй колонкой, а ответом `lib/domainDrift`:
 * значением поля остаётся факт, наша запись всплывает строкой «при
 * развёртывании: X» ровно тогда, когда РАСХОДИТСЯ с фактом, и становится
 * значением (приглушённым, с честной подписью) там, где факта нет вовсе.
 *
 * Порог протухания живёт в `lib/domainFacts`, само правило расхождения — в
 * `lib/domainDrift`, а его показ (`FactRow`) — в `domains/facts/fields`, а не
 * здесь: три экрана про сервер уже разъезжались, когда правило жило в
 * компоненте.
 *
 * Сертификата в секции больше нет: карточка SSL уехала на вкладку Overview
 * (`DomainSslCard`) вместе со своей половиной правила расхождений, потому что
 * там же стоит бейдж SSL в шапке карточки. Снимок при этом остался ОДИН — тот,
 * что снимает кнопка ниже, — и его возраст карточка SSL печатает у себя в
 * шапке, чтобы Overview не выдавал протухшее измерение за свежее.
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

  /**
   * Удачного снимка не было ни разу. Тогда решётка прочерков — враньё: прочерк
   * в поле читается как «сервер спросили, там пусто», а спрашивать мы ещё не
   * ходили. Поэтому поля, которым нечего сказать, прячутся целиком, а вместо
   * них секция говорит это ОДИН раз словами.
   */
  const noSnapshot = !domain.fp_facts_at;

  /**
   * Наша запись против факта — все вопросы секции в ОДНОМ месте.
   *
   * Собраны сюда намеренно: вызовы почти одинаковы (`(recorded, facts)`), и
   * подмена аргумента — `phpVersionSource(domain.site_user, facts)` — исправно
   * компилируется. Здесь рассинхрон виден одним взглядом по столбику, а
   * разбросанный по восьми точкам JSX его пришлось бы искать.
   */
  const src = {
    ftpLogin: ftpLoginSource(domain.ftp_user, facts),
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

  /**
   * Домашняя папка аккаунта, если она ОТЛИЧАЕТСЯ от пути сайта.
   *
   * У типового аккаунта это тот же путь, и он уже стоит в Site → Path — третья
   * его копия на экране ничего не добавляет. Вопрос «та же ли это папка» задаём
   * тем же `samePath`, что и правило расхождения, а не своим сравнением строк:
   * хвостовой слэш стороны пишут как придётся, и вторая нормализация
   * разъехалась бы с первой (принцип №6 CLAUDE.md).
   */
  const otherHome = (home: string | null): string | null =>
    home && !samePath(home, facts?.site?.site_path) ? home : null;

  /**
   * Стоит ли рисовать перечень «Accounts on server».
   *
   * У типового домена аккаунт ровно один, он же напечатан выше полем `Login`, а
   * его `home` погашен как копия пути сайта — то есть перечень получается одной
   * строкой, дословно повторяющей строку над собой, в той же колонке.
   *
   * Гасим блок ЦЕЛИКОМ, а не вычищаем из него основной логин: «Accounts on
   * server» — это ПЕРЕЧЕНЬ аккаунтов домена, и список, из которого молча изъят
   * один, врал бы собственному заголовку (человек прочтёт «на сервере есть
   * только эти» и не найдёт того, которым сам подключается). Поэтому условие
   * ровно одно: есть ли в перечне хоть одна строка, говорящая что-то новое, —
   * другой логин либо непривычная домашняя папка. Есть — печатаем перечень
   * ПОЛНОСТЬЮ, включая основной; нет — не печатаем вовсе.
   */
  const ftpRosterAdds =
    !!facts &&
    facts.ftp_accounts.some(
      (a) => a.login.trim() !== (factFtpLogin ?? "").trim() || otherHome(a.home) !== null,
    );

  return (
    // Своей верхней границы у секции больше нет: она теперь тело вкладки, а
    // строка вкладок над ней рисует свою линию — две подряд читались бы как
    // пустая полоса. Отступ — по макету панели (24px сверху; горизонтальные и
    // нижний даёт `Modal`).
    <div style={{ paddingTop: 24 }}>
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
        // `overflowWrap` — текст ЧУЖОЙ: это ответ ssh или FastPanel, и в нём
        // сидит неразрывный токен (путь, ключ хоста, URL). Без переноса он
        // распирает модалку и даёт ей горизонтальную полосу, запрещённую
        // `design-brief.md` §11. Тот же приём и той же формулировкой одет
        // `Last error` в карточке и ошибки записи в полях ряда связей.
        <div role="alert" style={{ fontSize: 12, color: "#b91c1c", marginBottom: 8, overflowWrap: "anywhere" }}>
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
        {/* `minmax(0, 1fr)`, а не `1fr`: голый `1fr` — это `minmax(auto, 1fr)`,
            и минимум трека равен ширине содержимого, поэтому один неразрывный
            токен (путь, чужая ошибка) распирает колонку за ширину модалки. У
            `Modal` стоит `overflowY: auto`, из-за чего `overflow-x` вычисляется
            в `auto` — распёртая колонка даёт КАРТОЧКЕ горизонтальную полосу,
            запрещённую `design-brief.md` §11. Ряд связей этажом выше держит ту
            же дисциплину (`DomainLinks`), и по той же причине колонкам нужен
            `minWidth: 0`: у grid-элемента он по умолчанию равен содержимому, и
            без него в трек упрётся не текст, а сам столбец. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16, marginTop: 8 }}>
          {/* ─── FTP ─────────────────────────────────────────────────────── */}
          <div style={{ display: "grid", gap: 6, alignContent: "start", minWidth: 0 }}>
            <SubTitle>FTP access</SubTitle>
            {/* Host и Port — не про снимок: адрес берётся у сервера, порт
                константа. У домена без сервера Host остаётся прочерком. */}
            <Row k="Host" v={server?.ip_address} />
            <Row k="Port" v={FTP_PORT} />
            <FactRow k="Login" fact={listFact(factFtpLogin)} src={src.ftpLogin} />
            <FtpPassword domain={domain} desktop={desktop} />
            {ftpRosterAdds && facts ? (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>Accounts on server</div>
                {facts.ftp_accounts.map((a) => (
                  // `overflowWrap` — путь тут печатается ровно в интересном
                  // случае: когда он НЕ совпал с путём сайта, то есть когда он
                  // нестандартный и, скорее всего, длинный. Без переноса он
                  // распирает колонку и даёт модалке горизонтальную полосу.
                  <div key={a.login} style={{ fontSize: 12.5, color: "#374151", overflowWrap: "anywhere" }}>
                    {a.login}
                    {otherHome(a.home) ? <span style={{ color: MUTED }}> · {otherHome(a.home)}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
  
          {/* ─── Site ────────────────────────────────────────────────────── */}
          {/* На всю ширину блок растягивался, пока в ряду выше стояли ДВА
              соседа (FTP и SSL). SSL уехал на Overview, соседей стало два
              всего — и растяжка оставила бы половину первого ряда пустой. */}
          <div style={{ display: "grid", gap: 6, alignContent: "start", minWidth: 0 }}>
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
