import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainServerTab from "./DomainServerTab";
import { queryClient } from "../../../api/queryClient";
import type { DomainFacts } from "../../../lib/domainFacts";
import { setTauri, setBlobUser, clearBlobUser, putBlobArgs, blobPlaintext } from "../../../test/secretBlobKit";

/**
 * Вкладка Server карточки домена: витрина прочитанного с сервера с честной
 * свежестью — и ЕДИНСТВЕННОЕ место карточки, отвечающее на вопрос «что с
 * сайтом». Проверяем продуктовые правила всех фаз, которые её собрали.
 *
 * Нумерация фаз ниже — из ПРЕЖНЕГО плана карточки домена (там их было четыре);
 * раскладку по вкладкам делает следующий план, и его правила названы здесь
 * словами, а не номером, чтобы две нумерации не читались как одна.
 *
 * Раскладка вкладок: секция стала двумя карточками (`FTP Access` и `Site`), а
 * перечень логов из этого же снимка принадлежит вкладке Logs — здесь его быть
 * не должно, иначе на один вопрос отвечают два места. Резервные копии, стоявшие
 * тут заглушкой `Backups`, уехали на свою вкладку Backup по той же причине, и
 * тест ниже сторожит, что заглушка не вернулась.
 *
 * Фаза 3 (свежесть и секреты):
 *  - кнопка «Проверить на сервере» и ручной ввод пароля — ТОЛЬКО десктоп;
 *  - свежесть считается от `fp_facts_at`, «never checked» — отдельное слово;
 *  - провал последней попытки виден, но снимок остаётся;
 *  - пароль FTP — через `RevealSecret`, плейнтекста в DOM нет.
 *
 * Про SSL здесь больше нет ничего: карточка сертификата уехала на вкладку
 * Overview вместе со своей половиной правила расхождений, и проверяется она там
 * же — `DomainSslCard.test.tsx` (лестница состояний) и
 * `DomainDetailModal.overview.test.tsx` (бейдж шапки и карточка не расходятся).
 *
 * Фаза 4 (наша запись против факта):
 *  - строка «при развёртывании: X» есть при расхождении и отсутствует при
 *    совпадении, значением поля остаётся факт;
 *  - `home` FTP-аккаунта не дублирует путь сайта;
 *  - домен без снимка не показывает решётки прочерков;
 *  - пустой список фактов — «не прочитали», а не измеренная пустота.
 *
 * Исход правила проверяется по атрибуту `data-source`, а не по инлайн-цвету:
 * цвет уедет в токены вместе с редизайном, а вопрос «показано как факт или как
 * наша запись» останется тем же.
 */

const mocks = vi.hoisted(() => ({ invokeSynced: vi.fn(), invokeIfTauri: vi.fn(), apiPut: vi.fn() }));

vi.mock("../../../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

// Мокаем транспорт (`vault_put_blob`-канал и `apiPut`), а не сам `secretBlob`:
// тест обязан ВИДЕТЬ, что уехало в блоб (плейнтекст) и что — в тело PUT (только
// blobId). Заглушка над `putSecretBlob`/`useSecretSave` пропустила бы регрессию,
// прокидывающую пароль в `variables` мутации домена.
vi.mock("../../../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

vi.mock("../../../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiPut: mocks.apiPut,
}));

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

const SERVER = { id: 3, name: "web-01", ip_address: "10.0.0.3" } as any;

function facts(over: Partial<DomainFacts> = {}): DomainFacts {
  return {
    site: { domain_name: "example.com", site_user: "example_usr", site_path: "/var/www/example.com", php_version: "8.2" },
    ssl: { has_certificate: true, expires_at: ahead(60 * DAY), issuer: "Let's Encrypt", is_letsencrypt: true },
    ftp_accounts: [{ login: "example_ftp", home: "/var/www/example.com" }],
    php_version: "8.2",
    php_handler: "php-fpm",
    databases: ["example_db"],
    logs: [{ path: "/var/log/nginx/example.com.error.log", exists: true, size_bytes: 1024 }],
    ...over,
  };
}

