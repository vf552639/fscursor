import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import DesktopWorkspace, {
  FASTPANEL_STEP_LABEL,
  PROVISION_STEP_LABEL,
  WARNING_STEPS,
} from "./DesktopWorkspace";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Владелец результатов provision — `DesktopWorkspace`, и проверяется он здесь
 * целиком, а не через копию проводки: пароли БД и FTP существуют в единственном
 * экземпляре, и вопрос «куда они попадают» решается именно на этом уровне.
 *
 * Две гарантии владельца:
 * 1. Второй результат не затирает первый (очередь показов, а не один слот).
 * 2. Результат provision, запущенного по `sdmp://`-ссылке, тоже доходит до
 *    экрана: в вебе deep link — единственная кнопка provision, а FTP-аккаунт
 *    создаётся на каждом прогоне.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  invokeSynced: vi.fn(),
  onOpenUrl: vi.fn(),
  confirmAction: vi.fn(),
}));

// Подтверждение ссылки спрашивает нативный диалог, а не `window.confirm`:
// последний в десктопном webview не показывает ничего и возвращает `false`
// (см. `lib/confirmDialog.ts`), из-за чего КАЖДАЯ `sdmp://`-ссылка молча
// отменялась. Поэтому здесь мок модуля, а не `stubGlobal("confirm")`: подмена
// глобали проверяла бы путь, которым приложение больше не ходит.
vi.mock("../lib/confirmDialog", () => ({ confirmAction: mocks.confirmAction }));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

// Deep link: настоящий плагин в jsdom не работает, а обработчик ссылки нам
// нужен вживую — забираем его из `onOpenUrl`.
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: async () => [],
  onOpenUrl: mocks.onOpenUrl,
}));
vi.mock("../lib/tauri-invoke", () => ({ invokeIfTauri: vi.fn(async () => null) }));

// Соседние страницы воркспейса: к владению результатами provision отношения не
// имеют, а их деревья тянут пол-приложения.
vi.mock("./Dashboard", () => ({ default: () => null }));
vi.mock("./Servers", () => ({ default: () => null }));
vi.mock("./ServerDetail", () => ({ default: () => null }));
vi.mock("./Cloudflare", () => ({ default: () => null }));
vi.mock("./Activity", () => ({ default: () => null }));
vi.mock("./Notifications", () => ({ default: () => null }));
vi.mock("./Settings", () => ({ default: () => null }));
// Тяжёлые дети самой страницы Domains, которые этот сценарий не открывает.
// `TaskProgressModal` здесь больше не мокается: его единственный импортёр —
// `Activity`, а она сама подменена на `null` строкой выше, так что модуль в этот
// прогон не приезжает вовсе. `RevealSecret` — тем же порядком: его импортируют
// только `ServerDetail` и `Cloudflare`, обе замоканы.
// `DomainDetailModal` больше не заглушка: с фазы 4 редизайна вкладки Domains
// одиночный provision запускается с её вкладки Server, и заглушка вместо
// карточки оставила бы этот файл зелёным при полностью оторванной кнопке.
// `RevealSecret` взамен пришлось замокать явно — прежде он не приезжал вовсе, а
// теперь его тянет карточка FTP внутри вкладки вместе с argon2 и libsodium.
vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));

function domainRow(id: number, name: string) {
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

function result(id: string, password: string) {
  return {
    domain_id: id,
    site_user: `site_${id}`,
    site_path: `/var/www/site_${id}`,
    ssl_issued: true,
    db: {
      status: "created" as const,
      db_name: `db_${id}`,
      db_user: `user_${id}`,
      db_password: password,
    },
    ftp: { status: "created" as const, ftp_user: `ftp_${id}`, ftp_password: `${password}-ftp` },
  };
}

function setTauri(on: boolean) {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown;
  };
  if (!on) {
    delete w.__TAURI_INTERNALS__;
    delete w.__TAURI_EVENT_PLUGIN_INTERNALS__;
    return;
  }
  // Не пустышка: воркспейс подписывается на четыре канала событий настоящим
  // `@tauri-apps/api/event` (замокать его не выходит — динамический импорт
  // внешнего пакета), а тот лезет в `transformCallback`/`invoke`, а на отписке
  // — в `unregisterListener`. Без заглушек подписки падают нераспознанными
  // rejection'ами и пачкают весь прогон.
  w.__TAURI_INTERNALS__ = { transformCallback: () => 1, invoke: async () => 1 };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}

