import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainDetailModal from "./DomainDetailModal";
import { queryClient } from "../api/queryClient";
import { openTab } from "../test/tabs";

/**
 * Вкладка Overview карточки домена: шапка над вкладками и то, что стоит на
 * первой из них.
 *
 * Раньше здесь были два столбца — «слева чем домен является, справа что
 * развёрнуто на сервере», — и правый ПОВТОРЯЛ восемь полей секции сервера: SSL,
 * его срок и издателя, PHP, владельца и путь сайта, логин FTP, имена баз. Одни
 * и те же вопросы получали на одном экране два ответа из разных источников
 * (наша запись из provision против живого чтения по SSH), причём различить их
 * было нечем. Поэтому тесты про эти поля не «переехали» — их предмета в этом
 * файле больше нет: сертификат живёт карточкой SSL здесь же, остальное про сайт
 * — на вкладке Server, и проверяется там.
 *
 * Здесь остались три правила:
 *
 * 1. Шапка отвечает ровно на три вопроса (статус, срок домена, состояние
 *    сертификата) и ни одного ответа не выдумывает: `sslState` карточка считает
 *    ОДИН раз и раздаёт обоим потребителям — бейджу шапки и карточке SSL на
 *    Overview, — а непроверенный домен получает серое «Not checked», а не
 *    зелёное. Проверяется это здесь, потому что здесь видно обоих сразу.
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

/** Списки связей: по ним ряд карточек называет их именами, а не числами. */
function mockApi(servers: any[] = SERVERS) {
  mocks.apiGet.mockImplementation(async (path: string) => {
    const p = String(path);
    if (p.includes("/registrars/accounts")) {
      return [{ id: REGISTRAR, provider: "namecheap", name: "Reg main", is_active: true }];
    }
    if (p.includes("/cloudflare/accounts")) {
      return [{ id: 7, name: "Main CF", is_active: true }];
    }
    // Список серверов поле сервера читает САМО (`useServers` → `{items,total}`),
    // пропом он до ряда связей больше не доезжает. Прежний `[]` на этом пути
    // означал бы для селекта «список не прочитан» — то есть вечную загрузку
    // вместо любого из проверяемых здесь состояний.
    if (p === "/servers") return { items: servers, total: servers.length };
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

/**
 * Список серверов уходит В ДВА места, и оба нужны: пропом — карточке FTP на
 * вкладке Server (адрес хоста), ответом API — селекту сервера в ряду связей.
 * Разъехавшись, они дали бы «сервера нет в списке» рядом с его же IP.
 */
function show(over: Record<string, unknown> = {}, servers: any[] = SERVERS) {
  mockApi(servers);
  render(
    <QueryClientProvider client={queryClient}>
      <DomainDetailModal domain={domain(over)} servers={servers} onProvision={() => {}} isProvisioning={false} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

/**
 * Текст строки карточки без её подписи.
 *
 * Именно ВЕСЬ текст строки: у строк простых (`Expires`, `NS`, `Last error`) это
 * и есть значение, а у карточки ряда связей в тот же узел входит и подпись под
 * значением. Поэтому спрашивать карточку этим хелпером нельзя — для неё есть
 * `plate()` ниже.
 */
function field(label: string): string {
  const row = screen.getByText(`${label}:`).parentElement;
  if (!row) throw new Error(`строки «${label}» на карточке нет`);
  return (row.textContent ?? "").replace(`${label}:`, "").trim();
}

/**
 * Карточка ряда связей целиком — чтобы спрашивать внутри неё адресно.
 *
 * По роли, а не по вёрстке: `role="group"` с именем карточки — обещание
 * `SectionCard` (раньше — плашки `Plate`), и без него ряд читается скринридером
 * сплошной лентой из трёх селектов и пяти подписей.
 */
function plate(name: string): HTMLElement {
  return screen.getByRole("group", { name });
}

function registrarSelect() {
  return screen.getByLabelText("Registrar account") as HTMLSelectElement;
}

function serverSel() {
  return screen.getByLabelText("Assigned server") as HTMLSelectElement;
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  mockApi();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("шапка карточки", () => {
  it("три ответа в шапке: статус, срок домена, состояние сертификата", () => {
    const expiry = dateOnly(10 * DAY);
    show({ expiry_date: expiry });

    // Статус — бейджем той же лестницы, что и в списке (`lib/domainStatus`).
    expect(screen.getByText("Deployed")).toBeTruthy();
    // Срок — тем же модулем, что и колонка списка: дата плюс остаток словами.
    // Дата — та, которую называет регистратор: `expiry_date` приходит без
    // времени, и печатать её надо в UTC, иначе западнее UTC карточка называет
    // предыдущий день.
    expect(field("Expires")).toContain(ddMmYyyy(expiry));
    expect(field("Expires")).toContain("in 10 days");
  });

  it("имя домена — заголовок карточки, и крестик шапки её закрывает", () => {
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <DomainDetailModal domain={domain()} servers={SERVERS} onProvision={() => {}} isProvisioning={false} onClose={onClose} />
      </QueryClientProvider>,
    );

    // `h2`, а не `h1`/`h3`: заголовки секций карточки — `h3`, и ступень между
    // ними и шапкой пропускать нельзя.
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("example.com");
    // Своя шапка заменяет штатную строку модалки ЦЕЛИКОМ, вместе с её
    // крестиком: забыв позвать `onClose`, карточку нечем было бы закрыть, кроме
    // подложки.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("незнание срока названо словом, а не пустым местом", () => {
    // Домен, заведённый вручную: срока нет. Пустая строка тут читалась бы как
    // «всё в порядке», а это «мы не знаем».
    //
    // Прочерк сменился приглашением «set date» вместе с переездом значения на
    // кнопку: срок теперь правится прямо здесь, а прочерк на кнопке читается
    // как «тут делать нечего». Утверждение то же — незнание названо словом.
    show();
    expect(field("Expires")).toBe("set date");
  });

  it("близкий срок красит, дальний — нет", () => {
    // Значение переехало в кнопку инлайн-правки, поэтому цвет спрашиваем у неё
    // — утверждение прежнее: близкий срок янтарный, дальний обычный тёмный.
    // Хексы поехали вместе с переездом `expiryTextColor` на палитру макета — и
    // поехали ОДНОВРЕМЕННО здесь и в строке списка, потому что источник у
    // обоих один. Это и есть смысл модуля: срок домена в карточке и он же в
    // списке обязаны выглядеть одинаково.
    show({ expiry_date: dateOnly(10 * DAY) });
    expect((screen.getByText(/in 10 days/) as HTMLElement).style.color).toBe("rgb(180, 83, 9)");
    cleanup();

    show({ expiry_date: dateOnly(60 * DAY) });
    expect((screen.getByText(/in 60 days/) as HTMLElement).style.color).toBe("rgb(15, 23, 42)");
  });

  it("непроверенный домен получает серое «Not checked», а не зелёное", () => {
    // Наша запись из provision утверждает «сертификат активен», но на сервере
    // мы этого не читали ни разу. Зелёный бейдж здесь был бы выводом из
    // намерения, а не из измерения (принцип №6 CLAUDE.md).
    show({ ssl_status: "active", ssl_expires_at: at(60 * DAY + HOUR), ssl_issuer: "Let's Encrypt" });

    // Дважды — и это главное: тот же ярлык стоит в карточке SSL на Overview.
    // Значение карточка домена считает ОДИН раз (`sslState`) и раздаёт обоим
    // пропсом, так что разъехаться им теперь негде; этот тест — то, что держит
    // оба ответа вместе.
    expect(screen.getAllByText("Not checked").length).toBe(2);
    expect(screen.queryByText("Valid")).toBeNull();
  });

  it("свежий снимок с живым сертификатом — «Valid» в обоих местах сразу", () => {
    show({ fp_facts: facts(), fp_facts_at: at(-HOUR) });
    expect(screen.getAllByText("Valid").length).toBe(2);
  });

  it("протухший снимок валидного сертификата — «Not checked» в обоих местах", () => {
    // Лестница `sslState` целиком проверена в `lib/domainFacts.test.ts`; здесь
    // важно, что протухание доезжает до ЭКРАНА и доезжает одинаково в оба
    // места. Зелёный бейдж на снимке недельной давности — вывод из старого
    // измерения, а не из свежего (принцип №6 CLAUDE.md).
    show({ fp_facts: facts(), fp_facts_at: at(-8 * DAY) });
    expect(screen.getAllByText("Not checked").length).toBe(2);
    expect(screen.queryByText("Valid")).toBeNull();
  });

  it("свежий снимок без сертификата — «No certificate», отличимо от «не проверяли»", () => {
    show({
      fp_facts: facts({ ssl: { has_certificate: false, expires_at: null, issuer: null, is_letsencrypt: false } }),
      fp_facts_at: at(-HOUR),
    });
    expect(screen.getAllByText("No certificate").length).toBe(2);
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

  it("сервер выбирается селектом, а не только читается", async () => {
    // Поле было read-only по решению плана 2026-08-17 («сервер домену назначает
    // развёртывание»). Решение отменено: provision `server_id` не ставит, а
    // читает и без него падает — связка обязана существовать ДО развёртывания.
    // Правила самого поля проверены у него (`DomainServerField.test.tsx`); здесь
    // — что в ряду связей стоит именно оно и что имя приезжает списком.
    show();
    expect(await within(plate("Server")).findByText("web-01")).toBeTruthy();
    // Имя поля шире имени карточки (`Assigned server` против титула `SERVER`) —
    // как у обоих соседей ряда; совпади они, обращение по имени было бы
    // двусмысленным и для скринридера, и отсюда.
    expect(serverSel().value).toBe("3");
    expect(within(plate("Server")).getByText("10.0.0.3")).toBeTruthy();
    // Тот же адрес карточка FTP показывает как Host — и берётся он из того
    // же объекта, а не из второго чтения (карточка живёт на вкладке Server,
    // поэтому спрашиваем её после переключения).
    openTab("Server");
    expect(screen.getByText("Host").parentElement?.textContent).toContain("10.0.0.3");
  });

  it("домен без сервера говорит, чем это грозит, а не молчит прочерком", async () => {
    show({ server_id: null }, []);
    // Прежняя подпись «A domain gets its server when it is deployed» удалена
    // как НЕВЕРНАЯ: развёртывание сервер не назначает, а требует.
    expect(screen.queryByText(/gets its server when it is deployed/)).toBeNull();
    expect(await screen.findByText(/deployment has nowhere to go/i)).toBeTruthy();
  });

  it("сервер, которого нет в списке, — сырой id и слово об этом", async () => {
    // Домен на сервере, которого в списке нет (исчез, под фильтром). Пустой
    // селект тут выдавал бы существующую связь за её отсутствие.
    show({}, []);
    expect(await within(plate("Server")).findByText(/#3 · server not found/)).toBeTruthy();
    // Спрашиваем ЗНАЧЕНИЕ селекта, а не текст карточки: id назван и в ноте
    // строкой ниже, так что проверка по `textContent` прошла бы и на селекте,
    // упавшем в «— No server —», — то есть не запирала бы ровно то поведение,
    // ради которого этот тест и написан.
    expect(serverSel().value).toBe("3");
    expect(screen.getByText(/Server #3 is not in the list/)).toBeTruthy();
  });

  it("селект Cloudflare стоит в ряду связей и работает как прежде", async () => {
    show();
    await waitFor(() =>
      expect((screen.getByLabelText("Cloudflare account") as HTMLSelectElement).value).toBe("7"),
    );
  });
});

describe("наша запись — то, что не потерялось при пересборке", () => {
  /*
   * Строки «NS: ok (manual)» здесь больше нет, и это не потеря покрытия.
   *
   * Она печатала НАШУ запись о последней попытке смены NS, стоя двумя рядами
   * выше карточки NAMESERVERS — той, что сверяет делегирование живьём (CF +
   * RDAP). Два ответа про NS на одном экране спорили, и убран был слабейший
   * (фаза 3 плана `2026-08-21-domains-shest-pravok.md`). Что запись доезжает до
   * интерфейса, по-прежнему доказывает `pages/Domains.setns.test.tsx` — теперь
   * счётчиками `NS details`, единственной оставшейся её поверхностью.
   */

  it("тревожный итог выпуска сертификата назван, спокойный — нет", () => {
    // Список красит такой домен красным «SSL error», а карточка про провал не
    // говорила ни слова: `ssl_expires_at`/`ssl_issuer` у него пусты (секции
    // нечего показать), бейдж шапки считает снимок с сервера и говорит «Not
    // checked», а `last_provision_error` write-back провижининга явно гасит в
    // `null`. Человек кликал по красной строке — и не находил даже упоминания.
    show({ ssl_status: "error" });
    expect(field("SSL at provision")).toContain("error");
    expect(screen.getByText(/did not issue a certificate/)).toBeTruthy();

    cleanup();
    // «Выпуск идёт» без того, кто его завершит, — застрявший прогон, а не
    // процесс: список красит его жёлтым, значит и карточка обязана назвать.
    show({ ssl_status: "pending" });
    expect(field("SSL at provision")).toContain("pending");

    cleanup();
    // А вот успех прошлого прогона строкой не дублируется: он уже стоит в
    // карточке SSL сроком и издателем с подписью «из provision, на сервере не
    // проверено». Третье утверждение о том же — и рядом с серым бейджем шапки,
    // который отвечает про ИЗМЕРЕНИЕ, — только сбивало бы.
    show({ ssl_status: "active", ssl_expires_at: at(60 * DAY + HOUR) });
    expect(screen.queryByText("SSL at provision:")).toBeNull();

    cleanup();
    // «Сертификата нет» списка и «не проверяли» карточки не спорят — объяснять
    // нечего.
    show({ ssl_status: "none" });
    expect(screen.queryByText("SSL at provision:")).toBeNull();

    cleanup();
    show();
    expect(screen.queryByText("SSL at provision:")).toBeNull();
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
  it("верх карточки не повторяет полей вкладки Server", () => {
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
    // единственным местом ответа стали карточки, читающие сервер (SSL здесь,
    // остальное на вкладке Server). Проверяем именно ПОДПИСИ этого блока (с
    // двоеточием, как их рисовал `Field`), а не значения где бы то ни было:
    // значения из provision карточка вправе показать у себя как
    // `recorded-only`, и запрет на них означал бы «наша запись не должна
    // показываться нигде» — правило, которого нет.
    for (const gone of ["SSL expires:", "SSL issuer:", "Site user:", "Site path:", "FTP user:", "DB name:", "DB user:"]) {
      expect(screen.queryByText(gone), `${gone} должно исчезнуть с верха карточки`).toBeNull();
    }
    // Путь сайта на Overview не печатается вовсе — он весь про сервер.
    expect(screen.queryByText("/var/www/example_usr/data/www/example.com")).toBeNull();

    // Путь сайта печатался ТРИЖДЫ (сверху, в Site → Path и в home FTP-аккаунта).
    // Остался ровно один раз — в Site → Path на вкладке Server. Проверяем
    // единственность, а не отсутствие: у этого домена снимка нет, и один раз
    // путь показать законно (приглушённым, как нашу запись) — а вот второй его
    // копии на экране взяться уже неоткуда.
    openTab("Server");
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
    // Доступ по FTP — это про сервер, поэтому и живёт он на вкладке Server.
    openTab("Server");
    expect(screen.getByText("Password")).toBeTruthy();
    expect(screen.getByText("not set")).toBeTruthy();
    expect(screen.queryByText(/DB password/i)).toBeNull();
  });
});
