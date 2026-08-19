import React, { ChangeEvent } from "react";

import { clip, errorText } from "../../api/cfAutoBind";
import { Domain, useUpdateDomain } from "../../api/domains";
import { RegistrarAccount, useRegistrarAccounts } from "../../api/registrars";
import { providerMeta } from "../../lib/registrarProviders";
import { ProviderAvatar, ProviderLabel } from "../settings/ProviderVisuals";
import { Sel } from "../ui/Primitives";

/** Приглушённый текст пояснения — тот же тон, что у прочих подписей карточки. */
const NOTE_TEXT = "#6b7280";
/** «Требует внимания, но не отказ» — тот же янтарь, что у соседних полей карточки. */
const WARN_TEXT = "#b45309";
const ERROR_TEXT = "#991b1b";

export interface DomainRegistrarFieldProps {
  domain: Domain;
}

/**
 * Аккаунт регистратора домена: выбор по имени и метка провайдера.
 *
 * Младший брат `DomainCloudflareField` — тот же селект по тем же правилам, но без
 * дорезолва: у регистратора нет второй половины привязки (аналога зоны), и
 * зависимых полей в строке домена у него тоже нет, поэтому смена аккаунта пишет
 * ровно одно поле и ничего не обнуляет. `ns_status`/`ns_check_mode` зависимыми не
 * считаются намеренно: это запись о ПРОШЛОЙ попытке пуша, а не указатель на
 * учётку, и живую правду о делегировании всё равно даёт сверка с реестром
 * (`lib/nsDelegation`), а не эти колонки. Обнулить их при смене аккаунта значило
 * бы стереть историю, ничего не узнав взамен.
 *
 * Заведено ради одного разрыва: панель NS внизу той же карточки печатает «Assign
 * a registrar account to this domain first», а назначить его было негде — в поле
 * стояло сырое `registrar_id`. Диагноз без лекарства отправлял человека на
 * другой экран искать, чем починить то, что он видит здесь.
 *
 * Работает и в вебе, и это не нарушение принципа 3 (CLAUDE.md): назначение
 * аккаунта — метаданные (`PUT /domains/{id}`), ровно как у селекта Cloudflare.
 * Десктопным остаётся ИСПОЛНЕНИЕ — пуш NS через API регистратора, и живёт оно в
 * панели ниже. Гейта на Tauri здесь нет намеренно.
 *
 * Чего здесь НЕТ намеренно: бейджа «API/manual», кнопки Test connection и ссылки
 * в настройки регистраторов. Ответ «умеет ли этот регистратор писать NS» даёт
 * панель NS (`registrarSupportsNsApi`) — там, где стоит кнопка, которую он
 * включает. Второй такой ответ в двух сантиметрах выше означал бы два источника
 * правды на одном экране, а они уже расходились (см. `hasApi` в
 * `lib/registrarProviders`).
 *
 * РАСХОЖДЕНИЕ С СОСЕДОМ, осознанное. В ряду связей это поле встанет вплотную к
 * `DomainCloudflareField`, и на двух состояниях они ведут себя по-разному:
 * сохранённый аккаунт, которого нет в списке, здесь удерживает значение селекта
 * и называется «account not found», а там селект молча падает в «— No Cloudflare
 * account —» (то есть рисует «связи нет» поверх связи, которая в БД есть); и
 * пока список аккаунтов не прочитан, здесь селект выключен, а там — нет.
 * Правильная сторона расхождения эта, но соседа в этой ветке не правим: он вне
 * объёма фазы, его правка — своя работа со своими тестами (у него ещё и дорезолв
 * зоны на том же селекте). Расхождение записано здесь, чтобы читатель ряда не
 * принял его за случайность, и снимается оно переносом ЭТОГО правила туда.
 */
