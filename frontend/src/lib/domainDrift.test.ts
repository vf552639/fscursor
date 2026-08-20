import { describe, it, expect } from "vitest";

import {
  anyRecordedOnly,
  dbNameSource,
  dbUserSource,
  ftpLoginSource,
  phpVersionSource,
  siteOwnerSource,
  sitePathSource,
  sslExpiresSource,
  sslIssuerSource,
} from "./domainDrift";
import { type DomainFacts } from "./domainFacts";

/**
 * Правило расхождения — чистая логика, и проверяется она отдельно от карточки,
 * ровно как `domainFacts`: вопрос «расходится ли наша запись с сервером» решает
 * продукт, а не вёрстка одного экрана.
 *
 * Половина тестов здесь — про НОРМАЛИЗАЦИЮ, и это не педантизм: наивное
 * сравнение строк объявляло бы расхождение там, где его нет (`8.1` против `81`
 * у PHP — на КАЖДОМ домене), а ложная плашка «при развёртывании: …» на каждой
 * карточке ровно так же обесценивает себя, как ложный красный бейдж.
 */

/** ISO из ЛОКАЛЬНЫХ компонентов: календарный день теста не зависит от зоны CI. */
const local = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

/** Снимок с сервера: по умолчанию всё совпадает с записью provision ниже. */
function facts(over: Partial<DomainFacts> = {}): DomainFacts {
  return {
    site: {
      domain_name: "example.com",
      site_user: "example_usr",
      site_path: "/var/www/example_usr/data/www/example.com",
      php_version: "81",
    },
    ssl: {
      has_certificate: true,
      expires_at: local(2026, 11, 1, 9),
      issuer: "Let's Encrypt",
      is_letsencrypt: true,
    },
    ftp_accounts: [{ login: "example_ftp", home: "/var/www/example_usr" }],
    php_version: "81",
    php_handler: "php-fpm",
    databases: ["example_db"],
    logs: [],
    ...over,
  };
}

describe("общие правила на все поля", () => {
  it("наша запись пуста → дорисовывать нечего (agree), а не «recorded-only» с прочерком", () => {
    // Строка «при развёртывании: —» не сообщает ничего: пустая колонка домена
    // значит «мы не записали», а не «мы записали пустоту».
    expect(ftpLoginSource(null, facts())).toEqual({ kind: "agree" });
    expect(ftpLoginSource(undefined, facts())).toEqual({ kind: "agree" });
    expect(ftpLoginSource("", facts())).toEqual({ kind: "agree" });
    expect(ftpLoginSource("   ", facts())).toEqual({ kind: "agree" });
    // И то же самое, когда факта тоже нет: показывать нечего с обеих сторон.
    expect(ftpLoginSource("", null)).toEqual({ kind: "agree" });
  });

  it("снимка нет вовсе → recorded-only", () => {
    expect(ftpLoginSource("example_ftp", null)).toEqual({
      kind: "recorded-only",
      recorded: "example_ftp",
    });
    expect(ftpLoginSource("example_ftp", undefined)).toEqual({
      kind: "recorded-only",
      recorded: "example_ftp",
    });
  });

  it("снимок есть, но поле в нём пустое → recorded-only, а не расхождение", () => {
    // Пустое поле снимка — не измерение «там ничего нет», а «мы это не
    // прочитали»: провод (`ssh/fastpanel_facts.rs`) схлопывает в пустоту и
    // «правда пусто», и «команда упала». Объявлять расхождение против незнания
    // нельзя (принцип №6).
    expect(ftpLoginSource("example_ftp", facts({ ftp_accounts: [] }))).toEqual({
      kind: "recorded-only",
      recorded: "example_ftp",
    });
    expect(siteOwnerSource("example_usr", facts({ site: null }))).toEqual({
      kind: "recorded-only",
      recorded: "example_usr",
    });
  });

  it("в `recorded` уходит ЧИТАЕМОЕ значение (только с обрезанными пробелами)", () => {
    // Нормализация — дело сравнения, а не показа: человеку надо увидеть ровно
    // то, что записал provision.
    expect(sitePathSource("  /var/www/other/  ", facts())).toEqual({
      kind: "drift",
      recorded: "/var/www/other/",
    });
  });
});

