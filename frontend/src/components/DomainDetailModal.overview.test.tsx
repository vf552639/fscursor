import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainDetailModal from "./DomainDetailModal";
import { queryClient } from "../api/queryClient";

/**
 * Верх карточки домена: сводка и ряд связей.
 *
 * Раньше здесь были два столбца — «слева чем домен является, справа что
 * развёрнуто на сервере», — и правый ПОВТОРЯЛ восемь полей секции «Server
 * state»: SSL, его срок и издателя, PHP, владельца и путь сайта, логин FTP,
 * имена баз. Одни и те же вопросы получали на одном экране два ответа из разных
 * источников (наша запись из provision против живого чтения по SSH), причём
 * различить их было нечем. Поэтому тесты про эти поля не «переехали» — их
 * предмета в этом файле больше нет: всё про сайт живёт под «Server state», и
 * проверяется там.
 *
 * Здесь остались три правила:
 *
 * 1. Сводка отвечает ровно на три вопроса (статус, срок домена, состояние
 *    сертификата) и ни одного ответа не выдумывает: бейдж SSL считает та же
 *    `sslState`, что и секция ниже, поэтому разойтись они не могут, а
 *    непроверенный домен получает серое «Not checked», а не зелёное.
 * 2. Ряд связей — это Registrar → Cloudflare → Server, путь запроса к домену.
 *    Каждая связь названа именем, а не числом, и у каждого пустого состояния
 *    есть слово: «не назначен» отличается от «есть, но не нашли».
 * 3. Наша запись (`NS`, `Last error`) не потеряна, но и не выдумана: пустой
 *    `Last error` не печатается вовсе — строка «Last error: —» обещала бы
 *    поломку, которой нет.
 *
 * Паролей на карточке по-прежнему нет: сервер их не знает, и пустая строка под
 * них обещала бы значение, которого не будет никогда.
 */

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), invokeSynced: vi.fn() }));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const REGISTRAR = 9;
/** Час сверху — чтобы граница полных суток не перескакивала от задержки рендера. */
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
/** `expiry_date` в производственном виде: `date`, без времени и без зоны. */
const dateOnly = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 10);
/** `2026-09-01` → `01.09.2026`, своей арифметикой — не форматтером продукта. */
const ddMmYyyy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

/** Списки учёток: по ним ряд связей называет аккаунты именами, а не числами. */
function mockAccounts() {
  mocks.apiGet.mockImplementation(async (path: string) => {
    if (String(path).includes("/registrars/accounts")) {
      return [{ id: REGISTRAR, provider: "namecheap", name: "Reg main", is_active: true }];
    }
    if (String(path).includes("/cloudflare/accounts")) {
      return [{ id: 7, name: "Main CF", is_active: true }];
    }
    return [];
  });
}

function domain(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    domain_name: "example.com",
    status: "active",
    registrar_id: REGISTRAR,
    server_id: 3,
    cloudflare_account_id: 7,
    cloudflare_zone_id: null,
    cloudflare_enabled: false,
    expiry_date: null,
    purchase_date: null,
    ns_status: "ok",
    ns_updated_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  } as any;
}

/** Снимок с сервера: ровно та форма, которую сериализует Rust. */
function facts(over: Record<string, unknown> = {}) {
  return {
    site: { domain_name: "example.com", site_user: null, site_path: null, php_version: null },
    ssl: { has_certificate: true, expires_at: at(60 * DAY), issuer: "R3", is_letsencrypt: true },
    ftp_accounts: [],
    php_version: null,
    php_handler: null,
    databases: [],
    logs: [],
    ...over,
  } as any;
}

/** Сервер домена (id 3) — чтобы карточка назвала его именем, а не сырым id. */
const SERVERS = [{ id: 3, name: "web-01", ip_address: "10.0.0.3" }] as any[];