function domain(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    domain_name: "example.com",
    status: "active",
    server_id: 3,
    registrar_id: 9,
    ftp_user: "example_ftp",
    ...over,
  } as any;
}

/**
 * Аргументы всех mock-вызовов, КРОМЕ `vault_put_blob` (единственного законного
 * получателя плейнтекста), в виде JSON-строк — чтобы искать в них утечку.
 */
function otherMockCalls(): { name: string; blob: string }[] {
  const out: { name: string; blob: string }[] = [];
  for (const c of mocks.invokeIfTauri.mock.calls) {
    if (c[0] === "vault_put_blob") continue;
    out.push({ name: `invokeIfTauri:${String(c[0])}`, blob: JSON.stringify(c) });
  }
  for (const c of mocks.invokeSynced.mock.calls) {
    out.push({ name: `invokeSynced:${String(c[0])}`, blob: JSON.stringify(c) });
  }
  for (const c of mocks.apiPut.mock.calls) {
    out.push({ name: "apiPut", blob: JSON.stringify(c) });
  }
  return out;
}

/** Исход правила, которым нарисовано поле с этой подписью. */
function sourceOf(label: string): string | null {
  return screen.getByText(label).closest("[data-source]")?.getAttribute("data-source") ?? null;
}

/** Текст всей строки поля (подпись + значение) — без опоры на вёрстку `Row`. */
function rowText(label: string): string {
  return screen.getByText(label).closest("[data-source]")?.textContent ?? "";
}

function show(over: Record<string, unknown> = {}, server = SERVER) {
  render(
    <QueryClientProvider client={queryClient}>
      <DomainServerTab domain={domain(over)} server={server} now={Date.now()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  setBlobUser();
});

afterEach(() => {
  cleanup();
  setTauri(false);
  clearBlobUser();
  queryClient.clear();
});

describe("кнопка «Проверить на сервере» — только десктоп", () => {
  it("в вебе кнопки нет", () => {
    setTauri(false);
    show();
    expect(screen.queryByText("Проверить на сервере")).toBeNull();
  });

  it("в десктопе есть и зовёт domain_read_facts с id домена", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue(facts());
    show();
    fireEvent.click(screen.getByText("Проверить на сервере"));
    await waitFor(() =>
      expect(mocks.invokeSynced).toHaveBeenCalledWith("domain_read_facts", {
        userId: "user-1",
        domainId: "42",
      }),
    );
  });
});

describe("свежесть", () => {
  it("снимка не было — «Never checked»", () => {
    show();
    expect(screen.getByText("Never checked")).toBeTruthy();
  });

  it("старый снимок помечен протухшим", () => {
    show({ fp_facts: facts(), fp_facts_at: ago(8 * DAY) });
    const el = screen.getByText(/Checked/);
    expect(el.textContent).toContain("stale");
  });

  it("свежий снимок протухшим не помечен", () => {
    show({ fp_facts: facts(), fp_facts_at: ago(2 * HOUR) });
    const el = screen.getByText(/Checked/);
    expect(el.textContent).not.toContain("stale");
  });
});

describe("ошибка последней попытки", () => {
  it("показана, а снимок остаётся (свежесть — от fp_facts_at)", () => {
    // `fp_checked_at` стоит В ФИКСТУРЕ и НАМЕРЕННО свежее снимка: без него имя
    // теста обещало то, чего он не проверял. Считай возраст от последней
    // ПОПЫТКИ — и строка сказала бы «Checked 1m ago» над данными двухчасовой
    // давности, то есть проваленная проверка молодила бы снимок. Общее правило
    // живёт в `lib/domainFacts` и проверено ещё и у карточки SSL, но здесь у
    // подписи свой потребитель и свой единственный экземпляр на вкладке.
    show({
      fp_facts: facts(),
      fp_facts_at: ago(2 * HOUR),
      fp_checked_at: ago(60_000),
      fp_check_error: "ssh: connection refused",
    });
    expect(screen.getByText(/Checked/).textContent).toMatch(/2h/);
    expect(screen.getByText(/ssh: connection refused/)).toBeTruthy();
    // Снимок жив: поля по-прежнему из него, ошибка его не стёрла. Раньше это
    // проверялось по бейджу «Valid» — он уехал на карточку SSL вместе с ней, а
    // утверждение осталось тем же и спрашивает теперь соседнее поле снимка.
    expect(screen.getByText("8.2 · php-fpm")).toBeTruthy();
  });
});