function renderWorkspace(rows: Array<{ id: number; name: string }>) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return rows.map((r) => domainRow(r.id, r.name));
    if (url === "/servers") return { items: [], total: 0 };
    if (url === "/registrars/accounts") return [];
    if (url === "/cloudflare/accounts") return [];
    if (String(url).includes("unread")) return { count: 0 };
    return {};
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <DesktopWorkspace />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/**
 * Открыть карточку домена на вкладке Server — единственный вход в одиночный
 * provision с фазы 4 редизайна вкладки Domains.
 */
async function openServerTab(domain: string) {
  fireEvent.click(await screen.findByRole("button", { name: domain }));
  fireEvent.click(await screen.findByRole("tab", { name: "Server" }));
}

/** Кнопка Provision в шапке снимка на открытой вкладке Server. */
function tabProvisionButton() {
  const line = screen.getByRole("button", { name: "Проверить на сервере" })
    .parentElement as HTMLElement;
  return within(line).getByRole("button", { name: /^Provision(ing…)?$/ }) as HTMLButtonElement;
}

/** Закрыть карточку домена — иначе до строки соседнего не добраться. */
function closeCard() {
  const card = screen
    .getByRole("tablist", { name: "Domain card sections" })
    .closest('[style*="z-index"]') as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "Close" }));
}

/** Запустить provision конкретного домена: карточка → Server → диалог с БД. */
async function provisionRow(domain: string) {
  await openServerTab(domain);
  fireEvent.click(tabProvisionButton());
  // Панель диалога — от чекбокса «создать БД»: он живёт только в диалоге, а
  // `Modal` кладёт детей прямо в панель. Без скоупа кнопка диалога неотличима
  // от кнопки вкладки, оставшейся под ним.
  const cb = await screen.findByLabelText(/Also create a database/i);
  fireEvent.click(cb);
  const dialog = cb.closest("label")!.parentElement as HTMLElement;
  fireEvent.click(within(dialog).getByRole("button", { name: "Provision" }));
  closeCard();
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("sdmp_page", "domains");
  queryClient.clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...base,
    queries: { ...base.queries, retry: false },
    mutations: { ...base.mutations, retry: false },
  });
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  mocks.onOpenUrl.mockResolvedValue(() => {});
  setTauri(true);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  setTauri(false);
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

