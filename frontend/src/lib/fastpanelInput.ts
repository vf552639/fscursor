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
 * Полноценным URL-парсером не притворяются: проверяются ровно четыре вещи —
 * схема `http(s)`, отсутствие `@`, форма «хост:порт» и отсутствие управляющих
 * символов. Возвращают текст ошибки или `null`, если поле в порядке.
 *
 * ⚠️ Известное ограничение: IPv6 в URL не принимается. Адресом СЕРВЕРА он быть
 * может (`lib/ipInput`, `ipError(…, {ipv6: true})`), а адресом панели — пока
 * нет: `HOST_PORT` ниже не знает про скобки («https://[2a01:4f8::1]:8888»), и
 * то же самое верно для обеих парных проверок — `_HOST_PORT_RE`
 * (`backend/app/core/validators.py`) и `host_port_regex()` в десктопе. Чинить
 * это надо втроём и одновременно, иначе форма примет то, что отвергнет сервер;
 * до тех пор форма подключения панели у IPv6-сервера открывается с пустым полем
 * (`openConnectModal` в `pages/ServerDetail.tsx`), а не с заведомо невалидным
 * значением.
 */

const SCHEMES = ["https://", "http://"];
// C0 плюс DEL — парно к `_CONTROL_CHARS_RE` на бэкенде. Вставка из терминала
// приносит их вместе с ANSI-раскраской, и без этой проверки поле зеленело бы
// здесь, чтобы получить 422 на сервере.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
// Хост (буквы/цифры/`.`/`-`/`_`) и обязательный порт — та же форма, что у
// `_HOST_PORT_RE` на бэкенде и `host_port_regex()` в десктопе. Не «символ в
// символ»: на бэкенде конец строки записан как `\Z`, потому что питоновский
// `$` матчит ещё и позицию перед завершающим `\n`; в JS и Rust `$` так себя
// не ведёт, и здесь он означает ровно то же, что там `\Z`.
const HOST_PORT = /^[A-Za-z0-9._-]+:[0-9]{1,5}$/;

export function fastpanelUrlError(value: string): string | null {
  // Проверяется обрезанное значение, и ровно оно же уезжает на сервер (см.
  // `handleSaveConnect` в `pages/ServerDetail.tsx`): иначе форма зеленела бы
  // там, где сервер откажет из-за пробела по краям.
  const url = value.trim();
  if (!url) return "FastPanel URL is required";
  if (CONTROL_CHARS.test(url)) return "URL must not contain control characters";

  // `@` где угодно в значении, а не «userinfo по букве RFC»: в
  // `https://admin:12/345@1.2.3.4:8888` пароль содержит `/`, поэтому authority
  // кончается на нём и равна `admin:12` — идеальному «хост:порт», — а логин с
  // паролем проезжают как путь. Цена — `@` в пути тоже отказ; панельного
  // адреса с `@` в пути не существует.
  if (url.includes("@")) {
    return "Remove the credentials before @ — the panel password must not be stored in the URL";
  }

  const scheme = SCHEMES.find((s) => url.startsWith(s));
  if (!scheme) return "URL must start with https:// or http://";

  // Authority кончается на первом `/`, `?` или `#`; дальше путь и запрос.
  const authority = url.slice(scheme.length).split(/[/?#]/)[0];
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
  if (CONTROL_CHARS.test(value)) return "Login must not contain control characters";
  return null;
}
