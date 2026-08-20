import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { ProvisionResultModal } from "../components/ProvisionResultModal";
import { useShowOnceQueue } from "../hooks/useShowOnceQueue";
import { handleSdmpDeepLinkInTauri } from "../lib/deepLink";
import { queryClient } from "../api/queryClient";
import type { ProvisionOutcome } from "../api/domains";
import { useAuthStore } from "../store/auth";

/**
 * Provision одного домена — весь путь от кнопки до аргументов команды.
 *
 * Путь сменился (редизайн вкладки Domains, фаза 4): из строки списка provision
 * ушёл, вход один — карточка домена → вкладка Server → «Provision». Иконка ⚙ в
 * строке при этом есть, но развёртывания она больше не запускает: она
 * открывает ту же карточку («Open domain settings»). Гарантии от переезда не
 * изменились ни одной, и переписаны тесты именно так, чтобы это было видно: те
 * же четыре утверждения, другая дорога до кнопки.
 *
 * 1. Опциональная БД достижима из UI: чекбокс диалога доезжает до `invoke`
 *    аргументом `withDb`, причём в обе стороны (включённый и выключенный).
 * 2. Пароли БД и FTP не оседают в MutationCache: `mutationFn` отдаёт их
 *    колбэком, а наружу возвращает только несекретный минимум.
 * 3. Результат не теряется при размонтировании страницы: колбэк захвачен
 *    замыканием `mutationFn`, а не передан per-call через `mutate(…, {onSuccess})`,
 *    который react-query глушит через `hasListeners()`.
 * 4. Диалог доступен ПОВЕРХ карточки: у обеих модалок `zIndex:100`, и порядок в
 *    разметке страницы — единственное, что решает, кто кого перекрывает.
 *
 * Карточка домена здесь НЕ замокана, в отличие от соседних сценариев страницы:
 * с заглушкой вместо неё эти тесты проверяли бы заглушку, а именно на дороге
 * «строка → карточка → вкладка → кнопка» и живёт единственный вход в диалог с
 * галочкой «создать БД».
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  invokeSynced: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiPut: mocks.apiPut,
  apiDelete: mocks.apiDelete,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

// Тяжёлые соседи страницы, которых этот сценарий не открывает вовсе. Их деревья
// (crypto, argon2, поллинг задач) к provision отношения не имеют, а импорт стоит
// времени всему прогону — файл и так поднимает страницу целиком.
//
// `DomainDetailModal` в этом списке БОЛЬШЕ НЕТ и быть не должен: с фазы 4 вход в
// provision живёт на её вкладке Server, и заглушка вместо карточки оставила бы
// весь файл зелёным при полностью оторванной кнопке. `RevealSecret` остаётся
// замоканным — карточка FTP внутри вкладки тащит за собой argon2 и libsodium, а
// расшифровка пароля к provision отношения не имеет.
vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));

const DB_PASSWORD = "db-pw-Nx9-secret";
const FTP_PASSWORD = "ftp-pw-Qz4-secret";

const PROVISION_RESULT = {
  domain_id: "42",
  site_user: "example_com",
  site_path: "/var/www/example_com",
  ssl_issued: true,
  db: {
    status: "created" as const,
    db_name: "example_db",
    db_user: "example_user",
    db_password: DB_PASSWORD,
  },
  ftp: { status: "created" as const, ftp_user: "example_ftp", ftp_password: FTP_PASSWORD },
};

function domainRow(id = 42, name = "example.com") {
  return {
    id,
    domain_name: name,
    status: "new",
    registrar_id: null,
    server_id: 5,
    cloudflare_account_id: null,
    cloudflare_zone_id: null,
    cloudflare_enabled: false,
    expiry_date: null,
    purchase_date: null,
    ns_status: "pending",
    ns_updated_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function renderPage(onProvisionResult: (r: any) => void = vi.fn()) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return [domainRow()];
    if (url === "/servers") return { items: [], total: 0 };
    if (url === "/registrars/accounts") return [];
    if (url === "/cloudflare/accounts") return [];
    return {};
  });
  // Страницу рендерим на СИНГЛТОНЕ `queryClient`: именно его инвалидируют хуки
  // и в нём же лежат мутации, за которыми следит `useMutationState`. Со своим
  // клиентом утверждения про кэш мутаций были бы зелены вхолостую.
  const ui = (
    <QueryClientProvider client={queryClient}>
      <Domains onProvisionResult={onProvisionResult} onBulkProvisionResult={vi.fn()} onBulkProvisionError={vi.fn()} onCloudflareBindNotice={vi.fn()} onFullSetupNotice={vi.fn()} />
    </QueryClientProvider>
  );
  // `remount` — уход со страницы и возврат: тот же клиент, новый `Domains`.
  const remount = () => {
    cleanup();
    return render(ui);
  };
  return { remount, ...render(ui) };
}

/**
 * Владелец результатов — копия проводки `DesktopWorkspace`: очередь показов и
 * модалка живут НАД страницей, потому что страница размонтируется, а результат
 * существует в единственном экземпляре.
 */
