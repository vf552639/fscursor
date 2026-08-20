import React, { ChangeEvent } from "react";

import { clip, errorText } from "../../api/cfAutoBind";
import { useDnsRecords } from "../../api/cloudflare";
import { Domain, useUpdateDomain } from "../../api/domains";
import { Server, useServers } from "../../api/servers";
import { domainOriginCheck, type OriginCheck } from "../../lib/domainOriginCheck";
import { isTauri } from "../../lib/runtime";
import { Sel } from "../ui/Primitives";

/** Приглушённый текст пояснения — тот же тон, что у прочих подписей карточки. */
const NOTE_TEXT = "#6b7280";
/** «Требует внимания, но не отказ» — тот же янтарь, что у соседних полей карточки. */
const WARN_TEXT = "#b45309";
const ERROR_TEXT = "#991b1b";

export interface DomainServerFieldProps {
  domain: Domain;
}

/**
 * Сервер домена: выбор по имени, адрес под селектом и сверка с A-записью.
 *
 * Раньше на этом месте стоял read-only `ServerLink` — «сервер домену назначает
 * развёртывание, а не карточка», с подписью «A domain gets its server when it is
 * deployed». **Решение отменено, потому что подпись была неверна.** Provision
 * `server_id` не ставит, а ЧИТАЕТ и без него падает с `domain has no server_id`
 * (`commands/provision.rs`): связка обязана существовать ДО развёртывания. То
 * есть read-only не охраняло инвариант, а закрывало нормальный путь — и
 * инвариант всё равно нарушался, потому что массовое `bulk-assign-server` пишет
 * `server_id` без единой проверки.
 *
 * Близнец `DomainRegistrarField` и намеренно повторяет ВСЕ его правила состояний
 * (три состояния списка, удержание ненайденного id, отдельный отказ записи): это
 * одно правило продукта на весь ряд связей, а не три похожих поля. Расхождение
 * с третьим соседом (`DomainCloudflareField` молча падает в «— No Cloudflare
 * account —») по-прежнему записано у регистратора и снимается переносом правила
 * туда, а не сюда.
 *
 * Работает и в вебе, и это не нарушение принципа 3 (CLAUDE.md): назначение
 * сервера — метаданные (`PUT /domains/{id}`, владение связок проверяет
 * `_ensure_links_owned`). Десктопным остаётся ИСПОЛНЕНИЕ — развёртывание, SSH,
 * чтение снимка, — и сверка с DNS ниже.
 *
 * Своего у поля два ответа, которых нет у соседей.
 *
 * 1. **Сверка с A-записью.** Связка в базе — НАША запись; куда на самом деле
 *    пойдёт запрос, знает только DNS. Показываем ТОЛЬКО расхождение и селект при
 *    этом не блокируем: назначить сервер до развёртывания — нормальный путь, и
 *    требовать в этот момент готовой A-записи значило бы запретить сам сценарий.
 * 2. **Строка про переезд.** Смена `server_id` сайт не переносит — переносится
 *    поле в базе. Снимок `fp_facts` с прежней машины бэкенд при этом гасит
 *    (иначе вкладка Server печатала бы FTP-логин старого сервера рядом с IP
 *    нового), и это стоит сказать ДО клика, а не показать пропавшими данными
 *    после.
 */
