/**
 * Лестница жизненного цикла домена — один список на весь фронт.
 *
 * Заведён по той же причине, что `lib/serverStatus.ts`, и с уже случившимся
 * ущербом: список статусов был переписан на фронте ДВАЖДЫ (карта бейджа в
 * `components/domains/DomainStatusBadge` и пункты фильтра вкладки), и обе копии
 * разошлись с бэкендом одинаково — в них не было `ns_ok`
 * (`DomainStatus`, `backend/app/core/constants.py`). Домен в этом статусе
 * нельзя было отфильтровать, а бейдж ему доставался серый — тот самый, которым
 * рисуется «статус незнакомый». То есть штатное состояние продукта выглядело
 * как сбой, и заметить это можно было только глазами.
 *
 * Порядок массива — не косметика: это порядок ПРОХОЖДЕНИЯ статусов, и по нему
 * же сортируется колонка Status (см. `domainStatusRank`). Он совпадает с
 * порядком `DomainStatus` на бэкенде намеренно — второй порядок тех же значений
 * был бы третьей копией знания.
 *
 * Подпись и подсказка бейджа хранятся ЗДЕСЬ ЖЕ, в тех же записях.
 *
 * Раньше подписью служил `status.toUpperCase()`, и довод был «отдельная запись
 * — ещё одно место, которое можно забыть обновить». Довод оказался дешевле
 * ущерба: колонка печатала `NS_PENDING`, `SITE_CREATED`, `SSL_PENDING` —
 * внутренние имена бэкенда, — и объяснить себя ей было нечем. Хуже того, она
 * называет НЕ здоровье сайта, а ступень настройки внутри SDMP: `ACTIVE` стоит
 * только у доменов, прошедших provision из приложения, а заведённые вручную
 * остаются `NEW` навсегда, сколько бы лет их сайт ни работал. Человек читал это
 * как «домен сломан».
 *
 * Забыть теперь нельзя по построению: `label` и `hint` — обязательные поля
 * формы, которую проверяет `satisfies`, и статус без них не соберётся.
 */

/** Вариант `Badge` для статуса. Строки те же, что понимает `ui/Primitives`. */
type BadgeVariant = "gray" | "blue" | "green" | "yellow" | "red";

/**
 * Статусы в порядке прохождения.
 *
 * Цвета: жёлтый — «ждём чужого действия» (делегирование NS, выпуск
 * сертификата), синий — «работа идёт у нас», зелёный — только `active`, красный
 * — только `failed`.
 *
 * `ns_ok` — синий, а не зелёный, и это выбор, а не осторожность: зелёный на
 * этой лестнице значит «дошли до конца», и второй зелёный бейдж посреди пути
 * заставлял бы читателя различать два зелёных вместо того, чтобы искать глазами
 * один. NS проставлены — это пройденная ступень, а не готовый домен: сайта на
 * сервере ещё нет.
 */
export const DOMAIN_STATUSES = [
  {
    status: "new",
    variant: "gray",
    label: "Not set up",
    hint: "Added to SDMP; nothing has been deployed from here yet",
  },
  {
    status: "ns_pending",
    variant: "yellow",
    label: "Waiting NS",
    hint: "Nameservers were sent to the registrar; delegation has not been confirmed",
  },
  {
    status: "ns_ok",
    variant: "blue",
    label: "NS set",
    hint: "Nameservers are in place; the site has not been created yet",
  },
  {
    status: "provisioning",
    variant: "blue",
    label: "Deploying",
    hint: "A deployment run is in progress on the server",
  },
  {
    status: "site_created",
    variant: "blue",
    label: "Site created",
    hint: "The site exists on the server; the certificate has not been issued",
  },
  {
    status: "ssl_pending",
    variant: "yellow",
    label: "Issuing SSL",
    hint: "Waiting for the certificate authority to issue the certificate",
  },
  {
    status: "active",
    variant: "green",
    label: "Deployed",
    hint: "Deployed from SDMP end to end. Says nothing about whether the site is up right now",
  },
  {
    status: "failed",
    variant: "red",
    label: "Failed",
    hint: "The last deployment run stopped with an error",
  },
] as const satisfies ReadonlyArray<{ status: string; variant: BadgeVariant; label: string; hint: string }>;