function Workspace({ rows }: { rows: Array<{ id: number; name: string }> }) {
  const queue = useShowOnceQueue<ProvisionOutcome>();
  return (
    <QueryClientProvider client={queryClient}>
      <Domains onProvisionResult={queue.push} onBulkProvisionResult={vi.fn()} onBulkProvisionError={vi.fn()} onCloudflareBindNotice={vi.fn()} onFullSetupNotice={vi.fn()} />
      {queue.current && (
        <ProvisionResultModal
          domain={queue.current.domain}
          result={queue.current.result}
          onClose={queue.dismiss}
        />
      )}
      <span data-testid="rows">{rows.length}</span>
    </QueryClientProvider>
  );
}

function renderWorkspace(rows: Array<{ id: number; name: string }>) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return rows.map((r) => domainRow(r.id, r.name));
    if (url === "/servers") return { items: [], total: 0 };
    if (url === "/registrars/accounts") return [];
    if (url === "/cloudflare/accounts") return [];
    return {};
  });
  return render(<Workspace rows={rows} />);
}

/**
 * Открыть карточку домена на вкладке Server — единственный вход в provision с
 * фазы 4. Имя домена в строке — кнопка, вкладки карточки — настоящий `tablist`.
 */
async function openServerTab(domain = "example.com") {
  fireEvent.click(await screen.findByRole("button", { name: domain }));
  fireEvent.click(await screen.findByRole("tab", { name: "Server" }));
}

/** Кнопка Provision на открытой вкладке Server. */
function tabProvisionButton() {
  const line = screen.getByRole("button", { name: "Проверить на сервере" }).parentElement!;
  return within(line).getByRole("button", { name: /^Provision(ing…)?$/ }) as HTMLButtonElement;
}

/** Открыть диалог provision у единственной строки таблицы. Возвращает чекбокс БД. */
async function openProvisionDialog(domain = "example.com") {
  await openServerTab(domain);
  fireEvent.click(tabProvisionButton());
  return (await screen.findByLabelText(/Also create a database/i)) as HTMLInputElement;
}

/**
 * Панель открытого диалога provision.
 *
 * Скоуп обязателен, и это не придирка к тесту, а прямое следствие переезда:
 * диалог открывается ПОВЕРХ карточки, кнопка «Provision» вкладки Server
 * остаётся в DOM, и `getByRole` без скоупа нашёл бы две кнопки с этим именем.
 * Панель берётся от чекбокса «создать БД» — он живёт только в диалоге, а
 * `Modal` кладёт детей прямо в панель, так что родитель его `label` и есть она.
 */
function provisionDialog(cb: HTMLElement): HTMLElement {
  return cb.closest("label")!.parentElement as HTMLElement;
}

/** Нажать «Provision» именно в диалоге. */
function confirmProvision(cb: HTMLElement) {
  fireEvent.click(within(provisionDialog(cb)).getByRole("button", { name: "Provision" }));
}

/**
 * Закрыть карточку домена: без этого до строки соседнего домена не добраться.
 *
 * Крестик ищется ВНУТРИ карточки, а не по всему экрану: «Close» на странице
 * доменов не один (крестики баннеров), и глобальный поиск нашёл бы их все.
 */
function closeCard() {
  const card = screen
    .getByRole("tablist", { name: "Domain card sections" })
    .closest('[style*="z-index"]') as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "Close" }));
}