describe("ftpLoginSource — trim, регистр учитываем", () => {
  it("совпало с точностью до пробелов → agree", () => {
    expect(ftpLoginSource("  example_ftp ", facts())).toEqual({ kind: "agree" });
  });

  it("другой логин → drift", () => {
    expect(ftpLoginSource("other_ftp", facts())).toEqual({ kind: "drift", recorded: "other_ftp" });
  });

  it("регистр значим: логин FTP на linux — не то же слово в верхнем регистре", () => {
    expect(ftpLoginSource("EXAMPLE_FTP", facts())).toEqual({
      kind: "drift",
      recorded: "EXAMPLE_FTP",
    });
  });

  it("наш логин где-то в списке → agree: «первый» у CLI не значит «основной»", () => {
    // Список уже отфильтрован по `home_dir` этого домена, а порядок — просто
    // порядок вывода CLI. Сравнение с `[0]` объявляло бы расхождение всякий
    // раз, когда рядом с нашим логином завели второй аккаунт.
    const f = facts({
      ftp_accounts: [
        { login: "first_ftp", home: null },
        { login: "example_ftp", home: null },
      ],
    });
    expect(ftpLoginSource("example_ftp", f)).toEqual({ kind: "agree" });
  });

  it("нашего логина в списке нет → drift (аккаунт подменили, старый удалён)", () => {
    const f = facts({ ftp_accounts: [{ login: "first_ftp", home: null }] });
    expect(ftpLoginSource("example_ftp", f)).toEqual({ kind: "drift", recorded: "example_ftp" });
  });
});

describe("sitePathSource — хвостовой слэш не в счёт", () => {
  it("путь со слэшем на конце совпадает с тем же путём без него", () => {
    expect(sitePathSource("/var/www/example_usr/data/www/example.com/", facts())).toEqual({
      kind: "agree",
    });
  });

  it("несколько хвостовых слэшей — тоже не расхождение", () => {
    expect(sitePathSource("/var/www/example_usr/data/www/example.com///", facts())).toEqual({
      kind: "agree",
    });
  });

  it("корень остаётся корнем: `/` не схлопывается в пустоту", () => {
    const f = facts({ site: { domain_name: "example.com", site_user: null, site_path: "/", php_version: null } });
    expect(sitePathSource("/", f)).toEqual({ kind: "agree" });
    expect(sitePathSource("/var/www", f)).toEqual({ kind: "drift", recorded: "/var/www" });
  });

  it("другой путь → drift", () => {
    expect(sitePathSource("/var/www/example_usr/data/www/old.example.com", facts())).toEqual({
      kind: "drift",
      recorded: "/var/www/example_usr/data/www/old.example.com",
    });
  });
});

describe("siteOwnerSource — trim", () => {
  it("совпало → agree", () => {
    expect(siteOwnerSource(" example_usr", facts())).toEqual({ kind: "agree" });
  });

  it("другой владелец → drift", () => {
    expect(siteOwnerSource("www-data", facts())).toEqual({ kind: "drift", recorded: "www-data" });
  });
});