export default function DomainServerField({ domain }: DomainServerFieldProps) {
  const serversQ = useServers();
  /**
   * `undefined` — списка нет: он ещё грузится либо не прочитался. Это ТРЕТЬЕ
   * состояние, а не пустой список: по пустому мы вправе сказать «такого сервера
   * больше нет», по отсутствующему — нет.
   *
   * `useServers` отдаёт `{ items, total }`, а не голый массив: пропущенный
   * `.items` дал бы `undefined` на каждом рендере, то есть вечную «загрузку».
   */
  const servers: Server[] | undefined = serversQ.data?.items;
  const update = useUpdateDomain(domain.id);
  const serverId = domain.server_id;
  const server = servers?.find((s) => s.id === serverId);

  /**
   * У домена стоит `server_id`, а сервера под ним в списке нет — потому ли, что
   * список ещё не прочитан, или потому, что машину удалили.
   *
   * Селект обязан остаться В ЭТОМ ЗНАЧЕНИИ: встав в «— No server —», он
   * утверждал бы, что связи нет, тогда как в БД она есть. Человек, поверивший
   * пустому селекту, «назначает» сервер заново и не меняет ничего — либо,
   * наоборот, не замечает, что домен привязан к исчезнувшей машине.
   */
  const unresolved = serverId != null && !server;
  /** id строки-подписи: она объясняет состояние селекта, и связь нужна явная. */
  const noteId = `domain-server-note-${domain.id}`;

  /**
   * Записи зоны — ради одной строки сверки, и запрос сознательно гасится вне
   * десктопа ЗДЕСЬ, а не в хуке.
   *
   * `useDnsRecords` включён по `!!accountId && !!zoneId` и на `isTauri` не
   * смотрит (в отличие от `zonesQuery` этажом выше в том же файле), а его
   * `queryFn` начинается с `requireDesktop`. То есть в вебе у домена с зоной он
   * гарантированно падает — походом в никуда и красным состоянием запроса,
   * которое этому полю негде и незачем показывать: сверка с DNS в вебе не
   * предусмотрена вовсе. Гасим на месте вызова, а не правкой хука: у него есть
   * второй потребитель (страница Cloudflare), и его поведение — не объём этой
   * работы.
   *
   * **И в десктопе гасим у домена БЕЗ сервера — потому что чтение не бесплатное.**
   * Это `sync_now` по SQLCipher-кэшу плюс поход в Cloudflare, при глобальном
   * `staleTime` 10с, то есть практически на каждое открытие карточки. Сверять
   * при этом не с чем по построению: без `server_id` (а значит и без адреса)
   * `domainOriginCheck` вернёт `unknown`, и ответ будет выброшен целиком. Платить
   * им пришлось бы ровно на тех доменах — «заведён, ещё не привязан», — карточку
   * которых открывают чаще всего.
   *
   * Условие именно на `domain.server_id`, а не на `server?.ip_address`, и это не
   * придирка к букве: `enabled`, зависящий от данных ДРУГОГО запроса, — это
   * ВОДОПАД. Карточка ждала бы ответа `/servers`, прежде чем начать чтение DNS,
   * и задержку платили бы все домены. Выигрыш при этом живёт в пересечении трёх
   * условий сразу (десктоп × холодный кэш × сервер с пустым `ip_address`, см.
   * `stateNote`) — а на странице Domains список серверов обычно уже в кэше (тот
   * же `queryKey`), то есть водопад вырождается вместе с самим выигрышем.
   * Цена — у всех и всегда, выгода — почти ни у кого.
   */
  const dnsQ = useDnsRecords(
    isTauri() && domain.server_id != null ? domain.cloudflare_account_id : null,
    domain.cloudflare_zone_id,
  );
  /**
   * Отказ чтения DNS сюда не доезжает намеренно: `data` остаётся `undefined`,
   * а это `unknown` — «сверять нечем». Незнание молчит, а не обвиняет
   * (CLAUDE.md §6): расхождение — утверждение, и делать его по непрочитанной
   * зоне нельзя. Само поле от провала чтения не страдает — сервер оно назначает
   * без всякого DNS.
   */
  const origin = domainOriginCheck(dnsQ.data, domain.domain_name, server?.ip_address);

  function pickServer(value: string) {
    const next = value ? Number(value) : null;
    if (next === serverId) return;
    // Одно поле и никаких побочных сбросов. Снимок прежней машины (`fp_facts`,
    // `fp_facts_at`, `fp_check_error`, `fp_checked_at`) гасит бэкенд в той же
    // транзакции; второй писатель тех же колонок отсюда разошёлся бы с ним при
    // первой же правке — и «наполовину забытый» снимок никто бы не заметил.
    update.mutate({ server_id: next });
  }

  // `minWidth: 0` — карточка ряда связей это grid-элемент шириной в треть
  // модалки (~215px), а его минимальная ширина по умолчанию равна ширине
  // содержимого: без этого длинное имя сервера в селекте распирало бы колонку,
  // а не упиралось в неё.
  //
  // Видимого ярлыка «Server:» перед селектом нет: его печатает шапка-полоска
  // карточки, в которую поле вставлено (`DomainLinks`). Скринридер имя поля при
  // этом не теряет — оно на самом селекте (`aria-label`).
  //
  // Имя поля ШИРЕ имени карточки («Assigned server» против титула `SERVER`) —
  // по тому же правилу, что у обоих соседей ряда (`Registrar account`,
  // `Cloudflare account`). Совпади они, у карточки и у селекта было бы одно имя
  // на двоих: `role="group"` берёт своё через `aria-labelledby` на `<h3>`, и
  // обращение по имени становится двусмысленным — и для скринридера, и для
  // тестов.
  return (
    <div style={{ minWidth: 0 }}>
      <Sel
        aria-label="Assigned server"
        aria-describedby={noteId}
        value={serverId == null ? "" : String(serverId)}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => pickServer(e.target.value)}
        // Списка нет — выбирать не из чего: остаются пункт «снять привязку» и
        // (у домена с сервером) пункт-заглушка под собственный id. Селект,
        // умеющий только стереть связь, честнее выключить.
        disabled={update.isPending || !servers}
        // `<select>` тянется по самой широкой опции и наружу из своей колонки:
        // grid-элемент содержимое не клипует.
        style={{ padding: "4px 8px", fontSize: 12.5, maxWidth: "100%" }}
      >
        <option value="">— No server —</option>
        {/* Пункт под сохранённый id, которого нет в списке. Без него React не
            смог бы поставить селект в это значение (опции с таким `value` нет),
            и браузер показал бы пустое поле — то самое «связи нет». */}
        {unresolved ? (
          <option value={String(serverId)}>
            {servers ? `#${serverId} · server not found` : `#${serverId}`}
          </option>
        ) : null}
        {(servers ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Sel>
      {update.isError ? (
        // `overflowWrap` — чужая ошибка приезжает телом ответа: URL или JSON без
        // единого пробела не перенесётся сам и уедет за край карточки.
        <div
          role="alert"
          style={{ fontSize: 12, color: ERROR_TEXT, marginTop: 4, overflowWrap: "anywhere" }}
        >
          Could not save: {clip(errorText(update.error))}
        </div>
      ) : null}
      <ServerNote
        id={noteId}
        serverId={serverId}
        server={server}
        serversKnown={!!servers}
        serversError={serversQ.error}
        saving={update.isPending}
        origin={origin}
        hasSnapshot={!!domain.fp_facts_at}
      />
    </div>
  );
}

interface ServerNoteProps {
  id: string;
  serverId: number | null;
  server: Server | undefined;
  serversKnown: boolean;
  /**
   * Отказ чтения списка. Живёт ОТДЕЛЬНО от `serversKnown`: при провале рефетча
   * TanStack оставляет прежние `data` и ставит `error` — то есть список есть, но
   * он устарел, и утверждать по нему «сервер удалили» уже нельзя.
   */
  serversError: unknown;
  saving: boolean;
  origin: OriginCheck;
  /** Есть ли у домена снимок с сервера — от него зависит строка про переезд. */
  hasSnapshot: boolean;
}

const noteLine = (color: string, text: React.ReactNode, key?: string) => (
  <div key={key} style={{ fontSize: 12, color, marginTop: 3, overflowWrap: "anywhere" }}>
    {text}
  </div>
);

const readFailure = (e: unknown) => `Servers could not be read: ${clip(errorText(e))}`;

/**
 * Строка расхождения. Оба конца в одной фразе: без чужого адреса человеку не с
 * чем идти в панель Cloudflare, без своего непонятно, что именно «не тот».
 *
 * Форм две, потому что зон две. На единственной A множественное число врало бы
 * о числе записей; на нескольких — единственное отрицало бы существование
 * соседних («ведёт на 9.9.9.9» при живом 8.8.8.8 рядом), а это ровно та
 * половина правды, из-за которой в панели Cloudflare человек увидит не то, что
 * ему обещали. Адреса приходят уже отсортированными (`domainOriginCheck`): их
 * порядок обязан зависеть от содержимого зоны, а не от порядка ответа API.
 */
function mismatchText(origins: string[], ip: string): string {
  if (origins.length === 1) {
    return `A record points to ${origins[0]} — not the selected server (${ip}).`;
  }
  return `A records point to ${origins.join(", ")} — none of them the selected server (${ip}).`;
}

/**
 * Строка под селектом: в каком состоянии связь, куда ведёт DNS и что случится
 * при смене машины.
 *
 * Обёрнута в один узел с `id`, а не возвращает голые строки: на неё ссылается
 * `aria-describedby` селекта. Без этой связи «Loading servers…» существует
 * только визуально — выключенный селект фокуса не получает, и озвучить причину
 * его состояния скринридеру нечем. Сверка и предупреждение о переезде входят в
 * тот же узел намеренно: это описание СДЕЛАННОГО выбора и его последствий,
 * то есть ровно то, что при фокусе на селекте надо услышать.
 */
function ServerNote(props: ServerNoteProps) {
  const { saving, origin, server, hasSnapshot } = props;
  return (
    <div id={props.id}>
      {stateNote(props)}
      {/* Пока запись идёт, обе строки ниже говорили бы о СТАРОМ сервере (свежую
          строку домена карточка получит после инвалидации) — то есть отвечали бы
          про прошлый выбор на только что сделанный. Молчим до ответа, как и
          диагноз выше. */}
      {!saving && origin.kind === "mismatch" && server
        ? noteLine(WARN_TEXT, mismatchText(origin.origins, server.ip_address), "origin")
        : null}
      {!saving && hasSnapshot
        ? noteLine(
            NOTE_TEXT,
            // То, что фаза 1 делает на бэкенде, названное словами ДО клика:
            // иначе про сброшенный снимок человек узнаёт по опустевшей вкладке
            // Server и читает это как поломку.
            "Changing the server moves only the record — the site stays on the old machine, and the snapshot will be read again.",
            "move",
          )
        : null}
    </div>
  );
}

function stateNote({
  serverId,
  server,
  serversKnown,
  serversError,
  saving,
}: ServerNoteProps): React.ReactNode {
  if (saving) {
    // Пока запись идёт, селект выключен и стоит в СТАРОМ значении. Прежний
    // диагноз под ним читался бы как ответ на только что сделанный выбор —
    // «не назначен» под погасшим полем выглядит отказом.
    return noteLine(NOTE_TEXT, "Saving…");
  }

  if (serverId == null) {
    // Первым, ДО состояния списка: «сервера нет» читается из самой строки
    // домена и от чужого запроса не зависит. Формулировка называет ПОСЛЕДСТВИЕ,
    // а не обряд: `domain has no server_id` — то, чем provision падает, и
    // прежнее «A domain gets its server when it is deployed» обещало обратное.
    //
    // А вот ОТКАЗ чтения списка проглатывать нельзя: лекарство в этот момент
    // мёртвое (выбирать не из чего), и без второй строки экран говорит «назначь
    // сервер» выключенным селектом без единого слова почему.
    return (
      <>
        {noteLine(WARN_TEXT, "Not assigned — deployment has nowhere to go.", "gap")}
        {serversError ? noteLine(WARN_TEXT, readFailure(serversError), "read") : null}
      </>
    );
  }

  if (!serversKnown) {
    // Отказ чтения списка — это «не знаем», а не «сервера нет»: причина
    // называется его же словами, иначе выключенный селект выглядит поломкой
    // карточки.
    if (serversError) return noteLine(WARN_TEXT, readFailure(serversError));
    return noteLine(NOTE_TEXT, "Loading servers…");
  }

  if (!server) {
    // Список есть, но он мог не обновиться (см. `serversError`). «Сервер
    // удалили» — утверждение, и делать его по заведомо устаревшему списку
    // нельзя: чаще всего это протухший токен, а не удалённая машина.
    if (serversError) {
      return (
        <>
          {noteLine(WARN_TEXT, `Server #${serverId} is not in the list.`, "gone")}
          {noteLine(WARN_TEXT, readFailure(serversError), "read")}
        </>
      );
    }
    return noteLine(
      WARN_TEXT,
      `Server #${serverId} is not in the list — it was probably deleted. Pick another one.`,
    );
  }

  // Адрес — тот же, что карточка FTP на вкладке Server печатает как Host, и из
  // того же объекта, а не из второго чтения.
  //
  // Пустой `ip_address` схема допускает ОСОЗНАННО (`schemas/server.py`), а формы
  // продукта его не производят (`lib/ipInput` пустую строку не пропускает) —
  // значит такой сервер приезжает прямым вызовом API или из строк, заведённых
  // до валидации. Молчать о нём нельзя: у такого сервера provision пойдёт в
  // `""`, карточка FTP покажет пустой Host, а сверка с A-записью замолчит по
  // построению — три следствия и ни одного слова, если вместо строки оставить
  // пустоту.
  return server.ip_address.trim()
    ? noteLine(NOTE_TEXT, server.ip_address)
    : noteLine(WARN_TEXT, "No IP address on this server.");
}