/** Запустить provision конкретного домена (карточка → Server → диалог → БД → Provision). */
async function provisionRow(domain: string, withDb: boolean) {
  const cb = await openProvisionDialog(domain);
  if (withDb) fireEvent.click(cb);
  confirmProvision(cb);
}

/** Результат provision с узнаваемым паролем БД. */
function resultWithPassword(id: string, password: string) {
  return {
    ...PROVISION_RESULT,
    domain_id: id,
    db: {
      status: "created" as const,
      db_name: `db_${id}`,
      db_user: `user_${id}`,
      db_password: password,
    },
    ftp: { status: "created" as const, ftp_user: `ftp_${id}`, ftp_password: `${password}-ftp` },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  queryClient.clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...base,
    queries: { ...base.queries, retry: false },
    mutations: { ...base.mutations, retry: false },
  });
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
});

afterEach(() => {
  // vitest без `globals: true` не регистрирует авто-cleanup RTL.
  cleanup();
  queryClient.clear();
  setTauri(false);
  useAuthStore.getState().clear();
});

describe("Domains — provision: чекбокс withDb", () => {
  it("с включённым чекбоксом шлёт withDb: true", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue(PROVISION_RESULT);

    renderPage();
    const cb = await openProvisionDialog();
    expect(cb.checked).toBe(false); // БД — осознанный выбор, а не умолчание
    fireEvent.click(cb);
    confirmProvision(cb);

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    // Полная форма аргументов: проверять «вызвано» мало — флаг терялся именно
    // между UI и аргументами.
    expect(mocks.invokeSynced).toHaveBeenCalledWith("provision_domain", {
      userId: "user-1",
      domainId: "42",
      siteOnly: false,
      withDb: true,
    });
  });

  it("с выключенным чекбоксом шлёт withDb: false", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue({ ...PROVISION_RESULT, db: undefined });

    renderPage();
    confirmProvision(await openProvisionDialog());

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    expect(mocks.invokeSynced).toHaveBeenCalledWith("provision_domain", {
      userId: "user-1",
      domainId: "42",
      siteOnly: false,
      withDb: false,
    });
  });

  it("не помнит прошлый выбор: диалог открывается с выключенной БД", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue(PROVISION_RESULT);

    renderPage();
    const cb = await openProvisionDialog();
    fireEvent.click(cb);
    fireEvent.click(within(provisionDialog(cb)).getByRole("button", { name: "Cancel" }));

    // Карточка под диалогом никуда не делась — второй раз в диалог входим прямо
    // с её вкладки Server, и именно так его открывает пользователь.
    fireEvent.click(tabProvisionButton());
    const again = (await screen.findByLabelText(/Also create a database/i)) as HTMLInputElement;
    expect(again.checked).toBe(false);
  });
});

describe("Domains — provision: пароли", () => {
  it("отдаёт результат наверх и не оставляет паролей в кэше мутаций", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue(PROVISION_RESULT);
    const onResult = vi.fn();

    const { container } = renderPage(onResult);
    const cb = await openProvisionDialog();
    fireEvent.click(cb);
    confirmProvision(cb);

    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({ domain: "example.com", result: PROVISION_RESULT }),
    );
    // Показывает креды единственная модалка показа-один-раз, которой владеет
    // DesktopWorkspace, — сама страница их не рендерит и не сохраняет.
    expect(container.innerHTML).not.toContain(DB_PASSWORD);
    expect(JSON.stringify(localStorage)).not.toContain(DB_PASSWORD);
    expect(JSON.stringify(sessionStorage)).not.toContain(FTP_PASSWORD);
    expect(window.location.href).not.toContain(DB_PASSWORD);

    // `return result` из mutationFn положил бы пароли в `data` MutationCache,
    // откуда их не убирает даже reset(): они жили бы там ещё gcTime.
    await waitFor(() =>
      expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe("success"),
    );
    const states = queryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.state);
    expect(JSON.stringify(states)).not.toContain(DB_PASSWORD);
    expect(JSON.stringify(states)).not.toContain(FTP_PASSWORD);
  });

  it("доставляет результат даже если страницу успели размонтировать", async () => {
    setTauri(true);
    let finish: (r: unknown) => void = () => {};
    mocks.invokeSynced.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onResult = vi.fn();

    renderPage(onResult);
    confirmProvision(await openProvisionDialog());
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    // Пользователь ушёл со страницы, пока шёл provision (минуты SSH и certbot).
    cleanup();
    finish(PROVISION_RESULT);

    // Пароли БД и FTP существуют только в этом ответе: на сервере их нет по
    // определению. Потерянный колбэк = потерянные навсегда пароли.
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({ domain: "example.com", result: PROVISION_RESULT }),
    );
  });
});

