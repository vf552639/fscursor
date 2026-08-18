import React, { useState } from "react";

import { Domain, useUpdateDomain } from "../../api/domains";
import { Server } from "../../api/servers";
import { ftpLoginSource, samePath } from "../../lib/domainDrift";
import { BLOB_KIND } from "../../lib/secretBlob";
import { isTauri } from "../../lib/runtime";
import { useSecretSave } from "../../hooks/useSecretSave";
import { RevealSecret } from "../RevealSecret";
import { Btn, Inp, SectionCard } from "../ui/Primitives";
import { FactRow, KEY_GAP, KEY_WIDTH, MUTED, Row } from "./facts/fields";
import { type Snapshot } from "./facts/snapshot";

/**
 * Карточка «FTP Access» вкладки Server — ответ на вопрос «чем и куда
 * подключаться к сайту»: адрес, порт, логин, пароль и перечень аккаунтов,
 * которые сервер знает за этим доменом.
 *
 * Снимок сервера приходит уже разобранным (от вкладки), а не берётся своим
 * вызовом `snapshotOf`: карточки Server читают ОДИН снимок вместе с подписью
 * его возраста в строке над ними, и второй разбор рядом с первым разъезжается
 * молча — так же, как разъезжались правила, которые этот проект потом сводил
 * обратно в один модуль (`lib/serverStatus`, `lib/domainFacts`,
 * `lib/domainDrift`). Из разбора карточке отданы РОВНО факты — единственное,
 * что она читает: возраст и протухание принадлежат той единственной строке, и
 * карточка, начавшая печатать `freshness` у себя, вернула бы на экран два
 * ответа про один снимок. «Снимка не было» ей больше не нужно вовсе — на этот
 * вопрос за неё отвечает контекст `HasSnapshot` внутри `FactRow`.
 *
 * Правило «наша запись против факта» тут не живёт: считает его
 * `lib/domainDrift`, рисует общий `FactRow` (`facts/fields`). Здесь — раскладка
 * и ТРИ своих решения, все три про честность показа:
 *
 * 1. `factFtpLogin` — какой аккаунт представляет список в строке `Login`;
 * 2. `otherHome` — когда домашняя папка аккаунта говорит что-то новое, а когда
 *    она третья копия пути сайта на экране;
 * 3. `ftpRosterAdds` — когда перечень внизу вообще стоит рисовать.
 *
 * А вот «пустой список — это незнание, а не измеренная пустота» здесь НЕ
 * решается: вопрос общий с карточкой Site, и ответ на него один — проп `list`
 * у `FactRow` (`facts/fields`).
 */

/**
 * Порт FTP у FastPanel — стандартный 21 (pure-ftpd/proftpd слушают его). Отдельным
 * полем домен/сервер его не хранит; при живом прогоне это и подтвердится.
 */
const FTP_PORT = 21;

export default function DomainFtpCard({
  domain,
  server,
  snapshot,
}: {
  domain: Domain;
  /** Сервер домена: его адрес и есть Host. `undefined` — сервера у домена нет. */
  server: Server | undefined;
  snapshot: Pick<Snapshot, "facts">;
}) {
  const { facts } = snapshot;
  const desktop = isTauri();

  // Одним значением, а не объектом `src`, как в карточке Site: там столбик из
  // пяти почти одинаковых вызовов, и собраны они ради того, чтобы подмена
  // аргумента бросалась в глаза; здесь вызов ровно один, и объект вокруг него
  // намекал бы на правило, которого не существует.
  const ftpLoginSrc = ftpLoginSource(domain.ftp_user, facts);

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
    (ftpLoginSrc.kind === "agree" ? domain.ftp_user?.trim() || null : null) ||
    facts?.ftp_accounts[0]?.login ||
    null;

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
    <SectionCard title="FTP Access">
      {/* `minWidth: 0` — карточка стоит в двухколоночном гриде, а печатает
          ЧУЖИЕ строки (логины и домашние папки с сервера): без него grid-элемент
          не сожмётся уже своего содержимого, распёртая колонка даст модалке
          горизонтальную полосу, запрещённую `design-brief.md` §11, — а под
          `overflow: hidden` самой карточки строка ещё и обрежется. */}
      <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
        {/* Host и Port — не про снимок: адрес берётся у сервера, порт
            константа. У домена без сервера Host остаётся прочерком. */}
        <Row k="Host" v={server?.ip_address} />
        <Row k="Port" v={FTP_PORT} />
        {/* `list` — факт этого поля СПИСОК (аккаунты FTP), и пустой список под
            снимком значит «не прочитали», а не «на сервере пусто»
            (`FactRow`, пункт 3). */}
        <FactRow k="Login" fact={factFtpLogin} src={ftpLoginSrc} list />
        <FtpPassword domain={domain} desktop={desktop} />
        {ftpRosterAdds && facts ? (
          <div>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>Accounts on server</div>
            {facts.ftp_accounts.map((a) => {
              const home = otherHome(a.home);
              return (
                // `overflowWrap` — путь тут печатается ровно в интересном
                // случае: когда он НЕ совпал с путём сайта, то есть когда он
                // нестандартный и, скорее всего, длинный. Без переноса он
                // распирает колонку и даёт модалке горизонтальную полосу.
                <div key={a.login} style={{ fontSize: 12.5, color: "#374151", overflowWrap: "anywhere" }}>
                  {a.login}
                  {home ? <span style={{ color: MUTED }}> · {home}</span> : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </SectionCard>
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
    // Ширина подписи и отступ до значения — общие `KEY_WIDTH`/`KEY_GAP`, а не
    // свои числа: строка стоит в столбике полей карточки, и пара пикселей
    // расхождения читается сбоем вёрстки — колонка значений начиналась бы у
    // пароля не там, где у всех соседей. `flexWrap` — потому что справа от
    // подписи живут сразу два элемента (значение и кнопка), а карточка узкая
    // (389px по макету).
    <div style={{ display: "flex", alignItems: "center", gap: KEY_GAP, flexWrap: "wrap" }}>
      <b style={{ color: "#6b7280", fontWeight: 600, minWidth: KEY_WIDTH, fontSize: 13 }}>Password</b>
      {domain.ftp_password_blob_id ? (
        // Обёртка — не украшение: `RevealSecret` печатает раскрытый пароль
        // `<code>`, у которого нет правила переноса, а как flex-элемент он ещё
        // и не сжимается уже содержимого (`min-width: auto`). Раньше длинный
        // пароль просто распирал секцию; теперь вокруг стоит `SectionCard` с
        // `overflow: hidden`, и он молча ОБРЕЗАЛСЯ БЫ по краю карточки — то
        // есть кнопка «показать» показывала бы половину секрета. Тем же одета
        // и ошибка расшифровки: в ней приезжает чужой текст с URL.
        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
          <RevealSecret blobId={domain.ftp_password_blob_id} label="Show FTP password" />
        </span>
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
