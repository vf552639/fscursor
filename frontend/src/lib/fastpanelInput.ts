/**
 * Проверки полей «Connect Existing Fastpanel» перед отправкой на сервер.
 *
 * Третья копия одного правила, и это осознанно: десктоп чистит разобранный
 * вывод инсталлятора (`provision/fastpanel_install.rs`), схема на бэкенде
 * отвергает присланное (`backend/app/core/validators.py`), а здесь то же самое
 * говорится человеку до отправки. Без этой копии опечатка в форме («забыл
 * `https://`», «забыл `:8888`», «скопировал URL с логином и паролем») даёт
 * 422, а `apiRequest` в `api/client.ts` кладёт в форму `String(data.detail)` —
 * для 422 это массив объектов, то есть `[object Object]` в красной строке.
 *
 * Полноценным URL-парсером не притворяются: проверяются ровно три вещи —
 * схема `http(s)`, отсутствие userinfo, форма «хост:порт». Возвращают текст
 * ошибки или `null`, если поле в порядке.
 */

const SCHEMES = ["https://", "http://"];
// Хост (буквы/цифры/`.`/`-`/`_`) и обязательный порт. Символ в символ с
// `_HOST_PORT_RE` на бэкенде и `host_port_regex()` в десктопе.
const HOST_PORT = /^[A-Za-z0-9._-]+:[0-9]{1,5}$/;

export function fastpanelUrlError(value: string): string | null {
  // Проверяется обрезанное значение, и ровно оно же уезжает на сервер (см.
  // `handleAdd` в `pages/Servers.tsx`): иначе форма зеленела бы там, где
  // сервер откажет из-за пробела по краям.
  const url = value.trim();
  if (!url) return "FastPanel URL is required";

  const scheme = SCHEMES.find((s) => url.startsWith(s));
  if (!scheme) return "URL must start with https:// or http://";

  // Authority кончается на первом `/`, `?` или `#`; `@` дальше — это путь, а
  // не userinfo.
  const authority = url.slice(scheme.length).split(/[/?#]/)[0];
  if (authority.includes("@")) {
    return "Remove the credentials before @ — the panel password must not be stored in the URL";
  }
  if (!HOST_PORT.test(authority)) {
    return "URL must be host and port, e.g. https://192.168.1.100:8888";
  }
  return null;
}

export function fastpanelUserError(value: string): string | null {
  if (!value.trim()) return "Login is required";
  // Пробел внутри логина сервер отвергает: разбор на десктопе ловит `(\S+)`, и
  // серверное правило повторяет его один в один.
  if (/\s/.test(value)) return "Login must not contain spaces";
  return null;
}