describe("phpVersionSource — по двум первым числам версии", () => {
  it("`8.1` (наша запись) и `81` (FastPanel) — одна и та же версия", () => {
    // Ловушка, ради которой правило и написано: наивное сравнение строк дало бы
    // расхождение на каждом домене, потому что стороны пишут версию по-разному.
    expect(phpVersionSource("8.1", facts())).toEqual({ kind: "agree" });
    expect(phpVersionSource("php8.1", facts())).toEqual({ kind: "agree" });
    expect(phpVersionSource(" 8.1 ", facts())).toEqual({ kind: "agree" });
  });

  it("другая версия → drift, и показываем её в человеческом виде", () => {
    expect(phpVersionSource("7.4", facts())).toEqual({ kind: "drift", recorded: "7.4" });
  });

  it("patch-компонент не расхождение: `8.1` ≡ `8.1.33`", () => {
    // `coerce_php_version` (`ssh/fastpanel.rs`) допускает три компонента, а
    // склейка всех цифр дала бы `81` ≠ `8133` — ложное расхождение на каждом
    // сервере, который отдаёт версию полностью. Продукт переключает major.minor.
    expect(phpVersionSource("8.1", facts({ php_version: "8.1.33" }))).toEqual({ kind: "agree" });
    expect(phpVersionSource("8.1", facts({ php_version: "8.2.5" }))).toEqual({
      kind: "drift",
      recorded: "8.1",
    });
  });

  it("версия снимка берётся из `site`, если верхнего поля нет или оно пустое", () => {
    const f = facts({ php_version: null });
    expect(phpVersionSource("8.1", f)).toEqual({ kind: "agree" });
    expect(phpVersionSource("7.4", f)).toEqual({ kind: "drift", recorded: "7.4" });
    // Пустая строка тоже не заслоняет `site`: заслонив, она превратила бы
    // прочитанную версию в «не проверено».
    expect(phpVersionSource("8.1", facts({ php_version: "  " }))).toEqual({ kind: "agree" });
  });

  it("версии нет ни там, ни там → recorded-only", () => {
    const f = facts({
      php_version: null,
      site: { domain_name: "example.com", site_user: "example_usr", site_path: "/x", php_version: null },
    });
    expect(phpVersionSource("8.1", f)).toEqual({ kind: "recorded-only", recorded: "8.1" });
  });
});

describe("sslExpiresSource — по календарной дате", () => {
  it("тот же день, другое время → agree (секунды — не расхождение)", () => {
    expect(sslExpiresSource(local(2026, 11, 1, 23, 30), facts())).toEqual({ kind: "agree" });
  });

  it("соседний день → drift", () => {
    expect(sslExpiresSource(local(2026, 11, 2, 9), facts())).toEqual({
      kind: "drift",
      recorded: local(2026, 11, 2, 9),
    });
  });

  it("сертификата в снимке нет (срок null) → recorded-only", () => {
    const f = facts({
      ssl: { has_certificate: false, expires_at: null, issuer: null, is_letsencrypt: false },
    });
    expect(sslExpiresSource(local(2026, 11, 1, 9), f)).toEqual({
      kind: "recorded-only",
      recorded: local(2026, 11, 1, 9),
    });
  });

  it("нечитаемая дата не выдаётся за совпадение", () => {
    expect(sslExpiresSource("not-a-date", facts())).toEqual({
      kind: "drift",
      recorded: "not-a-date",
    });
  });

  it("две одинаковые нечитаемые строки — не расхождение", () => {
    const f = facts({
      ssl: { has_certificate: true, expires_at: "not-a-date", issuer: null, is_letsencrypt: false },
    });
    expect(sslExpiresSource("not-a-date", f)).toEqual({ kind: "agree" });
  });
});

describe("sslIssuerSource — trim", () => {
  it("совпало → agree", () => {
    expect(sslIssuerSource("Let's Encrypt ", facts())).toEqual({ kind: "agree" });
  });

  it("другой издатель → drift", () => {
    expect(sslIssuerSource("ZeroSSL", facts())).toEqual({ kind: "drift", recorded: "ZeroSSL" });
  });
});

describe("dbNameSource — ищем имя в списке баз", () => {
  it("имя есть в списке → agree, даже если оно там не первое", () => {
    expect(dbNameSource("example_db", facts({ databases: ["other_db", "example_db"] }))).toEqual({
      kind: "agree",
    });
  });

  it("имени в списке нет → drift", () => {
    expect(dbNameSource("example_db", facts({ databases: ["other_db"] }))).toEqual({
      kind: "drift",
      recorded: "example_db",
    });
  });

  it("список пуст → recorded-only, а не drift: пустота в проводе не значит «баз нет»", () => {
    // `list_site_databases` (`ssh/fastpanel_facts.rs`) отдаёт `[]` и когда баз
    // правда нет, и когда обе команды упали, и когда сработал слабый
    // mysql-фолбэк по префиксу, который «скорее всего не поймает ничего» (его
    // же комментарий). Читая такую пустоту как измерение, мы подписывали бы
    // «при развёртывании: X» КАЖДОМУ домену сервера, где список не прочитался.
    expect(dbNameSource("example_db", facts({ databases: [] }))).toEqual({
      kind: "recorded-only",
      recorded: "example_db",
    });
  });

  it("снимка нет → recorded-only", () => {
    expect(dbNameSource("example_db", null)).toEqual({
      kind: "recorded-only",
      recorded: "example_db",
    });
  });

  it("регистр значим: имена баз в MySQL под linux регистрозависимы", () => {
    expect(dbNameSource("EXAMPLE_DB", facts())).toEqual({ kind: "drift", recorded: "EXAMPLE_DB" });
  });
});

