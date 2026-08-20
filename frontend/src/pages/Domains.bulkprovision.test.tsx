import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { describeBulkProvision } from "../components/domains/describeBulkProvision";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";
import { closeDomainCard, confirmProvision, openProvisionDialog } from "../test/domainCard";

/**
 * Кнопка «Provision» панели массовых действий.
 *
 * Она била в `POST /domains/bulk-provision`, которого на бэкенде нет, — то есть
 * всегда возвращала 404. Транспорт тут ни при чём: в Tauri `apiPost` уходит не
 * в axios, а в команду `api_request` (`api/client.ts`), но та проксирует к тому
 * же REST API — 404 одинаково в вебе и в десктопе. Рабочий путь один и он же у
 * ссылки `sdmp://bulk-provision`: Tauri-команда `provision_bulk` через
 * `runBulkProvisionDomains`.
 *
 * Проверяется ровно то, что ломалось: вызов уходит командой, а не по HTTP;
 * отчёт (в нём пароли FTP каждого домена) доезжает наверх, а не оседает на
 * размонтирующейся странице; отказ запуска произносится словами.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  invokeSynced: vi.fn(),
  confirmAction: vi.fn(),
}));

// Подтверждение спрашивает нативный диалог, а не `window.confirm`: последний в
// десктопном webview молча возвращает `false` (см. `lib/confirmDialog.ts`).
// Поэтому мок модуля, а не `stubGlobal("confirm")` — подмена глобали проверяла
// бы путь, которым приложение не ходит.
vi.mock("../lib/confirmDialog", () => ({ confirmAction: mocks.confirmAction }));

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

// Тяжёлые соседи страницы, которых этот сценарий не открывает вовсе.
//
// `DomainDetailModal` из этого списка ушёл: одиночный provision запускается с её
// вкладки Server (фаза 4 редизайна вкладки Domains), а сюда он приезжает как
// СПОСОБ ЗАНЯТЬ ГЕЙТ — проверять массовый прогон против заглушки было бы
// проверкой заглушки. `RevealSecret` взамен замокан: карточка FTP внутри
// вкладки тянет argon2 и libsodium, а расшифровка пароля к этому файлу
// отношения не имеет.
vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));

const FTP_PASSWORD_1 = "ftp-pw-A1-secret";
const FTP_PASSWORD_2 = "ftp-pw-B2-secret";

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

function doneItem(id: string, password: string) {
  return {
    domain_id: id,
    outcome: "done" as const,
    result: {
      domain_id: id,
      site_user: `site_${id}`,
      site_path: `/var/www/site_${id}`,
      ssl_issued: true,
      ftp: { status: "created" as const, ftp_user: `ftp_${id}`, ftp_password: password },
    },
  };
}

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function renderPage(
  onBulkProvisionResult: (r: any) => void = vi.fn(),
  onBulkProvisionError: (m: string) => void = vi.fn(),
) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return [domainRow(1, "a.com"), domainRow(2, "b.com")];
    if (url === "/servers") return { items: [], total: 0 };
    if (url === "/registrars/accounts") return [];
    if (url === "/cloudflare/accounts") return [];
    return {};
  });
  // Страницу рендерим на СИНГЛТОНЕ `queryClient`: в нём живёт подоменный гейт
  // (`PROVISION_DOMAIN_KEY` в MutationCache), который занимает и читает массовый
  // прогон. Со своим клиентом утверждения про гейт были бы зелены вхолостую.
  return render(
    <QueryClientProvider client={queryClient}>
      <Domains
        onProvisionResult={vi.fn()}
        onBulkProvisionResult={onBulkProvisionResult}
        onBulkProvisionError={onBulkProvisionError}
        onCloudflareBindNotice={vi.fn()}
        onFullSetupNotice={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

/**
 * Запустить одиночный provision: карточка домена → вкладка Server → «Provision»
 * → диалог → «Provision».
 *
 * Дорога длинная, потому что вход в одиночный прогон ровно один и он там
 * (фаза 4). Сами шаги — из общего `test/domainCard`, а не своей копией: их
 * хрупкая часть (скоуп по вёрстке) обязана быть одна на все три файла, которые
 * этой дорогой ходят.
 *
 * Карточка в конце ЗАКРЫВАЕТСЯ, и это не уборка: пока она открыта, на экране
 * две кнопки с именем «Provision» — её и тулбара, — и `getByRole` в
 * `selectAllAndFindProvision` нашёл бы обе.
 */