describe("пароль FTP", () => {
  it("без блоба — «not set», ручной ввод только в десктопе", () => {
    setTauri(false);
    show();
    expect(screen.getByText("not set")).toBeTruthy();
    expect(screen.queryByText("Задать пароль")).toBeNull();
  });

  it("«Задать пароль»: плейнтекст уходит ТОЛЬКО в vault_put_blob, в PUT домена — лишь blobId", async () => {
    // Единственный security-инвариант фазы: пароль FTP не попадает ни в
    // `variables` мутации `updateDomain`, ни в тело PUT, ни в один другой вызов
    // — только в блоб. Регрессия «прокинули `ftp_password` в мутацию» обязана
    // красить этот тест, поэтому он ВВОДИТ значение и стережёт его отсутствие.
    const SENTINEL = "ftp-sentinel-pw-9f3";
    setTauri(true);
    mocks.invokeIfTauri.mockResolvedValue(undefined);
    mocks.apiPut.mockResolvedValue(domain());
    show();

    fireEvent.click(screen.getByText("Задать пароль"));
    fireEvent.change(screen.getByLabelText("FTP password"), { target: { value: SENTINEL } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));

    // Легитимный путь: плейнтекст уехал в блоб байт в байт и под верным kind.
    const blob = putBlobArgs(mocks.invokeIfTauri);
    expect(blob.blobKind).toBe("domain_ftp_password");
    expect(blobPlaintext(blob)).toBe(SENTINEL);
    const b64 = blob.plaintextB64 as string;

    // Инвариант: PUT /domains/42 несёт ТОЛЬКО ссылку на блоб.
    const [url, body] = mocks.apiPut.mock.calls[0];
    expect(url).toBe("/domains/42");
    expect(body).toEqual({ ftp_password_blob_id: blob.blobId });
    expect(JSON.stringify(body)).not.toContain(SENTINEL);
    expect(JSON.stringify(body)).not.toContain(b64);

    // И нигде больше: ни в одном mock-вызове, кроме `vault_put_blob`, нет ни
    // плейнтекста, ни его base64.
    const leaked = otherMockCalls().filter(
      (c) => c.blob.includes(SENTINEL) || c.blob.includes(b64),
    );
    expect(leaked).toEqual([]);
  });

  it("в десктопе «Задать пароль» открывает поле ввода (по aria-label), а не показывает секрет", () => {
    setTauri(true);
    show();
    fireEvent.click(screen.getByText("Задать пароль"));
    expect(screen.getByLabelText("FTP password")).toBeTruthy();
  });

  it("с блобом — показывается кнопка RevealSecret, а не сам пароль", () => {
    show({ ftp_password_blob_id: "11111111-1111-4111-8111-111111111111" });
    expect(screen.getByText("Show FTP password")).toBeTruthy();
  });
});

describe("данные сайта", () => {
  it("путь, PHP с обработчиком и БД из фактов", () => {
    show({ fp_facts: facts(), fp_facts_at: ago(HOUR) });
    expect(screen.getByText("/var/www/example.com")).toBeTruthy();
    expect(screen.getByText("8.2 · php-fpm")).toBeTruthy();
    expect(screen.getByText("example_db")).toBeTruthy();
  });

  it("перечня логов на вкладке Server нет: он предмет вкладки Logs", () => {
    // Утверждение-дубль прежнего: раньше здесь проверялось, что строка `Logs`
    // печатает пути из снимка. Логи читаются из того же `fp_facts.logs`, что и
    // всё остальное, и по плану вкладок принадлежат вкладке Logs — два места,
    // печатающие один и тот же перечень, разъехались бы в первый же день,
    // когда одно из них поправят. Поэтому правило осталось, только с обратным
    // знаком, и переживёт приезд самой вкладки.
    show({ fp_facts: facts(), fp_facts_at: ago(HOUR) });
    expect(screen.queryByText("/var/log/nginx/example.com.error.log")).toBeNull();
    expect(screen.queryByText("Logs")).toBeNull();
  });
});