export default function DomainRegistrarField({ domain }: DomainRegistrarFieldProps) {
  const accountsQ = useRegistrarAccounts();
  /**
   * `undefined` — списка нет: он ещё грузится либо не прочитался. Это ТРЕТЬЕ
   * состояние, а не пустой список: по пустому мы вправе сказать «такого аккаунта
   * больше нет», по отсутствующему — нет.
   */
  const accounts: RegistrarAccount[] | undefined = accountsQ.data;
  const update = useUpdateDomain(domain.id);
  const registrarId = domain.registrar_id;
  const account = accounts?.find((a) => a.id === registrarId);

  /**
   * У домена стоит `registrar_id`, а аккаунта под ним в списке нет — потому ли,
   * что список ещё не прочитан, или потому, что аккаунт удалили.
   *
   * Селект обязан остаться В ЭТОМ ЗНАЧЕНИИ: встав в «— No registrar account —»,
   * он утверждал бы, что связи нет, тогда как в БД она есть. Человек, поверивший
   * пустому селекту, «назначает» регистратора заново и не меняет ничего — либо,
   * наоборот, не замечает, что домен привязан к исчезнувшей учётке.
   */
  const unresolved = registrarId != null && !account;
  /** id строки-подписи: она объясняет состояние селекта, и связь нужна явная. */
  const noteId = `registrar-account-note-${domain.id}`;

  function pickAccount(value: string) {
    const next = value ? Number(value) : null;
    if (next === registrarId) return;
    // Одно поле и никаких побочных сбросов: у Cloudflare смена аккаунта обнуляет
    // зону, потому что зона принадлежала старому аккаунту, — у регистратора
    // подобного поля в строке домена нет.
    update.mutate({ registrar_id: next });
  }

  // `minWidth: 0` — карточка ряда связей это grid-элемент шириной в треть модалки
  // (~215px), а его минимальная ширина по умолчанию равна ширине содержимого:
  // без этого длинное имя аккаунта в селекте распирало бы колонку, а не
  // упиралось в неё.
  //
  // Видимого ярлыка «Registrar:» перед селектом нет: его печатает шапка-полоска
  // карточки, в которую поле вставлено (`DomainLinks`), и второй такой же рядом
  // был бы одним словом дважды. Скринридер имя поля при этом не теряет — оно на
  // самом селекте (`aria-label`), а не в этой строке.
  return (
    <div style={{ minWidth: 0 }}>
      <Sel
        aria-label="Registrar account"
        aria-describedby={noteId}
        value={registrarId == null ? "" : String(registrarId)}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => pickAccount(e.target.value)}
        // Списка нет — выбирать не из чего: остаются пункт «снять привязку» и
        // (у домена с аккаунтом) пункт-заглушка под собственный id. Селект,
        // умеющий только стереть связь, честнее выключить.
        disabled={update.isPending || !accounts}
        // `<select>` тянется по самой широкой опции и наружу из своей колонки:
        // grid-элемент содержимое не клипует.
        style={{ padding: "4px 8px", fontSize: 12.5, maxWidth: "100%" }}
      >
        <option value="">— No registrar account —</option>
        {/* Пункт под сохранённый id, которого нет в списке. Без него React не
            смог бы поставить селект в это значение (опции с таким `value` нет),
            и браузер показал бы пустое поле — то самое «связи нет». */}
        {unresolved ? (
          <option value={String(registrarId)}>
            {accounts ? `#${registrarId} · account not found` : `#${registrarId}`}
          </option>
        ) : null}
        {(accounts ?? []).map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
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
      <AccountNote
        id={noteId}
        registrarId={registrarId}
        account={account}
        accountsKnown={!!accounts}
        accountsError={accountsQ.error}
        saving={update.isPending}
      />
    </div>
  );
}

interface AccountNoteProps {
  id: string;
  registrarId: number | null;
  account: RegistrarAccount | undefined;
  accountsKnown: boolean;
  /**
   * Отказ чтения списка. Живёт ОТДЕЛЬНО от `accountsKnown`: при провале рефетча
   * TanStack оставляет прежние `data` и ставит `error` — то есть список есть, но
   * он устарел, и утверждать по нему «аккаунт удалили» уже нельзя.
   */
  accountsError: unknown;
  saving: boolean;
}

const noteLine = (color: string, text: React.ReactNode, key?: string) => (
  <div key={key} style={{ fontSize: 12, color, marginTop: 3, overflowWrap: "anywhere" }}>
    {text}
  </div>
);

const readFailure = (e: unknown) => `Registrar accounts could not be read: ${clip(errorText(e))}`;