async function startSingleProvision(domain: string) {
  const cb = await openProvisionDialog(domain);
  confirmProvision(cb);
  closeDomainCard();
}

/** Выделить оба домена шапочным чекбоксом и вернуть кнопку «Provision» тулбара. */
async function selectAllAndFindProvision(container: HTMLElement) {
  await screen.findByText("a.com");
  const all = container.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
  fireEvent.click(all);
  await screen.findByText("2 selected");
  return screen.getByRole("button", { name: "Provision" }) as HTMLButtonElement;
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  queryClient.clear();
  queryClient.getMutationCache().clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...base,
    queries: { ...base.queries, retry: false },
    mutations: { ...base.mutations, retry: false },
  });
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  // По умолчанию пользователь подтверждает — иначе каждый тест проверял бы
  // только гейт подтверждения. Отказ проверяется отдельным кейсом.
  mocks.confirmAction.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  queryClient.getMutationCache().clear();
  setTauri(false);
  useAuthStore.getState().clear();
});

describe("Domains — массовый provision из тулбара", () => {
  it("зовёт команду provision_bulk, а не несуществующий HTTP-роут", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue({
      idempotency_key: "key-1",
      status: "ok",
      items: [doneItem("1", FTP_PASSWORD_1), doneItem("2", FTP_PASSWORD_2)],
    });

    const { container } = renderPage();
    fireEvent.click(await selectAllAndFindProvision(container));

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    // Полная форма аргументов: id команда принимает СТРОКАМИ, а `userId` нужен
    // ей, чтобы расшифровать креды серверов.
    expect(mocks.invokeSynced).toHaveBeenCalledWith("provision_bulk", {
      userId: "user-1",
      domainIds: ["1", "2"],
    });
    expect(
      mocks.apiPost.mock.calls.some((c: any[]) => String(c[0]).includes("provision")),
    ).toBe(false);
  });

  it("отдаёт отчёт наверх и не оставляет паролей ни на странице, ни в кэше мутаций", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue({
      idempotency_key: "key-1",
      status: "ok",
      items: [doneItem("1", FTP_PASSWORD_1), doneItem("2", FTP_PASSWORD_2)],
    });
    const onBulk = vi.fn();

    const { container } = renderPage(onBulk);
    fireEvent.click(await selectAllAndFindProvision(container));

    // Пароль FTP каждого домена существует ТОЛЬКО в этом ответе: сервер их не
    // знает. Показывает их не страница (она размонтируется при уходе), а
    // очередь показов воркспейса — значит отчёт обязан доехать до пропа целиком.
    await waitFor(() => expect(onBulk).toHaveBeenCalledTimes(1));
    const outcome = onBulk.mock.calls[0][0];
    expect(outcome.status).toBe("ok");
    expect(outcome.idempotencyKey).toBe("key-1");
    expect(outcome.results.map((r: any) => r.domain)).toEqual(["#1", "#2"]);
    expect(outcome.results[0].result.ftp.ftp_password).toBe(FTP_PASSWORD_1);

    // Путь намеренно не идёт через `mutate`: возврат `mutationFn` осел бы в
    // `data` MutationCache, откуда его не убирает даже `reset()`.
    const cacheDump = JSON.stringify(
      queryClient.getMutationCache().getAll().map((m) => m.state),
    );
    for (const secret of [FTP_PASSWORD_1, FTP_PASSWORD_2]) {
      expect(container.innerHTML).not.toContain(secret);
      expect(cacheDump).not.toContain(secret);
      expect(JSON.stringify(localStorage)).not.toContain(secret);
      expect(JSON.stringify(sessionStorage)).not.toContain(secret);
    }

    // Набор сбрасывается: те же домены во второй раз — это `already_ran`.
    await waitFor(() => expect(screen.queryByText("2 selected")).toBeNull());
  });

  it("доставляет отчёт даже если страницу успели размонтировать", async () => {
    setTauri(true);
    let finish: (r: unknown) => void = () => {};
    mocks.invokeSynced.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onBulk = vi.fn();

    const { container } = renderPage(onBulk);
    fireEvent.click(await selectAllAndFindProvision(container));
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    // Прогон идёт минутами на КАЖДЫЙ домен — уход со страницы за это время
    // обычное дело. Отчёт уезжает наверх прямым вызовом пропа, а не через
    // per-call коллбэк мутации, который react-query глушит при размонтировании.
    cleanup();
    finish({
      idempotency_key: "key-1",
      status: "ok",
      items: [doneItem("1", FTP_PASSWORD_1), doneItem("2", FTP_PASSWORD_2)],
    });

    await waitFor(() => expect(onBulk).toHaveBeenCalledTimes(1));
    expect(onBulk.mock.calls[0][0].results).toHaveLength(2);
  });

  it("показывает отказ запуска, а не проглатывает его", async () => {
    setTauri(true);
    mocks.invokeSynced.mockReturnValue(new Promise(() => {}));

    const { container } = renderPage();
    // Одиночный provision по a.com — тот самый случай, ради которого гейт
    // подоменный: пока он идёт, набор, в который входит этот домен, стартовать
    // не должен. Молчащая кнопка неотличима от сломанной, поэтому текст обязан
    // доехать до пользователя.
    await startSingleProvision("a.com");
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    fireEvent.click(await selectAllAndFindProvision(container));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/already running/i);
    expect(alert.textContent).toMatch(/#1/);
    // И по SSH второй раз никто не пошёл.
    expect(mocks.invokeSynced).toHaveBeenCalledTimes(1);
  });

  it("отказ, прилетевший после ухода со страницы, уходит наверх, а не в мёртвый стейт", async () => {
    setTauri(true);
    let fail: (e: Error) => void = () => {};
    mocks.invokeSynced.mockReturnValue(new Promise((_res, rej) => { fail = rej; }));
    const onError = vi.fn();

    const { container } = renderPage(vi.fn(), onError);
    fireEvent.click(await selectAllAndFindProvision(container));
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    // Уйти смотреть тосты по шагам прогона — нормальное поведение, а страница
    // размонтируется на любой навигации. Отказ, положенный в её стейт, не увидит
    // никто: пользователь вернётся к обычной странице в уверенности, что прогон
    // идёт, хотя не стартовал ни один домен.
    cleanup();
    fail(new Error("keychain is locked"));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("keychain is locked"));
  });

  it("показывает отказ, прилетевший уже после старта", async () => {
    setTauri(true);
    mocks.invokeSynced.mockRejectedValue(new Error("ssh: handshake failed"));

    const { container } = renderPage();
    fireEvent.click(await selectAllAndFindProvision(container));

    // Отказ ПОСЛЕ старта (сорвался `invokeSynced`) — не то же самое, что отказ
    // гейта до старта: он приходит другим путём и раньше терялся бы так же молча.
    expect((await screen.findByRole("alert")).textContent).toMatch(/handshake failed/);
    // Набор не тронут: повторять прогон пользователю по этим же доменам.
    expect(screen.getByText("2 selected")).toBeTruthy();
  });

  it("без userId не зовёт команду и говорит почему", async () => {
    setTauri(true);
    useAuthStore.getState().clear();

    const { container } = renderPage();
    fireEvent.click(await selectAllAndFindProvision(container));

    expect((await screen.findByRole("alert")).textContent).toMatch(/sign in/i);
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    // Спрашивать подтверждение, когда запускать всё равно нечем, незачем.
    expect(mocks.confirmAction).not.toHaveBeenCalled();
  });

  it("гасит отказ, когда набор, к которому он относился, изменили", async () => {
    setTauri(true);
    mocks.invokeSynced.mockRejectedValue(new Error("ssh: handshake failed"));

    const { container } = renderPage();
    fireEvent.click(await selectAllAndFindProvision(container));
    expect((await screen.findByRole("alert")).textContent).toMatch(/handshake failed/);

    // «Provisioning of #1, #2 is already running» после снятия галочек с #1 и #2
    // говорит уже не про то, что пользователь видит перед собой.
    fireEvent.click(container.querySelector('tbody input[type="checkbox"]') as HTMLInputElement);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("Domains — массовый provision: подтверждение", () => {
  it("спрашивает перед запуском и называет домены поимённо", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue({ idempotency_key: "k", status: "ok", items: [] });

    const { container } = renderPage();
    fireEvent.click(await selectAllAndFindProvision(container));

    await waitFor(() => expect(mocks.confirmAction).toHaveBeenCalledTimes(1));
    const text = String(mocks.confirmAction.mock.calls[0][0]);
    // Промах мимо соседней кнопки («Assign Server» стоит рядом) стоил бы часов
    // необратимой работы: остановить прогон нечем, а идемпотентность после него
    // пометит набор отработавшим.
    expect(text).toContain("Provision 2 domain(s)?");
    expect(text).toContain("a.com, b.com");
    expect(text).toMatch(/cannot be stopped/i);
  });

  it("на сотне доменов не превращает диалог в стену текста", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, domain: `d${i + 1}.com` }));
    const text = describeBulkProvision(many as any, many.map((d) => d.id));

    // Диалог, который нельзя прочитать, закрывают не читая — а это ровно тот
    // диалог, который должен остановить случайный запуск.
    expect(text).toContain("Provision 100 domain(s)?");
    expect(text).toContain("d1.com");
    expect(text).toContain("d20.com");
    expect(text).not.toContain("d21.com");
    expect(text).toContain("(+80 more)");
  });

  it("двойной клик не открывает второй диалог и не рисует ложное «уже провижинится»", async () => {
    setTauri(true);
    let allow: (v: boolean) => void = () => {};
    mocks.confirmAction.mockReturnValue(new Promise<boolean>((resolve) => { allow = resolve; }));
    mocks.invokeSynced.mockResolvedValue({
      idempotency_key: "k",
      status: "ok",
      items: [doneItem("1", FTP_PASSWORD_1), doneItem("2", FTP_PASSWORD_2)],
    });

    const { container } = renderPage();
    const btn = await selectAllAndFindProvision(container);
    // Пока грузится чанк нативного диалога, кнопка ничем не занята и выглядит
    // неотзывчивой — по такой кликают второй раз.
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(mocks.confirmAction).toHaveBeenCalledTimes(1));

    allow(true);

    // Подтверждённый дважды прогон стартовал бы один раз (гейт подоменный), но
    // второй вызов упирался бы в него и вешал красное «уже провижинится» поверх
    // прекрасно идущего прогона — вместе с модалками паролей от него же.
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("отказ в подтверждении не запускает ничего", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(false);

    const { container } = renderPage();
    fireEvent.click(await selectAllAndFindProvision(container));

    await waitFor(() => expect(mocks.confirmAction).toHaveBeenCalledTimes(1));
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    // И набор на месте: пользователь передумал, а не выполнил.
    expect(screen.getByText("2 selected")).toBeTruthy();
  });
});

