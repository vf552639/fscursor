import { expiryTs } from "../../lib/domainExpiry";
import { sslState, sslStateRank } from "../../lib/domainFacts";
import { domainStatusRank } from "../../lib/domainStatus";
import { DomainUI } from "./types";

/** По какой колонке сортируем. Только те, у чьих значений есть порядок. */
export type SortKey = "domain" | "status" | "expiry_date" | "ssl" | "created";

export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

/**
 * Порядок по умолчанию — по имени домена, по возрастанию.
 *
 * Не «сначала свежие» и не «сначала просроченные»: список из сотен доменов —
 * это в первую очередь поверхность поиска («где тут shop.example.com»), а найти
 * известное имя глазами можно только в алфавите. Порядок, в котором строки
 * приезжают с бэкенда (по id, то есть по времени заведения), пользователю не
 * значит ничего: он не помнит, каким по счёту завёл домен.
 *
 * Срочное при этом не спрятано — оно в одном клике по заголовку Expires, и цвет
 * подписи виден в любом порядке.
 */
export const DEFAULT_SORT: Sort = { key: "domain", dir: "asc" };

/**
 * Сравнение двух значений, у которых бывает «не знаем» (`null`): неизвестное
 * всегда в конец, при ЛЮБОМ направлении.
 *
 * Ветки `null` стоят ДО умножения на направление — в этом всё правило и есть.
 * Одна функция на все ключи (даты, статус домена, статус сертификата) именно
 * потому, что незнание у них одно и то же: перевернув сортировку, пользователь
 * ищет либо самый горящий домен, либо самый дальний, и в обоих случаях список
 * начинался бы с тех, про кого ответа нет вовсе.
 */
function compareUnknownLast(a: number | null, b: number | null, mul: number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * mul;
}

/** Ключи, за которыми стоит дата. Отдельный тип — ради проверки `never` в `dateOf`. */
type DateSortKey = Extract<SortKey, "expiry_date" | "created">;

/**
 * Значение, по которому сортируется строка для ключа-даты.
 *
 * `switch` с проверкой `never` в `default`, а не фолбэк на `d.created`: раньше
 * любой новый `SortKey` уезжал сюда молча и сортировался по дате заведения.
 * Теперь новый ключ-дата — ошибка компиляции ровно в том месте, где для него
 * забыли поле.
 */
function dateOf(d: DomainUI, key: DateSortKey): string | null | undefined {
  switch (key) {
    case "expiry_date":
      return d.expiry_date;
    case "created":
      return d.created;
    default: {
      const unreachable: never = key;
      return unreachable;
    }
  }
}

/**
 * Отсортированная копия списка.
 *
 * Вынесена из тела `useMemo` целиком: правило «строки без даты — в конец при
 * ЛЮБОМ направлении» стоит того, чтобы быть видимым, а не спрятанным в
 * замыкании между фильтром и разметкой. Проверяется оно кликами по заголовкам
 * (`Domains.expiry.test.tsx`) — то есть тем самым порядком, который видит
 * пользователь, а не возвратом функции.
 *
 * Незнание (даты нет, статус незнакомый) уходит в конец при любом направлении —
 * см. `compareUnknownLast`.
 *
 * Колонка SSL сортируется ПО СОСТОЯНИЮ сертификата на сервере, а срок — лишь
 * второй ключ. Оба ключа читаются из СНИМКА (`ssl` + `facts_at`), тем же
 * `sslState`, каким ячейка рисует пилюлю, — и это главное, что здесь надо
 * знать: до фазы 1 колонка сортировала по `ssl_status` (нашей записи момента
 * provision), а показывала — сначала «есть/нет» по ней же, теперь состояние с
 * сервера. Ключ, разошедшийся с подписью, даёт порядок, который на экране
 * необъясним ничем; долг №3 плана редизайна был ровно про это.
 *
 * `now` приходит сверху, а не берётся здесь: тем же «сейчас» строка считает
 * свою пилюлю, и разные часы у порядка и у подписи снова развели бы их на
 * границе протухания — на неделе жизни снимка это ровно тот случай, ради
 * которого `useNow` и заведён.
 *
 * `unchecked` («не проверяли») в лестницу рангов не входит и уходит в конец при
 * ЛЮБОМ направлении — см. `compareUnknownLast` и `sslStateRank`.
 */
export function sortDomains(rows: DomainUI[], sort: Sort, now: number = Date.now()): DomainUI[] {
  const mul = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let primary: number;
    if (sort.key === "domain") {
      primary = a.domain.localeCompare(b.domain) * mul;
    } else if (sort.key === "status") {
      primary = compareUnknownLast(domainStatusRank(a.status), domainStatusRank(b.status), mul);
    } else if (sort.key === "ssl") {
      primary =
        compareUnknownLast(sslStateRank(sslState(a.ssl, a.facts_at, now)), sslStateRank(sslState(b.ssl, b.facts_at, now)), mul) ||
        compareUnknownLast(expiryTs(a.ssl?.expires_at), expiryTs(b.ssl?.expires_at), mul);
    } else {
      primary = compareUnknownLast(expiryTs(dateOf(a, sort.key)), expiryTs(dateOf(b, sort.key)), mul);
    }
    // Равные ключи — по имени. Иначе полсотни доменов с одной датой покупки
    // встают в порядке заведения, в котором глазами не найти ничего, и порядок
    // этот меняется от каждой вставки строки в базу.
    return primary !== 0 ? primary : a.domain.localeCompare(b.domain);
  });
}