/**
 * Строка под селектом. Отвечает на «какая учётка тут стоит и в каком она
 * состоянии» — по тому же правилу, что и `ZoneNote` у Cloudflare: у каждого
 * исхода своё имя, молчания нет ни в одном.
 *
 * Обёрнута в один узел с `id`, а не возвращает голую строку: на неё ссылается
 * `aria-describedby` селекта. Без этой связи «Loading accounts…» существует
 * только визуально — выключенный селект фокуса не получает, и озвучить причину
 * его состояния скринридеру нечем.
 */
function AccountNote(props: AccountNoteProps) {
  return <div id={props.id}>{noteBody(props)}</div>;
}

function noteBody({
  registrarId,
  account,
  accountsKnown,
  accountsError,
  saving,
}: AccountNoteProps): React.ReactNode {
  if (saving) {
    // Пока запись идёт, селект выключен и стоит в СТАРОМ значении (свежую строку
    // домена карточка получит после инвалидации). Прежний диагноз под ним читался
    // бы как ответ на только что сделанный выбор — «не назначен» под погасшим
    // полем выглядит отказом. То же правило, что у соседа: «Saving the zone…».
    return noteLine(NOTE_TEXT, "Saving…");
  }

  if (registrarId == null) {
    // Первым, ДО состояния списка: «регистратора нет» читается из самой строки
    // домена и от чужого запроса не зависит — ждать ради этого ответа список
    // значило бы держать на экране «загрузка» вместо готового диагноза. Тот же
    // диагноз печатает выключенная кнопка в панели NS внизу, но здесь он назван
    // вместе с лекарством, которое стоит строкой выше.
    //
    // А вот ОТКАЗ чтения списка проглатывать нельзя: лекарство в этот момент
    // мёртвое (выбирать не из чего), и без второй строки экран говорит «назначь
    // аккаунт» выключенным селектом без единого слова почему.
    return (
      <>
        {noteLine(WARN_TEXT, "Not assigned — there is nowhere to push nameservers.", "gap")}
        {accountsError ? noteLine(WARN_TEXT, readFailure(accountsError), "read") : null}
      </>
    );
  }

  if (!accountsKnown) {
    // Отказ чтения списка — это «не знаем», а не «аккаунта нет»: причина
    // называется его же словами, иначе выключенный селект выглядит поломкой
    // карточки.
    if (accountsError) return noteLine(WARN_TEXT, readFailure(accountsError));
    return noteLine(NOTE_TEXT, "Loading accounts…");
  }

  if (!account) {
    // Список есть, но он мог не обновиться (см. `accountsError`). «Аккаунт
    // удалили» — утверждение, и делать его по заведомо устаревшему списку
    // нельзя: чаще всего это протухший токен, а не удалённая учётка.
    if (accountsError) {
      return (
        <>
          {noteLine(WARN_TEXT, `Account #${registrarId} is not in the list.`, "gone")}
          {noteLine(WARN_TEXT, readFailure(accountsError), "read")}
        </>
      );
    }
    return noteLine(
      WARN_TEXT,
      `Account #${registrarId} is not in the list — it was probably deleted. Pick another one.`,
    );
  }

  // Провайдер — через общий `providerMeta`, а не своей табличкой: как выглядит
  // Hostiq или ручной ярлык, решено один раз на все экраны (`ProviderVisuals`).
  // `ProviderLabel` при этом покажет строку с пробелами по краям как есть — она
  // и есть причина, по которой такой аккаунт считается ручным.
  const meta = providerMeta(account.provider);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 12, color: NOTE_TEXT }}>
      {/* Размер аватара — из принятых в `ProviderVisuals` (28 в списке, 38 на
          карточке аккаунта): третья пропорция ради одной подписи ровно то, против
          чего тот файл и заведён. 22 — нижняя граница, при которой буква
          (`size * 0.4`) остаётся читаемой. */}
      <ProviderAvatar m={meta} size={22} />
      {/* `minWidth: 0` + клип: в ветке сырой строки `ProviderLabel` ставит
          `white-space: pre` — такой текст не переносится в принципе и вылез бы
          из карточки целиком. Полная строка остаётся в его же тултипе. */}
      <span style={{ minWidth: 0, overflow: "hidden", overflowWrap: "anywhere" }}>
        <ProviderLabel m={meta} />
      </span>
    </div>
  );
}