describe("Domains — provision: повторный запуск", () => {
  it("после ухода со страницы и возврата не даёт запустить второй provision", async () => {
    setTauri(true);
    mocks.invokeSynced.mockReturnValue(new Promise(() => {}));

    const { remount } = renderPage();
    confirmProvision(await openProvisionDialog());
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    remount();

    // Карточка после перемонтирования закрыта — открываем заново тем же путём,
    // каким её открывает вернувшийся пользователь.
    await openServerTab();

    // Летящую мутацию новая страница находит по mutationKey в MutationCache:
    // без ключа перемонтированный observer её не видит, и второй клик запустил
    // бы вторую SSH-сессию с create_site/create_ftp_account/certbot.
    const btn = tabProvisionButton();
    expect(btn.textContent).toBe("Provisioning…");
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(mocks.invokeSynced).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText(/Also create a database/i)).toBeNull();
  });
});

describe("Domains — provision: web", () => {
  it("в вебе одиночного provision нет ни кнопкой, ни ссылкой", async () => {
    setTauri(false);
    const { container } = renderPage();

    // Строка потеряла и кнопку запуска (ей была иконка ⚙ с именем «Provision
    // domain»), и ссылку `sdmp://provision?domainId=…`, стоявшую рядом с ней
    // в вебе. Ссылку не «забыли перенести»: хост `provision` у
    // `parseDeepLinkAction` знает единственный параметр `domainId` и `with_db`
    // не принимает, то есть рядом с галочкой «создать БД» она обещала бы выбор,
    // который десктоп молча проглотит. Массовая ссылка на месте и по одному
    // домену работает — см. `BulkActionToolbar`.
    await screen.findByText("example.com");
    expect(container.querySelector('a[href^="sdmp://provision"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Provision domain" })).toBeNull();

    // И на карточке кнопки нет: прогон идёт по SSH, а веб не выполняет ничего.
    await openServerTab();
    expect(screen.queryByRole("button", { name: "Provision" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Проверить на сервере" })).toBeNull();

    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    expect(
      mocks.apiPost.mock.calls.some((c: any[]) => String(c[0]).includes("provision")),
    ).toBe(false);
  });
});

describe("Domains — provision: два домена подряд", () => {
  it("второй результат не затирает первый — показаны оба", async () => {
    setTauri(true);
    const resolvers: Record<string, (v: unknown) => void> = {};
    mocks.invokeSynced.mockImplementation(
      (_cmd: string, args: any) =>
        new Promise((resolve) => {
          resolvers[args.domainId] = resolve;
        }),
    );

    renderWorkspace([
      { id: 1, name: "a.com" },
      { id: 2, name: "b.com" },
    ]);

    await provisionRow("a.com", true);
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    // Карточка a.com осталась открытой поверх списка — до строки b.com иначе не
    // добраться. Это и есть цена переезда кнопки на карточку, и платится она
    // ровно здесь, в сценарии «два домена подряд».
    closeCard();
    // Гейт подоменный: второй домен запускается, пока идёт первый. Это
    // намеренно — но именно поэтому приёмник результата обязан быть очередью.
    await provisionRow("b.com", true);
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(2));

    resolvers["1"](resultWithPassword("1", "PW-A"));
    expect(await screen.findByText("PW-A")).toBeTruthy();
    expect(screen.getByText("Provisioned a.com")).toBeTruthy();

    resolvers["2"](resultWithPassword("2", "PW-B"));
    await waitFor(() =>
      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .filter((m) => m.state.status === "success"),
      ).toHaveLength(2),
    );

    // Пароли `a.com` существуют только на экране: сервер их не знает, в кэше
    // мутаций их нет. Перезаписать их вторым результатом = потерять навсегда,
    // притом что FTP-аккаунт и БД на сервере уже созданы.
    expect(screen.getByText("PW-A")).toBeTruthy();
    expect(screen.getByText("Provisioned a.com")).toBeTruthy();
    expect(screen.queryByText("PW-B")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("PW-B")).toBeTruthy();
    expect(screen.getByText("Provisioned b.com")).toBeTruthy();
  });
});

describe("Domains — provision: deep link", () => {
  it("не запускает вторую операцию по домену, который уже провижинится", async () => {
    setTauri(true);
    mocks.invokeSynced.mockReturnValue(new Promise(() => {}));

    renderPage();
    confirmProvision(await openProvisionDialog());
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    // Парная сторона гейта: кнопку блокирует страница, а ссылка приходит извне
    // и о летящей операции не знает. Rust здесь не страхует — `site_exists` и
    // `ssl_exists` проверяются в начале прогона, то есть до того, как первая
    // попытка что-то создала.
    await expect(
      handleSdmpDeepLinkInTauri("sdmp://provision?domainId=42", "user-1", () => true),
    ).rejects.toThrow(/already running/i);
    expect(mocks.invokeSynced).toHaveBeenCalledTimes(1);
  });

  it("provision из deep link виден странице и гасит кнопку карточки", async () => {
    setTauri(true);
    mocks.invokeSynced.mockReturnValue(new Promise(() => {}));

    renderPage();
    await screen.findByText("example.com");
    // Ссылку обрабатывает DesktopWorkspace, вне рендера страницы. Если этот путь
    // идёт мимо PROVISION_DOMAIN_KEY, страница его не видит, кнопка карточки
    // остаётся активной — клик открыл бы вторую SSH-сессию по тому же домену.
    void handleSdmpDeepLinkInTauri("sdmp://provision?domainId=42", "user-1", () => true);

    await openServerTab();
    const btn = await waitFor(() => {
      const b = tabProvisionButton();
      expect(b.textContent).toBe("Provisioning…");
      return b;
    });
    expect(btn.disabled).toBe(true);
    expect(mocks.invokeSynced).toHaveBeenCalledTimes(1);
  });
});

/**
 * Переезд кнопки на карточку (фаза 4 редизайна вкладки Domains) целиком: вход
 * через вкладку Server, диалог поверх карточки, галочка «создать БД» доезжает
 * до аргументов команды.
 *
 * Отдельным блоком, а не припиской к тестам выше, потому что здесь проверяется
 * то, чего до переезда не существовало как вопроса: диалог теперь открывается
 * НАД другой модалкой, и работает это на одном лишь порядке в разметке.
 */
describe("Domains — provision: диалог поверх карточки", () => {
  it("открывается кнопкой вкладки Server и лежит в DOM ниже карточки", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue(PROVISION_RESULT);

    renderPage();
    const cb = await openProvisionDialog();

    // Ближайшая подложка каждой модалки: `Modal` рисует её инлайновым
    // `zIndex:100`, поэтому ищется она по самому стилю, а не по вёрстке.
    const backdropOf = (el: HTMLElement) => el.closest('[style*="z-index"]') as HTMLElement;
    const cardBackdrop = backdropOf(tabProvisionButton());
    const dialogBackdrop = backdropOf(provisionDialog(cb));

    // Карточка под диалогом ЖИВА — иначе проверка порядка ничего не значила бы.
    expect(cardBackdrop).toBeTruthy();
    expect(dialogBackdrop).not.toBe(cardBackdrop);
    // z-index у обеих один и тот же, и это не совпадение, а свойство `Modal`.
    // Именно поэтому кто кого перекрывает, решает порядок в DOM.
    expect(dialogBackdrop.style.zIndex).toBe(cardBackdrop.style.zIndex);
    // Диалог обязан идти ПОСЛЕ карточки. Подними его в разметке `Domains`
    // выше `DomainDetailModal` — он уедет под карточку: невидимый, а клики
    // соберёт её подложка.
    expect(
      cardBackdrop.compareDocumentPosition(dialogBackdrop) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // И он рабочий: галочка «создать БД» с этой дороги доезжает до команды —
    // ровно то, ради чего кнопку и переносили, а не удаляли вместе со строкой.
    fireEvent.click(cb);
    confirmProvision(cb);
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    expect(mocks.invokeSynced).toHaveBeenCalledWith("provision_domain", {
      userId: "user-1",
      domainId: "42",
      siteOnly: false,
      withDb: true,
    });
  });
});
