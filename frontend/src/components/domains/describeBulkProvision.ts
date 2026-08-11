import { DomainUI } from "./types";

/** Сколько имён влезает в диалог подтверждения, не превращая его в стену текста. */
const CONFIRM_NAMES_SHOWN = 20;

/**
 * Текст подтверждения массового provision.
 *
 * Отдельная чистая функция, а не шаблон внутри обработчика: её проверяет тест, а
 * этот текст — единственное, что стоит между промахом мимо соседней кнопки и
 * часами необратимой работы на чужих машинах.
 *
 * Устроен как `describeDeepLinkAction` для той же операции (`lib/deepLink.ts`):
 * называет и действие, и цели. Цели названы ИМЕНАМИ, а не id: у ссылки имён нет,
 * а у страницы есть, и выбирал пользователь именно имена. Строки «Continue only
 * if you started this yourself» здесь нет намеренно — она про ссылку, пришедшую
 * с чужой страницы, а не про кнопку, которую только что нажали.
 */
export function describeBulkProvision(domains: DomainUI[], ids: number[]): string {
  const names = ids.map((id) => domains.find((d) => d.id === id)?.domain ?? `#${id}`);
  const rest = names.length - CONFIRM_NAMES_SHOWN;
  const list = names.slice(0, CONFIRM_NAMES_SHOWN).join(", ") + (rest > 0 ? `, … (+${rest} more)` : "");
  return (
    `Provision ${ids.length} domain(s)?\n\n` +
    `${list}\n\n` +
    "SDMP will connect over SSH to each domain's server and create the site, " +
    "its FTP account and its SSL certificate. Once started, the run cannot be stopped."
  );
}