describe("Domains — массовый provision: набор и повтор", () => {
  it("оборвавшийся прогон оставляет набор выделенным", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue({
      idempotency_key: "key-1",
      status: "failed",
      error: "failed on domain 2: ssh: connect: refused",
      items: [
        doneItem("1", FTP_PASSWORD_1),
        { domain_id: "2", outcome: "skipped" as const },
      ],
    });
    const onBulk = vi.fn();

    const { container } = renderPage(onBulk);
    fireEvent.click(await selectAllAndFindProvision(container));
    await waitFor(() => expect(onBulk).toHaveBeenCalledTimes(1));

    // Хвост (`skipped`) назван поимённо ровно затем, чтобы прогон повторили по
    // нему. Сняв выделение, страница заставила бы разыскивать эти домены заново
    // в списке на двести строк.
    expect(screen.getByText("2 selected")).toBeTruthy();
  });

  it("про already_ran отдаёт отчёт наверх, а не молчит", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue({
      idempotency_key: "key-1",
      status: "already_ran",
      previous_status: "done",
      items: [
        { domain_id: "1", outcome: "skipped" as const },
        { domain_id: "2", outcome: "skipped" as const },
      ],
    });
    const onBulk = vi.fn();

    const { container } = renderPage(onBulk);
    fireEvent.click(await selectAllAndFindProvision(container));

    // Пустой успех выглядел бы как «готово», хотя не тронут ни один домен и
    // пароли прошлого прогона показать уже некому. Различает `running` и `done`
    // текст `summarizeBulkProvision`, который рисует отчёт воркспейса.
    await waitFor(() => expect(onBulk).toHaveBeenCalledTimes(1));
    expect(onBulk.mock.calls[0][0].status).toBe("already_ran");
    expect(onBulk.mock.calls[0][0].previousStatus).toBe("done");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("идущий прогон не гасит соседние массовые действия", async () => {
    setTauri(true);
    mocks.invokeSynced.mockReturnValue(new Promise(() => {}));

    const first = renderPage();
    fireEvent.click(await selectAllAndFindProvision(first.container));
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    // Признак «идёт прогон» живёт в MutationCache: он держится десятками минут,
    // переживает навигацию и истинен даже для прогона по СОВЕРШЕННО ДРУГИМ
    // доменам, запущенного ссылкой. Гасить им «Assign Server»/«Assign CF»
    // значит оставить пользователя перед двумя мёртвыми кнопками без единого
    // объяснения — рядом с живой «Delete».
    cleanup();
    const second = renderPage();
    const provision = await selectAllAndFindProvision(second.container);
    expect(provision.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Assign Server" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Assign CF" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("после ухода со страницы и возврата не даёт запустить второй прогон", async () => {
    setTauri(true);
    mocks.invokeSynced.mockReturnValue(new Promise(() => {}));

    const first = renderPage();
    fireEvent.click(await selectAllAndFindProvision(first.container));
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    // Страница размонтируется на любой навигации, а прогон идёт десятками минут.
    // Локальный флаг «идёт прогон» воскресал бы в `false`, и кнопка снова
    // выглядела бы рабочей — второй прогон по ДРУГИМ доменам подоменный гейт
    // при этом не остановил бы вовсе.
    cleanup();
    const second = renderPage();
    const btn = await selectAllAndFindProvision(second.container);
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(mocks.invokeSynced).toHaveBeenCalledTimes(1);
  });
});

describe("Domains — массовый provision: веб", () => {
  it("отдаёт deep link sdmp://bulk-provision и ничего не исполняет", async () => {
    setTauri(false);

    const { container } = renderPage();
    await screen.findByText("a.com");
    const all = container.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(all);
    await screen.findByText("2 selected");

    const link = container.querySelector('a[href^="sdmp://bulk-provision"]');
    expect(link?.getAttribute("href")).toBe("sdmp://bulk-provision?ids=1,2");
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    expect(
      mocks.apiPost.mock.calls.some((c: any[]) => String(c[0]).includes("provision")),
    ).toBe(false);
  });

  it("не предлагает Refresh SSL и Full Setup — роутов под ними нет", async () => {
    for (const tauri of [false, true]) {
      setTauri(tauri);
      const { container, unmount } = renderPage();
      await screen.findByText("a.com");
      fireEvent.click(container.querySelector('thead input[type="checkbox"]') as HTMLInputElement);
      await screen.findByText("2 selected");

      // `POST /domains/{id}/refresh-ssl` и `/domains/bulk-full-setup` на бэкенде
      // не существуют, а `sdmp://refresh-ssl` и `sdmp://bulk-full-setup` не
      // разбирает parseDeepLinkAction — обе кнопки вели в никуда в обеих средах.
      // Появившийся `POST /domains/full-setup` (другой путь!) этого не меняет:
      // он проставляет связки, а зону и NS выполняет десктопная команда,
      // которой пока нет. Кнопка вернётся вместе с ней.
      expect(screen.queryByText("Refresh SSL")).toBeNull();
      expect(screen.queryByText("Full Setup")).toBeNull();
      expect(container.querySelectorAll('a[href^="sdmp://refresh-ssl"]').length).toBe(0);
      expect(container.querySelectorAll('a[href^="sdmp://bulk-full-setup"]').length).toBe(0);
      unmount();
    }
  });
});