describe("раскладка макета: карточки, а не сплошная секция", () => {
  it("две именованные карточки — FTP Access и Site", () => {
    // Именно `role="group"` с именем: карточка `SectionCard` — единица, по
    // которой скринридер прыгает и к которой относит поля. Ряд из полей без
    // группировки — это лента, где непонятно, чей `Login` и чей `Path`.
    show({ fp_facts: facts(), fp_facts_at: ago(HOUR) });
    expect(screen.getByRole("group", { name: "FTP Access" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Site" })).toBeTruthy();
    // Поля стоят каждое в своей карточке, а не рядом друг с другом.
    const ftp = screen.getByRole("group", { name: "FTP Access" }).textContent ?? "";
    expect(ftp).toContain("Host");
    expect(ftp).toContain("Password");
    expect(ftp).not.toContain("Databases");
    const site = screen.getByRole("group", { name: "Site" }).textContent ?? "";
    expect(site).toContain("Databases");
    expect(site).not.toContain("Password");
  });

  it("свежесть и карточки — одна названная область, и заглушки Backups в ней нет", () => {
    // Подпись возраста стоит ОТДЕЛЬНОЙ строкой над карточками: глазами близость
    // всё объясняет, на слух — ничего. Область «Server snapshot» и связывает их:
    // войдя в неё, человек слышит имя, а первой внутри стоит сама подпись.
    show({ fp_facts: facts(), fp_facts_at: ago(HOUR) });
    const region = screen.getByRole("region", { name: "Server snapshot" });
    expect(within(region).getByText(/Checked/)).toBeTruthy();
    expect(within(region).getByRole("group", { name: "FTP Access" })).toBeTruthy();
    expect(within(region).getByRole("group", { name: "Site" })).toBeTruthy();
    // Карточки Backups больше нет НИГДЕ на вкладке: копии читаются из того же
    // снимка, но отвечает за них своя вкладка Backup. Оставшись здесь, заглушка
    // стала бы вторым ответом на вопрос, у которого уже есть первый.
    expect(screen.queryByRole("group", { name: "Backups" })).toBeNull();
  });
});

/**
 * Фаза 4: секция — единственный источник про сайт. Значением поля остаётся ФАКТ,
 * наша запись из provision всплывает строкой «при развёртывании: X» ровно тогда,
 * когда расходится с фактом, и становится приглушённым значением там, где факта
 * нет. Само правило проверено отдельно (`lib/domainDrift.test.ts`) — здесь
 * проверяется ПОКАЗ: что все три исхода долетают до экрана и что незнание не
 * превращается в прочерк.
 */
describe("расхождение нашей записи с фактом", () => {
  const fresh = { fp_facts: facts(), fp_facts_at: ago(HOUR) };

  it("совпало — строки «при развёртывании» нет вовсе", () => {
    show({
      ...fresh,
      php_version: "8.2",
      site_path: "/var/www/example.com/", // хвостовой слэш — не расхождение
      site_user: "example_usr",
      db_name: "example_db",
    });
    expect(screen.queryByText(/при развёртывании/)).toBeNull();
  });

  it("PHP разошёлся: значением остаётся факт, наша запись — серой строкой", () => {
    show({ ...fresh, php_version: "7.4" });
    expect(screen.getByText("8.2 · php-fpm")).toBeTruthy();
    expect(screen.getByText(/при развёртывании: 7\.4/)).toBeTruthy();
  });

  it("путь, владелец и база расходятся каждый своей строкой", () => {
    // Издатель сертификата был здесь четвёртым и уехал на карточку SSL вместе
    // с ней (`DomainSslCard.test.tsx` проверяет его тем же утверждением).
    show({
      ...fresh,
      site_path: "/var/www/old.example.com",
      site_user: "old_usr",
      db_name: "old_db",
    });
    // Множеством, а не списком в DOM-порядке: перестановка колонок — вопрос
    // вёрстки, и красить ею тест про поведение незачем.
    const notes = screen.getAllByText(/при развёртывании/).map((n) => n.textContent);
    expect(notes).toHaveLength(3);
    expect(new Set(notes)).toEqual(
      new Set([
        "при развёртывании: /var/www/old.example.com",
        "при развёртывании: old_usr",
        "при развёртывании: old_db",
      ]),
    );
  });

  it("логин FTP: значение — живой аккаунт сервера, наш удалённый уходит в строку", () => {
    // Регрессия, ради которой правка и сделана: раньше значением поля была НАША
    // запись, и удалённый с сервера аккаунт печатался как живой.
    show({
      ...fresh,
      fp_facts: facts({ ftp_accounts: [{ login: "server_ftp", home: null }] }),
      ftp_user: "example_ftp",
    });
    expect(rowText("Login")).toContain("server_ftp");
    expect(screen.getByText(/при развёртывании: example_ftp/)).toBeTruthy();
  });

  it("пробельная запись не заслоняет живой аккаунт сервера", () => {
    // `ftp_user` из одних пробелов правило чистит и отвечает `agree`, а сырая
    // строка при этом truthy: наивное `domain.ftp_user || facts[0]` напечатало
    // бы пустоту вместо реального логина — тот же дефект, только незаметнее.
    show({ ...fresh, fp_facts: facts({ ftp_accounts: [{ login: "server_ftp", home: null }] }), ftp_user: "   " });
    expect(rowText("Login")).toContain("server_ftp");
    expect(sourceOf("Login")).toBe("agree");
  });
});

describe("«Accounts on server»: перечень не повторяет уже сказанного", () => {
  it("home совпал с путём сайта (с точностью до хвостового слэша) — не печатается", () => {
    // Второй аккаунт — чтобы перечень вообще рисовался: проверяем именно
    // гашение `home`, а не гашение блока.
    show({
      fp_facts: facts({
        ftp_accounts: [
          { login: "example_ftp", home: "/var/www/example.com/" },
          { login: "second_ftp", home: "/home/second" },
        ],
      }),
      fp_facts_at: ago(HOUR),
    });
    expect(screen.getByText("Accounts on server")).toBeTruthy();
    expect(screen.queryByText(/· \/var\/www\/example\.com/)).toBeNull();
    expect(screen.getByText(/· \/home\/second/)).toBeTruthy();
  });

  it("home отличается от пути сайта — печатается", () => {
    show({
      fp_facts: facts({ ftp_accounts: [{ login: "example_ftp", home: "/home/example_usr" }] }),
      fp_facts_at: ago(HOUR),
    });
    expect(screen.getByText(/· \/home\/example_usr/)).toBeTruthy();
  });

  it("единственный аккаунт уже напечатан полем Login — блока нет вовсе", () => {
    // Иначе перечень — это одна строка, дословно повторяющая строку над собой
    // в той же колонке: логин тот же, `home` погашен как копия пути сайта.
    show({ fp_facts: facts(), fp_facts_at: ago(HOUR) });
    expect(rowText("Login")).toContain("example_ftp");
    expect(screen.queryByText("Accounts on server")).toBeNull();
  });

  it("рядом есть второй аккаунт — печатается ВЕСЬ перечень, включая основной", () => {
    // Блок гасится целиком или показывается целиком: список, из которого молча
    // изъят основной логин, врал бы своему заголовку «Accounts on server».
    show({
      fp_facts: facts({
        ftp_accounts: [
          { login: "example_ftp", home: "/var/www/example.com" },
          { login: "second_ftp", home: "/var/www/example.com" },
        ],
      }),
      fp_facts_at: ago(HOUR),
    });
    const roster = screen.getByText("Accounts on server").parentElement?.textContent ?? "";
    expect(roster).toContain("example_ftp");
    expect(roster).toContain("second_ftp");
  });

  it("гашение считается против ПОКАЗАННОГО логина, а не против нашей записи", () => {
    // Наша запись `example_ftp` разошлась с сервером, поэтому полем `Login`
    // показан факт `server_ftp` — и перечень из него одного ничего не
    // добавляет, хотя с нашей записью он и не совпадает.
    show({
      fp_facts: facts({ ftp_accounts: [{ login: "server_ftp", home: "/var/www/example.com" }] }),
      fp_facts_at: ago(HOUR),
      ftp_user: "example_ftp",
    });
    expect(rowText("Login")).toContain("server_ftp");
    expect(screen.getByText(/при развёртывании: example_ftp/)).toBeTruthy();
    expect(screen.queryByText("Accounts on server")).toBeNull();
  });
});

describe("снимка не было ни разу", () => {
  it("вместо решётки прочерков — одна строка словами", () => {
    show({ ftp_user: null });
    expect(screen.getByText("Never checked")).toBeTruthy();
    expect(screen.getByText(/Сервер ещё не читали/)).toBeTruthy();
    // Прочерков нет ни одного: Host берётся у сервера, Port — константа, а
    // поля снимка спрятаны целиком, потому что прочерк в них читался бы как
    // «спросили, там пусто».
    expect(screen.queryAllByText("—")).toEqual([]);
    // И «not read» — тоже ни одного: так помечен ПУСТОЙ СПИСОК под снимком
    // («спросили, не прочитали»), а здесь спрашивать мы не ходили вовсе, и
    // легенда строкой выше уже сказала это словами. Утверждение общее на обе
    // карточки: список печатают и `Login` (аккаунты FTP), и `Databases`.
    expect(screen.queryAllByText("not read")).toEqual([]);
  });

  it("известное из provision показано как наша запись, а подпись дана легендой один раз", () => {
    show({ ftp_user: "example_ftp", site_path: "/var/www/example.com", db_user: "example_dbu" });
    expect(sourceOf("Login")).toBe("recorded-only");
    expect(sourceOf("Path")).toBe("recorded-only");
    expect(sourceOf("DB user")).toBe("recorded-only");
    for (const v of ["example_ftp", "/var/www/example.com", "example_dbu"]) {
      expect(screen.getByText(v)).toBeTruthy();
    }
    // Подпись плана дана дословно, но ОДИН раз — легендой над сеткой, а не
    // одинаковой строкой под каждым полем (принцип №2).
    expect(screen.getAllByText(/из provision, на сервере не проверено/)).toHaveLength(1);
    // И ни одно значение не выдано за расхождение: сверять было не с чем.
    expect(screen.queryByText(/при развёртывании/)).toBeNull();
  });

  it("карточке Site нечего сказать — она говорит это словом, а не пустой рамкой", () => {
    // Импортированный домен: ни снимка, ни записей provision. Все пять строк
    // карточки прячутся (прочерк читался бы как «спросили, там пусто»), и без
    // этой фразы на экране остаётся пустая коробка с рамкой и крашеной шапкой,
    // растянутая соседкой по ряду на её высоту, — вёрстка, читающаяся поломкой.
    // Легенда вкладки объясняет ВКЛАДКУ, а не то, почему у карточки нет ни
    // строки.
    show({ ftp_user: null });
    const site = screen.getByRole("group", { name: "Site" });
    expect(site.textContent).toContain("No site details recorded for this domain yet.");
  });

  it("есть хоть одна запись из provision — фразы нет, есть строка", () => {
    // Условие точное, а не «похоже на пустоту»: одна запись из provision — и
    // карточке уже есть что показать, приглушённым значением.
    show({ ftp_user: null, site_path: "/var/www/example.com" });
    const site = screen.getByRole("group", { name: "Site" });
    expect(site.textContent).not.toContain("No site details recorded");
    expect(sourceOf("Path")).toBe("recorded-only");
  });

  it("под снимком фразы не бывает: пустое поле списка само говорит «not read»", () => {
    show({ fp_facts: facts({ databases: [], ftp_accounts: [] }), fp_facts_at: ago(HOUR) });
    expect(screen.getByRole("group", { name: "Site" }).textContent).not.toContain(
      "No site details recorded",
    );
  });

  it("факты без отметки времени не печатаются вопреки легенде", () => {
    // Пара «`fp_facts` есть, `fp_facts_at` нет» бэкендом не производится (обе
    // колонки пишутся одной транзакцией), но если разъедется — секция не должна
    // сказать «ещё не читали» и тут же напечатать список аккаунтов сервера.
    show({ fp_facts: facts(), fp_facts_at: null });
    expect(screen.getByText(/Сервер ещё не читали/)).toBeTruthy();
    expect(screen.queryByText("Accounts on server")).toBeNull();
    expect(screen.queryByText("8.2 · php-fpm")).toBeNull();
  });

  it("домен без сервера: Host остаётся прочерком", () => {
    // Единственный прочерк, который тут законен: адрес FTP-хоста — это IP
    // сервера, и его отсутствие значит «сервера у домена нет», а не «не читали».
    // `show` подставляет сервер по умолчанию, поэтому рендерим напрямую.
    render(
      <QueryClientProvider client={queryClient}>
        <DomainServerTab domain={domain({ server_id: null, ftp_user: null })} server={undefined} now={Date.now()} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Host").parentElement?.textContent).toContain("—");
  });
});

describe("пустой список фактов — незнание, а не измеренная пустота", () => {
  // Тот же вердикт, что выносит `compareInList` в `lib/domainDrift`: провод
  // схлопывает в `[]` и «на сервере правда пусто», и упавшую команду, и слабый
  // mysql-фолбэк. Прочерк читался бы как «спросили, там пусто» — то есть один
  // и тот же ответ сервера получал бы на экране и в правиле разные вердикты.
  const empty = { fp_facts: facts({ databases: [], ftp_accounts: [] }), fp_facts_at: ago(HOUR) };

  it("баз не прочитали и своей записи нет — «not read», а не прочерк", () => {
    show(empty);
    expect(rowText("Databases")).toContain("not read");
    expect(rowText("Databases")).not.toContain("—");
  });

  it("аккаунтов FTP не прочитали и своей записи нет — «not read», а не прочерк", () => {
    show({ ...empty, ftp_user: null });
    expect(rowText("Login")).toContain("not read");
    expect(rowText("Login")).not.toContain("—");
  });

  it("своя запись есть — она и становится значением, расхождением её не объявляют", () => {
    show({ ...empty, db_name: "example_db", ftp_user: "example_ftp" });
    expect(sourceOf("Databases")).toBe("recorded-only");
    expect(sourceOf("Login")).toBe("recorded-only");
    expect(screen.queryByText(/при развёртывании/)).toBeNull();
    // Здесь подпись печатается у поля: снимок ЕСТЬ, легенды над сеткой нет, и
    // сказать «этого мы не прочитали» больше негде.
    expect(screen.getAllByText("из provision, на сервере не проверено")).toHaveLength(2);
  });
});

describe("DB user", () => {
  it("наша запись есть — поле показано с подписью «на сервере не проверено»", () => {
    // Пользователей баз FastPanel CLI не отдаёт вовсе, поэтому исход всегда
    // `recorded-only`, даже под свежим снимком.
    show({ fp_facts: facts(), fp_facts_at: ago(HOUR), db_user: "example_dbu" });
    expect(screen.getByText("DB user")).toBeTruthy();
    expect(screen.getByText("example_dbu")).toBeTruthy();
    expect(screen.getByText("из provision, на сервере не проверено")).toBeTruthy();
  });

  it("записи нет — строки нет вовсе, а не прочерк: факта тут не бывает никогда", () => {
    show({ fp_facts: facts(), fp_facts_at: ago(HOUR) });
    expect(screen.queryByText("DB user")).toBeNull();
  });
});