describe("dbUserSource — сверять не с чем", () => {
  it("всегда recorded-only: снимка эта функция не принимает вовсе", () => {
    // `facts.databases` — только ИМЕНА баз; пользователей CLI не отдаёт вовсе,
    // поэтому «совпало» тут не может быть правдой ни при каком снимке — и факт
    // в сигнатуру не приходит, чтобы это было видно по одному вызову.
    expect(dbUserSource("example_usr")).toEqual({ kind: "recorded-only", recorded: "example_usr" });
    expect(dbUserSource("  example_usr  ")).toEqual({ kind: "recorded-only", recorded: "example_usr" });
  });

  it("пусто — по-прежнему нечего дорисовывать", () => {
    expect(dbUserSource(null)).toEqual({ kind: "agree" });
  });
});

/**
 * Вопрос вкладки Server, а не поля: «есть ли на экране хоть одно приглушённое
 * значение». По нему печатается фраза легенды, которая эти значения объясняет,
 * — а объяснять нечего у домена, только что переехавшего на другой сервер:
 * бэкенд гасит при переезде и снимок, и все колонки provision разом.
 */
describe("anyRecordedOnly — печатать ли фразу про приглушённые значения", () => {
  const empty = {};

  it("ни снимка, ни записей — приглушать нечего", () => {
    expect(anyRecordedOnly(empty, null)).toBe(false);
    expect(anyRecordedOnly({ ftp_user: "", site_path: "   " }, null)).toBe(false);
  });

  it("любая одна колонка provision без снимка — уже есть что объяснять", () => {
    expect(anyRecordedOnly({ ftp_user: "example_ftp" }, null)).toBe(true);
    expect(anyRecordedOnly({ site_path: "/var/www/example.com" }, null)).toBe(true);
    expect(anyRecordedOnly({ site_user: "example_usr" }, null)).toBe(true);
    expect(anyRecordedOnly({ php_version: "8.1" }, null)).toBe(true);
    expect(anyRecordedOnly({ db_name: "example_db" }, null)).toBe(true);
    // Пользователь базы — `recorded-only` всегда: сверять его не с чем.
    expect(anyRecordedOnly({ db_user: "example_dbu" }, null)).toBe(true);
  });

  /**
   * Под снимком совпавшее значение рисуется как ФАКТ, а не как наша запись, —
   * приглушённого на экране нет, и фраза не нужна. Проверяется тем же снимком,
   * которым живёт остальной файл.
   */
  it("под снимком совпавшая запись приглушённой не считается", () => {
    const f = facts();
    expect(
      anyRecordedOnly(
        {
          ftp_user: "example_ftp",
          site_path: "/var/www/example_usr/data/www/example.com",
          site_user: "example_usr",
          php_version: "8.1",
          db_name: "example_db",
        },
        f,
      ),
    ).toBe(false);
  });

  it("под снимком расхождение — тоже не приглушённое: значением остаётся факт", () => {
    expect(anyRecordedOnly({ site_user: "other_usr" }, facts())).toBe(false);
  });

  /** Запись есть, а факта по ней снимок не принёс — вот это и есть приглушённое. */
  it("под снимком без этого поля запись остаётся приглушённой", () => {
    expect(anyRecordedOnly({ db_name: "example_db" }, facts({ databases: [] }))).toBe(true);
  });
});