/**
 * Имя статуса, ИЗВЕСТНОГО лестнице, — выведено из неё же, а не переписано
 * рядом union'ом из восьми строк.
 *
 * Заведено ради тех, кто перечисляет статусы поимённо: чипы вкладки Domains
 * называют три из восьми (`new`, `active`, `failed`), и до типа опечатка в
 * таком перечислении компилировалась молча — чип «Active» с фильтром `"actve"`
 * просто не находил ничего. Теперь имя, которого в лестнице нет, роняет сборку.
 *
 * `as const satisfies …` вместо прежней аннотации: аннотация расширяла `status`
 * до `string` прямо в момент объявления, и литеральные имена терялись, не
 * дойдя ни до одного потребителя. `satisfies` сохраняет их и при этом
 * продолжает проверять форму — чужой `variant` по-прежнему не пройдёт.
 */
export type DomainStatusName = (typeof DOMAIN_STATUSES)[number]["status"];

/**
 * Подпись статуса — человеческая, из лестницы.
 *
 * Незнакомый статус (включая пустой) — «Unknown», а не сам статус заглавными:
 * бэкенд волен добавить ступень в любой день, и печатать её сырое имя значило
 * бы показать пользователю строку из чужого кода. Пустое место читалось бы как
 * «статуса нет», а не «статус нам неизвестен».
 */
export function domainStatusLabel(status: string): string {
  return DOMAIN_STATUSES.find((s) => s.status === status)?.label ?? "Unknown";
}

/**
 * Чем колонка объясняет себя под курсором.
 *
 * Отдельной функцией, а не полем в `domainStatusLabel`: подпись рисуют двое
 * (строка списка и шапка карточки), а подсказку — только они же, и оба обязаны
 * взять её отсюда. Незнакомый статус объясняет себя честно — тем, что мы его не
 * знаем; выдумывать ступень нельзя даже в подсказке.
 */
export function domainStatusHint(status: string): string {
  return (
    DOMAIN_STATUSES.find((s) => s.status === status)?.hint ??
    `Status "${status || "(empty)"}" is not one this app knows`
  );
}

/**
 * Цвет бейджа. Незнакомый статус — серый: это «мы такого не знаем», и гадать в
 * сторону зелёного нельзя (то же правило, что у серверов).
 */
export function domainStatusVariant(status: string): BadgeVariant {
  return DOMAIN_STATUSES.find((s) => s.status === status)?.variant ?? "gray";
}

/**
 * Место статуса в лестнице — ключ сортировки колонки Status. `null` — статуса в
 * лестнице нет, то есть про его место мы НЕ ЗНАЕМ.
 *
 * По алфавиту сортировать нечего: «active, failed, new, ns_ok…» — это порядок
 * букв, а не жизни домена, и ответа на вопрос «что ещё не доделано» он не даёт.
 * По лестнице же возрастание собирает недоделанное сверху, а убывание — ставит
 * первым `failed` (он последний в лестнице), то есть ровно то, что человек ищет
 * вторым кликом по заголовку.
 *
 * Незнакомый статус отдаёт `null`, а не «за концом лестницы» числом: число
 * переворачивается вместе с направлением, и второй клик — тот самый, который
 * должен поднять `failed`, — вместо этого поднял бы наверх статус, только что
 * добавленный на бэкенде и фронту ещё неизвестный. Правило то же, что у дат без
 * значения (`sortDomains`): незнание уходит в конец при ЛЮБОМ направлении, и
 * применяется оно там же, одной веткой на оба случая.
 */
export function domainStatusRank(status: string): number | null {
  const i = DOMAIN_STATUSES.findIndex((s) => s.status === status);
  return i === -1 ? null : i;
}
