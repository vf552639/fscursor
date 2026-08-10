/**
 * Короткое имя ОС сервера: приведение любой строки (ручной выбор в форме или
 * автоопределение по SSH) к одному из пяти канонических имён семейства, без
 * версии и архитектуры.
 *
 * У сервера два источника этого поля с разной природой:
 *   - `os` — то, что пользователь выбрал руками в «Add Server»;
 *   - `os_pretty` — то, что десктоп сам вычитал из `/etc/os-release` по SSH.
 * Показывать их полагается с приоритетом `osShortName(os) || osShortName(os_pretty)`,
 * а не наоборот: ручной выбор — это решение пользователя, автоопределение —
 * только догадка десктопа (может не совпасть с тем, что сервер отдал по факту,
 * или вовсе не собраться, если SSH недоступен). Решение перекрывает догадку,
 * а не наоборот.
 */

/**
 * Только имя семейства ОС, без версии и архитектуры: десктоп по этому имени
 * выбирает пакетный менеджер для установки FastPanel (`apt` или `yum`),
 * версия ему не нужна.
 *
 * Новое имя из RHEL-семейства обязано попадать под подстроки
 * `cent|rhel|rocky|alma|fedora` из
 * `desktop/src-tauri/src/provision/fastpanel_install.rs::update_command` —
 * иначе оно молча получит apt (там `else`, а не whitelist). Debian-подобные
 * (Debian, Ubuntu) под эти подстроки не попадают нарочно — apt для них и
 * есть правильный ответ.
 */
export const OS_OPTIONS = ["Debian", "Ubuntu", "CentOS", "AlmaLinux", "Rocky Linux"] as const;

/**
 * Подстрока → каноничное имя из `OS_OPTIONS`. Список нарочно совпадает с
 * `OS_OPTIONS` один в один (не производится из него автоматически): поиск
 * подстроки для "CentOS" — это "centos", а не то же самое, что нижний регистр
 * "Rocky Linux" целиком ("rocky linux") — искать нужно короче, "rocky",
 * потому что PRETTY_NAME по разным дистрибутивам семейства пишет то
 * "Rocky Linux release 9.3", то "Rocky Linux 9.3 (Blue Onyx)".
 */
const FAMILY_NEEDLES: ReadonlyArray<readonly [string, (typeof OS_OPTIONS)[number]]> = [
  ["ubuntu", "Ubuntu"],
  ["debian", "Debian"],
  ["centos", "CentOS"],
  ["almalinux", "AlmaLinux"],
  ["rocky", "Rocky Linux"],
];

/**
 * Приводит произвольную строку ОС (ручной выбор из формы или
 * автоопределённый `PRETTY_NAME` вида «Ubuntu 20.04.6 LTS») к каноничному
 * короткому имени семейства из `OS_OPTIONS`.
 *
 * Принимает `null`/`undefined` напрямую — вызывающий код читает поля вида
 * `s.os_pretty`, которые в API всегда `string | null`, но в паре мест по пути
 * успевают стать `undefined` (например, до первой загрузки сервера), и
 * заставлять каждый вызов приводить тип было бы лишним трением.
 */
export function osShortName(label: string | null | undefined): string | null {
  if (!label) return null;
  const trimmed = label.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  for (const [needle, canonical] of FAMILY_NEEDLES) {
    if (lower.includes(needle)) return canonical;
  }

  // Ничего из пяти известных семейств не нашлось — строка либо из старой формы
  // (там значений было больше пяти), либо это ОС, для которой у нас нет
  // отдельного пункта (Fedora, openSUSE...). Версия почти всегда начинается
  // с цифры сразу после имени («Fedora Linux 39», «openSUSE 15.5») — обрезаем
  // по ней и берём первое слово, а не всю голову целиком: иначе «Fedora Linux»
  // остался бы с лишним «Linux», которого нет у остальных пяти имён.
  const beforeVersion = trimmed.split(/\d/, 1)[0].trim();
  const firstWord = beforeVersion.split(/\s+/)[0] ?? "";
  // Пустая строка сюда попадает, когда цифра стоит в самом начале ("39") —
  // возвращаем null, а не "", потому что пустая строка в JSX рисуется как
  // пустое место, а вызывающий код проверяет именно null, чтобы показать «—».
  return firstWord || null;
}