function show(over: Record<string, unknown> = {}, servers: any[] = SERVERS) {
  render(
    <QueryClientProvider client={queryClient}>
      <DomainDetailModal domain={domain(over)} servers={servers} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

/**
 * Текст строки карточки без её подписи.
 *
 * Именно ВЕСЬ текст строки: у строк простых (`Expires`, `NS`, `Last error`) это
 * и есть значение, а у плашки ряда связей в тот же узел входит и подпись под
 * значением. Поэтому спрашивать плашку этим хелпером нельзя — для неё есть
 * `plate()` ниже.
 */
function field(label: string): string {
  const row = screen.getByText(`${label}:`).parentElement;
  if (!row) throw new Error(`строки «${label}» на карточке нет`);
  return (row.textContent ?? "").replace(`${label}:`, "").trim();
}

/** Плашка ряда связей целиком — чтобы спрашивать внутри неё адресно. */
function plate(name: string): HTMLElement {
  return screen.getByRole("group", { name });
}

function registrarSelect() {
  return screen.getByLabelText("Registrar account") as HTMLSelectElement;
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  mockAccounts();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("сводка карточки", () => {
  it("три ответа в одной строке: статус, срок домена, состояние сертификата", () => {
    const expiry = dateOnly(10 * DAY);
    show({ expiry_date: expiry });

    // Статус — бейджем той же лестницы, что и в списке (`lib/domainStatus`).
    expect(screen.getByText("ACTIVE")).toBeTruthy();
    // Срок — тем же модулем, что и колонка списка: дата плюс остаток словами.
    // Дата — та, которую называет регистратор: `expiry_date` приходит без
    // времени, и печатать её надо в UTC, иначе западнее UTC карточка называет
    // предыдущий день.
    expect(field("Expires")).toContain(ddMmYyyy(expiry));
    expect(field("Expires")).toContain("in 10 days");
  });

  it("незнание срока — прочерк, а не пустое место", () => {
    // Домен, заведённый вручную: срока нет. Пустая строка тут читалась бы как
    // «всё в порядке», а это «мы не знаем».
    show();
    expect(field("Expires")).toBe("—");
  });

  it("близкий срок красит, дальний — нет", () => {
    show({ expiry_date: dateOnly(10 * DAY) });
    expect((screen.getByText(/in 10 days/).closest("span") as HTMLElement).style.color).toBe(
      "rgb(217, 119, 6)",
    );
    cleanup();

    show({ expiry_date: dateOnly(60 * DAY) });
    expect((screen.getByText(/in 60 days/).closest("span") as HTMLElement).style.color).toBe(
      "rgb(55, 65, 81)",
    );
  });

  it("непроверенный домен получает серое «Not checked», а не зелёное", () => {
    // Наша запись из provision утверждает «сертификат активен», но на сервере
    // мы этого не читали ни разу. Зелёный бейдж здесь был бы выводом из
    // намерения, а не из измерения (принцип №6 CLAUDE.md).
    show({ ssl_status: "active", ssl_expires_at: at(60 * DAY + HOUR), ssl_issuer: "Let's Encrypt" });

    // Дважды — и это главное: тот же ярлык стоит в секции «Server state».
    // Бейдж сводки и состояние SSL там считает ОДНА функция (`sslState` +
    // `SSL_BADGE` из `lib/domainFacts`), и разойтись они не могут.
    expect(screen.getAllByText("Not checked").length).toBe(2);
    expect(screen.queryByText("Valid")).toBeNull();
  });

  it("свежий снимок с живым сертификатом — «Valid» в обоих местах сразу", () => {
    show({ fp_facts: facts(), fp_facts_at: at(-HOUR) });
    expect(screen.getAllByText("Valid").length).toBe(2);
  });
});

describe("ряд связей — Registrar → Cloudflare → Server", () => {
  it("регистратор назван именем аккаунта, а не сырым id", async () => {
    show();
    // В поле стояло число `9`, которое читателю карточки не говорит ничего, а
    // назначить аккаунт было негде — при том что панель NS внизу этого требует.
    //
    // Ждём именно ИМЕНИ: до ответа списка селект стоит в положении `#9`
    // (заглушка под сохранённый id), и проверка одного лишь `value` прошла бы
    // на непрочитанном списке — то есть ровно там, где имени ещё нет.
    await screen.findByText("Reg main");
    expect(registrarSelect().value).toBe(String(REGISTRAR));
    expect(screen.queryByText("9")).toBeNull();
  });

  it("сервер назван именем и адресом", () => {
    show();
    expect(within(plate("Server")).getByText("web-01")).toBeTruthy();
    // Тот же адрес секция фактов показывает как FTP Host — и берётся он из
    // того же объекта, а не из второго чтения.
    expect(screen.getAllByText("10.0.0.3").length).toBeGreaterThan(0);
  });

  it("домен без сервера говорит «не назначен», а не молчит прочерком", () => {
    show({ server_id: null }, []);
    expect(screen.getByText(/Not assigned/)).toBeTruthy();
    expect(screen.getByText(/gets its server when it is deployed/)).toBeTruthy();
  });

  it("сервер, которого нет в списке, — сырой id и слово об этом", () => {
    // Домен на сервере, которого в списке нет (исчез, под фильтром). Прочерк
    // тут выдавал бы существующую связь за её отсутствие.
    show({}, []);
    // Спрашиваем ЗНАЧЕНИЕ, а не текст всей плашки: id назван и в ноте строкой
    // ниже, так что проверка по `textContent` плашки прошла бы и на значении,
    // подменённом прочерком, — то есть не запирала бы ровно то поведение,
    // ради которого этот тест и написан.
    expect(within(plate("Server")).getByText("3")).toBeTruthy();
    expect(screen.getByText(/Server #3 is not in the loaded list/)).toBeTruthy();
  });

  it("селект Cloudflare стоит в ряду связей и работает как прежде", async () => {
    show();
    await waitFor(() =>
      expect((screen.getByLabelText("Cloudflare account") as HTMLSelectElement).value).toBe("7"),
    );
  });
});

describe("наша запись — то, что не потерялось при пересборке", () => {
  it("NS показывает статус и режим проверки", () => {
    show({ ns_status: "ok", ns_check_mode: "manual" });
    expect(field("NS")).toBe("ok (manual)");
  });

  it("Last error печатается, только когда он есть", () => {
    show();
    // Пустая строка «Last error: —» обещает поломку, которой нет.
    expect(screen.queryByText("Last error:")).toBeNull();

    cleanup();
    show({ last_provision_error: "fastpanel: site already exists" });
    expect(field("Last error")).toBe("fastpanel: site already exists");
  });
});

describe("про сайт карточка отвечает один раз", () => {
  it("верх карточки не повторяет полей секции «Server state»", () => {
    show({
      ssl_status: "active",
      ssl_expires_at: at(60 * DAY + HOUR),
      ssl_issuer: "Let's Encrypt",
      php_version: "8.2",
      site_user: "example_usr",
      site_path: "/var/www/example_usr/data/www/example.com",
      ftp_user: "example_ftp",
      db_name: "example_db",
      db_user: "example_dbu",
    });

    // Это и была главная поломка карточки: те же восемь вопросов получали два
    // ответа из разных источников. Подписи верхнего блока сняты целиком —
    // единственным местом ответа стал «Server state», который читает сервер.
    // Проверяем именно ПОДПИСИ этого блока (с двоеточием, как их рисовал
    // `Field`), а не значения где бы то ни было: значения из provision секция
    // вправе показать у себя как `recorded-only`, и запрет на них означал бы
    // «наша запись не должна показываться нигде» — правило, которого нет.
    for (const gone of ["SSL expires:", "SSL issuer:", "Site user:", "Site path:", "FTP user:", "DB name:", "DB user:"]) {
      expect(screen.queryByText(gone), `${gone} должно исчезнуть с верха карточки`).toBeNull();
    }

    // Путь сайта печатался ТРИЖДЫ (сверху, в Site → Path и в home FTP-аккаунта).
    // Остался ровно один раз — в Site → Path. Проверяем единственность, а не
    // отсутствие: у этого домена снимка нет, и один раз путь показать законно
    // (приглушённым, как нашу запись) — а вот второй его копии на экране взяться
    // уже неоткуда.
    const printed = screen.getAllByText("/var/www/example_usr/data/www/example.com");
    expect(printed).toHaveLength(1);
    // …и это именно строка Path секции, а не забытый остаток верхнего блока.
    expect(printed[0].closest("div")?.textContent).toContain("Path");
  });

  it("пароль FTP — поле первого класса (блоб + RevealSecret), плейнтекста в DOM нет", () => {
    // Доступ по FTP пригоден к использованию, поэтому пароль FTP показывается
    // (через блоб `ftp_password_blob_id` и `RevealSecret`). Но плейнтекста в
    // DOM всё равно нет: без блоба — «not set», с блобом — кнопка «Show», а не
    // сам секрет. Пароля БД по-прежнему нет вовсе — сервер его не знает.
    show({ ftp_user: "example_ftp", db_user: "example_dbu" });
    expect(screen.getByText("Password")).toBeTruthy();
    expect(screen.getByText("not set")).toBeTruthy();
    expect(screen.queryByText(/DB password/i)).toBeNull();
  });
});
