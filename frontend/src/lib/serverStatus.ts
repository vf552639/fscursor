/**
 * Что мы на самом деле знаем про сервер — и насколько это знание свежее.
 *
 * Живёт отдельным модулем, потому что читают его ТРИ экрана (дашборд, список
 * серверов, деталь сервера), и раньше лестница статусов была переписана на
 * каждом из них заново. Расхождение было не теоретическим: на дашборде
 * `status === "active" ? "healthy"` не смотрел на результат проверки вовсе, и
 * подтверждённо упавший сервер светился там зелёным на первом же экране.
 *
 * Правило одно на всех: **незнание нельзя рисовать как здоровье.** Отсюда все
 * решения ниже.
 */

/** Свежесть проверки/снимка «сейчас», подменяемая в тестах. */
type Now = number;

/**
 * Статус «мы не знаем, отвечает ли машина». Отдельное слово, а не отсутствие
 * бейджа: пустое место читается как «показывать нечего, значит всё хорошо», то
 * есть ровно наоборот.
 */
export const UNCHECKED = "unchecked";

/** Значения, которыми экраны рисуют состояние сервера. */
export type ServerUiStatus = "error" | "active" | typeof UNCHECKED | "provisioned" | "new";

/** Поля сущности, из которых состояние выводится. */
export interface ServerStatusInput {
  status?: string | null;
  last_check_at?: string | null;
  last_check_ok?: boolean | null;
}

/**
 * Порог, после которого проверка доступности считается протухшей.
 *
 * Проверка идёт раз в 6 часов, поэтому порог обязан быть заметно больше шага:
 * иначе статус мигал бы между прогонами при любой задержке очереди. 18 часов —
 * это ТРИ пропущенных прогона подряд: одиночный пропуск (перезапуск воркера,
 * деплой, забитая очередь) в «не знаем» не проваливается, а три подряд — это
 * уже не икота, а умерший beat, и зелёный бейдж после него держится на
 * позавчерашнем ответе.
 */
const CHECK_STALE_MS = 18 * 60 * 60 * 1000;

/**
 * Порог «метрики протухли». Сутки — потому что снимает их десктоп по кнопке, а
 * не расписание: сутки без открытого десктопа — обычный рабочий цикл, а
 * позавчерашнее показание описывает уже другую машину.
 */
const METRICS_STALE_MS = 24 * 60 * 60 * 1000;

/** Старше порога ли отметка. `null` («ничего не было») — это не «протухло». */
function olderThan(iso: string | null | undefined, maxAgeMs: number, now: Now): boolean {
  if (!iso) return false;
  const ts = new Date(iso).getTime();
  return !Number.isNaN(ts) && now - ts > maxAgeMs;
}

/** Протухли ли метрики этого снимка (см. `METRICS_STALE_MS`). */
export function isMetricsStale(iso: string | null | undefined, now: Now = Date.now()): boolean {
  return olderThan(iso, METRICS_STALE_MS, now);
}

/** Протухла ли проверка доступности (см. `CHECK_STALE_MS`). */
export function isCheckStale(iso: string | null | undefined, now: Now = Date.now()): boolean {
  return olderThan(iso, CHECK_STALE_MS, now);
}

/**
 * Состояние сервера так, как его честно можно назвать.
 *
 * Ключевое: `servers.status` — это поле, выставленное при заведении сервера
 * (бэкенд пишет туда `new` и `active`), и об ответе машины оно не говорит
 * ничего. Отвечает ли она, знает только фоновая проверка порта, поэтому
 * «active» требует ПОЛОЖИТЕЛЬНОГО и СВЕЖЕГО ответа: без проверки, с
 * неподтверждённым результатом или с протухшей отметкой это `unchecked`.
 *
 * Подтверждённое падение при этом протухшим не объявляется: `error` на старой
 * отметке — это «была проблема, свежих данных нет», и оно не усыпляет. Обратная
 * ошибка (нарисовать зелёным то, чего не знаем) стоит дороже, поэтому лестница
 * несимметрична намеренно.
 */
export function serverUiStatus(s: ServerStatusInput, now: Now = Date.now()): ServerUiStatus {
  if (s.last_check_ok === false || s.status === "error") return "error";
  if (s.status === "provisioned") return "provisioned";
  if (s.status !== "active") return "new";
  if (s.last_check_ok !== true || !s.last_check_at || isCheckStale(s.last_check_at, now)) {
    return UNCHECKED;
  }
  return "active";
}

/**
 * Цвет бейджа статуса. Зелёный в этом UI занят под «машина ответила», и больше
 * ни под что: `provisioned` — про этап жизненного цикла, а не про здоровье, и
 * зелёным он вводил бы в заблуждение ровно как `unchecked` (заодно у `StatusDot`
 * ключа `provisioned` нет, так что зелёный бейдж стоял бы рядом с серой точкой).
 */
export function statusBadgeVariant(status: ServerUiStatus | string): string {
  if (status === "error") return "red";
  if (status === "active") return "green";
  return "gray";
}