describe("DesktopWorkspace — владелец результатов provision", () => {
  it("показывает оба результата подряд, не затирая первый", async () => {
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

    await provisionRow("a.com");
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    await provisionRow("b.com");
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(2));

    resolvers["1"](result("1", "PW-A"));
    expect(await screen.findByText("PW-A")).toBeTruthy();

    resolvers["2"](result("2", "PW-B"));
    await waitFor(() =>
      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .filter((m) => m.state.status === "success"),
      ).toHaveLength(2),
    );

    // Пароли `a.com` больше нигде не существуют: сервер их не знает, в кэше
    // мутаций их нет намеренно. Затереть = потерять навсегда, притом что БД и
    // FTP-аккаунт на сервере уже созданы.
    expect(screen.getByText("PW-A")).toBeTruthy();
    expect(screen.getByText("Provisioned a.com")).toBeTruthy();
    expect(screen.queryByText("PW-B")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("PW-B")).toBeTruthy();
    expect(screen.getByText("Provisioned b.com")).toBeTruthy();
  });

  it("показывает результат provision, запущенного по sdmp://-ссылке", async () => {
    mocks.invokeSynced.mockResolvedValue(result("42", "PW-LINK"));
    mocks.confirmAction.mockResolvedValue(true);

    renderWorkspace([{ id: 42, name: "example.com" }]);
    await waitFor(() => expect(mocks.onOpenUrl).toHaveBeenCalled());
    const handler = mocks.onOpenUrl.mock.calls[0][0] as (urls: string[]) => void;

    handler(["sdmp://provision?domainId=42"]);

    // FTP-аккаунт создаётся на каждом не-`site_only` прогоне, и его пароль
    // возвращается только в этом ответе. Отбросить результат = оставить
    // пользователя с аккаунтом, войти в который он не сможет никогда.
    expect(await screen.findByText("PW-LINK-ftp")).toBeTruthy();
    expect(screen.getByText("PW-LINK")).toBeTruthy();
    expect(JSON.stringify(localStorage)).not.toContain("PW-LINK");
    expect(JSON.stringify(sessionStorage)).not.toContain("PW-LINK");
  });

  it("раскладывает по очередям и прогон, запущенный кнопкой тулбара", async () => {
    mocks.invokeSynced.mockResolvedValue({
      idempotency_key: "k-btn",
      status: "ok",
      items: [
        { domain_id: "1", outcome: "done", result: result("1", "PW-A") },
        { domain_id: "2", outcome: "done", result: result("2", "PW-B") },
      ],
    });
    mocks.confirmAction.mockResolvedValue(true);

    const { container } = renderWorkspace([
      { id: 1, name: "a.com" },
      { id: 2, name: "b.com" },
    ]);
    await screen.findByText("a.com");
    fireEvent.click(container.querySelector('thead input[type="checkbox"]') as HTMLInputElement);
    fireEvent.click(await screen.findByRole("button", { name: "Provision" }));

    // У прогона два входа — ссылка и эта кнопка, — а раскладка отчёта обязана
    // быть одна: пропустив половину, воркспейс либо потерял бы пароли FTP, либо
    // не сказал бы, чем кончился прогон. Кнопка тулбара раньше вообще не
    // доходила до Tauri: она била в несуществующий `POST /domains/bulk-provision`.
    expect(await screen.findByText("PW-A-ftp")).toBeTruthy();
    expect(screen.queryByText("PW-B-ftp")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("PW-B-ftp")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(await screen.findByText("Bulk provision finished")).toBeTruthy();
    const report = document.body.textContent ?? "";
    expect(report).toContain("2 provisioned");
    expect(report).toContain("Run key: k-btn");
    expect(report).not.toContain("PW-");
  });

  it("о невыполненной ссылке говорит предупреждением, а не галочкой", async () => {
    renderWorkspace([{ id: 1, name: "a.com" }]);
    await waitFor(() => expect(mocks.onOpenUrl).toHaveBeenCalled());
    const handler = mocks.onOpenUrl.mock.calls[0][0] as (urls: string[]) => void;

    // Ссылку приложение НЕ выполнило: такого хоста нет в `parseDeepLinkAction`.
    // Зелёная галочка ровно здесь означала бы «сделано».
    handler(["sdmp://unknown-thing?id=1"]);

    const toast = await screen.findByRole("alert");
    expect(toast.textContent).toContain("nothing was run");
    expect(toast.textContent).toContain("⚠");
    expect(toast.textContent).not.toContain("✓");
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
  });

  // Полууспехи приходят и шагами прогресса, и каналом аудита, но тон им выбирает
  // один и тот же `showToastAs` — здесь сторожим ВХОД в него: забытая строчка в
  // `WARNING_STEPS` ничего не ломает, она просто выдаёт полууспех за успех.
  it("каждый шаг «сделано, но…» отнесён к предупреждениям", () => {
    const labels = { ...FASTPANEL_STEP_LABEL, ...PROVISION_STEP_LABEL };
    const halfSuccess = Object.entries(labels).filter(([, text]) => text.includes(", but "));
    expect(halfSuccess.length).toBeGreaterThan(0);
    for (const [step] of halfSuccess) {
      expect(WARNING_STEPS.has(step), `${step} должен быть предупреждением`).toBe(true);
    }
    // И встречная сторона: ход дела предупреждением не объявлен.
    expect(WARNING_STEPS.has("ssh_connect")).toBe(false);
    expect(WARNING_STEPS.has("ftp_exists")).toBe(false);
  });

  it("об отказе прогона говорит тостом неудачи, а не зелёной галочкой", async () => {
    mocks.invokeSynced.mockRejectedValue(new Error("keychain is locked"));
    mocks.confirmAction.mockResolvedValue(true);

    renderWorkspace([{ id: 1, name: "a.com" }]);
    await waitFor(() => expect(mocks.onOpenUrl).toHaveBeenCalled());
    const handler = mocks.onOpenUrl.mock.calls[0][0] as (urls: string[]) => void;

    handler(["sdmp://bulk-provision?ids=1"]);

    // Тот же тост — единственная поверхность для отказа прогона, запущенного
    // кнопкой тулбара, если пользователь успел уйти со страницы (проп
    // `onBulkProvisionError`). С общей зелёной галочкой во главе он произносил
    // «✓ keychain is locked».
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("keychain is locked");
    expect(alert.textContent).toContain("✕");
    expect(alert.textContent).not.toContain("✓");
  });

  it("показывает результат каждого домена bulk-провижининга — по одному", async () => {
    mocks.invokeSynced.mockResolvedValue({
      idempotency_key: "k-run",
      status: "failed",
      error: "failed on domain 3: ssh: connect: refused",
      items: [
        { domain_id: "1", outcome: "done", result: result("1", "PW-A") },
        { domain_id: "2", outcome: "done", result: result("2", "PW-B") },
        { domain_id: "3", outcome: "failed", error: "ssh: connect: refused" },
        { domain_id: "4", outcome: "skipped" },
      ],
    });
    mocks.confirmAction.mockResolvedValue(true);

    renderWorkspace([
      { id: 1, name: "a.com" },
      { id: 2, name: "b.com" },
      { id: 3, name: "c.com" },
      { id: 4, name: "d.com" },
    ]);
    await waitFor(() => expect(mocks.onOpenUrl).toHaveBeenCalled());
    const handler = mocks.onOpenUrl.mock.calls[0][0] as (urls: string[]) => void;

    handler(["sdmp://bulk-provision?ids=1,2,3,4"]);

    // Раньше bulk отдавал наружу один ключ идемпотентности, а `Ok` каждого
    // домена отбрасывал: N созданных FTP-аккаунтов и ни одного пароля к ним.
    expect(await screen.findByText("PW-A-ftp")).toBeTruthy();
    // И второй результат не затёрт первым — очередь показов, а не один слот.
    expect(screen.queryByText("PW-B-ftp")).toBeNull();
    // Пользователь видит, что паролей будет несколько и сколько именно.
    expect(screen.getByText(/1 of 2/)).toBeTruthy();
    // И итог не лезет поверх паролей: сначала то, что существует в единственном
    // экземпляре, потом то, что никуда не денется.
    expect(screen.queryByText("Bulk provision stopped")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("PW-B-ftp")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    // Итог прогона дождался, пока прочитают ВСЕ пароли, и требует явного
    // закрытия. Тостом он жил бы 2200 мс под этими самыми модалками, и «прогон
    // оборвался на третьем домене» пользователь не увидел бы никогда.
    expect(await screen.findByText("Bulk provision stopped")).toBeTruthy();
    const report = document.body.textContent ?? "";
    expect(report).toContain("2 provisioned");
    expect(report).toContain("1 not started");
    expect(report).toContain("ssh: connect: refused");
    // Хвост назван поимённо: без id повтор по нему собрать не из чего.
    expect(report).toContain("#4");
    expect(report).toContain("Run key: k-run");
    // И ни одного пароля на экране итога.
    expect(report).not.toContain("PW-");

    expect(JSON.stringify(localStorage)).not.toContain("PW-");
    expect(JSON.stringify(sessionStorage)).not.toContain("PW-");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("Bulk provision stopped")).toBeNull();
  });

  // Установка панели и массовый прогон идут параллельно: гейты посерверные и
  // подоменные. Итог bulk рисуется в JSX позже кред FastPanel и накрыл бы их —
  // пароль панели добыт тридцатиминутной установкой и существует в одном
  // экземпляре, так что читать его пользователь должен первым.
  it("не накрывает итогом креды FastPanel", async () => {
    // Прогон БЕЗ единого удавшегося домена: очередь паролей provision пуста, и
    // итог держит только очередь FastPanel — иначе эта проверка ничего не
    // проверяет (`!provisionQueue.current` закрыл бы её сам).
    mocks.invokeSynced.mockImplementation(async (cmd: string) =>
      cmd === "install_fastpanel"
        ? { server_id: "9", url: "https://h:8888", user: "fp", password: "FP-PW" }
        : {
            idempotency_key: "k-run",
            status: "failed",
            error: "failed on domain 1: ssh: connect: refused",
            items: [{ domain_id: "1", outcome: "failed", error: "ssh: connect: refused" }],
          },
    );
    mocks.confirmAction.mockResolvedValue(true);

    renderWorkspace([{ id: 1, name: "a.com" }]);
    await waitFor(() => expect(mocks.onOpenUrl).toHaveBeenCalled());
    const handler = mocks.onOpenUrl.mock.calls[0][0] as (urls: string[]) => void;

    handler(["sdmp://install-fastpanel?serverId=9", "sdmp://bulk-provision?ids=1"]);

    // Первым — пароль панели: он добыт тридцатиминутной установкой и существует
    // в одном экземпляре, а итог никуда не денется.
    expect(await screen.findByText("FP-PW")).toBeTruthy();
    expect(screen.queryByText("Bulk provision stopped")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Bulk provision stopped")).toBeTruthy();
  });

  it("на время bulk-прогона гасит кнопку provision у каждого домена набора", async () => {
    let finish: (v: unknown) => void = () => {};
    mocks.invokeSynced.mockImplementation(() => new Promise((r) => (finish = r)));
    mocks.confirmAction.mockResolvedValue(true);

    renderWorkspace([
      { id: 1, name: "a.com" },
      { id: 2, name: "b.com" },
      { id: 9, name: "z.com" },
    ]);
    await waitFor(() => expect(mocks.onOpenUrl).toHaveBeenCalled());
    const handler = mocks.onOpenUrl.mock.calls[0][0] as (urls: string[]) => void;

    /**
     * Подпись кнопки provision на карточке домена.
     *
     * Домены проверяются ПО ОЧЕРЕДИ, а не все сразу, и это прямая цена переезда
     * кнопки в карточку (фаза 4): раньше три состояния читались с трёх строк
     * одного экрана, теперь карточка на экране одна. Сам гейт от этого не
     * изменился — он как был подоменным на странице, так и остался.
     */
    const provisionLabelOf = async (name: string) => {
      await openServerTab(name);
      const label = tabProvisionButton().textContent;
      closeCard();
      return label;
    };

    handler(["sdmp://bulk-provision?ids=1,2"]);

    // Клик по кнопке домена, который сейчас идёт в bulk, открыл бы вторую
    // SSH-сессию с create_site/create_ftp_account/certbot по тому же домену.
    await waitFor(async () => expect(await provisionLabelOf("a.com")).toBe("Provisioning…"));
    expect(await provisionLabelOf("b.com")).toBe("Provisioning…");
    // Домен вне набора не тронут — гейт подоменный, а не глобальный.
    expect(await provisionLabelOf("z.com")).toBe("Provision");

    finish({ idempotency_key: "k", status: "ok", items: [] });

    // И отпущен после прогона — иначе кнопка не включится уже никогда.
    await waitFor(async () => expect(await provisionLabelOf("a.com")).toBe("Provision"));
  });
});
