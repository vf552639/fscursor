import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainDetailModal from "./DomainDetailModal";
import BulkActionToolbar from "./BulkActionToolbar";
import { NS_DESKTOP_NOTE } from "../api/domains";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * `POST /domains/{id}/set-ns` и `POST /domains/bulk-set-ns` на бэкенде НЕ
 * существуют (в `routes/domains.py` их нет — остались только схемы ответов), так
 * что кнопка «Set NS» до сих пор уходила в 404. Смена NS — исполняющее действие:
 * ключ регистратора расшифровывается на клиенте, значит выполняет её десктоп
 * командой `registrar_set_nameservers`.
 *
 * Главная ловушка формы аргументов: `domain` — это ИМЯ домена (его же
 * регистратор кладёт в `target_id` аудита), а `accountId` — аккаунт
 * РЕГИСТРАТОРА (`domains.registrar_id`), а не Cloudflare. Оба — числа/строки, и
 * перепутанные местами они не упадут ни в тайпчеке, ни в рантайме фронта.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  invokeSynced: vi.fn(),
  /** Чтение реестра идёт мимо локального кэша — своим путём, см. `api/rdap.ts`. */
  invokeIfTauri: vi.fn(),
  /** Только мутации: чтение зон разводит роутер в `mockInvoke`. */
  mutate: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiPut: mocks.apiPut,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

/** Аккаунт Cloudflare (7) и аккаунт регистратора (9) намеренно разные числа. */
const CF_ACCOUNT_ID = 7;
const REGISTRAR_ACCOUNT_ID = 9;

const ZONE = {
  id: "zone-a",
  name: "example.com",
  name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
  status: "pending",
};

/**
 * Списки учёток карточка читает по HTTP. Провайдер регистратора здесь не
 * декорация: без него карточка не знает, есть ли у регистратора NS-API
 * (`lib/registrarCaps`), и гасит «Set NS».
 */
function mockAccounts(registrarProvider: string | null = "namecheap") {
  mocks.apiGet.mockImplementation(async (path: string) => {
    if (String(path).includes("/registrars/accounts")) {
      return registrarProvider === null
        ? []
        : [{ id: REGISTRAR_ACCOUNT_ID, provider: registrarProvider, name: "Reg", is_active: true }];
    }
    if (String(path).includes("/cloudflare/accounts")) {
      return [{ id: CF_ACCOUNT_ID, name: "Main CF", is_active: true }];
    }
    return [];
  });
}

function domain(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    domain_name: "example.com",
    status: "active",
    registrar_id: REGISTRAR_ACCOUNT_ID,
    server_id: null,
    cloudflare_account_id: CF_ACCOUNT_ID,
    cloudflare_zone_id: "zone-a",
    cloudflare_enabled: true,
    expiry_date: null,
    purchase_date: null,
    ns_status: "pending",
    ns_updated_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  } as any;
}

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function mockInvoke(reads: { zones?: any[]; zonesError?: Error } = {}) {
  mocks.invokeSynced.mockImplementation(async (cmd: string, args: any) => {
    if (cmd === "cf_list_zones") {
      if (reads.zonesError) throw reads.zonesError;
      return reads.zones ?? [ZONE];
    }
    return mocks.mutate(cmd, args);
  });
  // Карточка сверяет NS зоны с делегированием ИЗ РЕЕСТРА. Этот сценарий про
  // кнопку, а не про бейдж, но без ответа карточка висела бы в «не знаем»:
  // пустой список от реестра — состояние домена ДО пуша, то есть ровно то,
  // с чего начинается сюжет.
  mocks.invokeIfTauri.mockImplementation(async (cmd: string) =>
    cmd === "domain_registry_nameservers" ? { state: "registered", nameservers: [] } : true,
  );
}

/**
 * Рендерим на ТОМ ЖЕ `queryClient`, что и приложение: `onSettled` хука зовёт
 * `invalidateQueries` именно на этом синглтоне, и со свежим клиентом любая
 * проверка про инвалидацию проходила бы вхолостую.
 */
function renderModal(d = domain()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <DomainDetailModal domain={d} servers={[]} onClose={() => {}} />
    </QueryClientProvider>
  );
}

/**
 * Кнопка смены NS. Вкладок у карточки нет: NS живут на том же экране, что и
 * аккаунт Cloudflare, — поэтому открывать перед действием нечего, надо только
 * дождаться отрисовки.
 */
async function nsButton() {
  return (await screen.findByText(/Set NS/)).closest("button") as HTMLButtonElement;
}

function nsField() {
  return screen.getByLabelText(/Nameservers/i) as HTMLTextAreaElement;
}

function setNsCalls() {
  return mocks.invokeSynced.mock.calls.filter((c: any[]) => c[0] === "registrar_set_nameservers");
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
  mockAccounts();
  mockInvoke();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  setTauri(false);
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

describe("Set NS — десктоп выполняет", () => {
  it("шлёт registrar_set_nameservers с именем домена и аккаунтом РЕГИСТРАТОРА", async () => {
    setTauri(true);
    mocks.mutate.mockResolvedValue(true);

    renderModal();
    const btn = await nsButton();
    // NS подставились из зоны Cloudflare — их и надо прописать регистратору.
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));

    fireEvent.click(btn);

    await waitFor(() => expect(setNsCalls().length).toBe(1));
    const args = setNsCalls()[0][1];
    expect(args).toEqual({
      userId: "user-1",
      // Аккаунт регистратора (9), НЕ Cloudflare (7) и НЕ id домена (42).
      accountId: String(REGISTRAR_ACCOUNT_ID),
      // Имя домена, а не его числовой id: его ждёт API регистратора.
      domain: "example.com",
      // И отдельно id строки домена — адресат write-back'а `ns_status`.
      domainId: "42",
      nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    });
    // Мёртвого HTTP-роута больше нет ни в одном виде.
    expect(mocks.apiPost.mock.calls.some((c: any[]) => String(c[0]).includes("set-ns"))).toBe(false);
  });

  it("шлёт то, что пользователь ввёл руками, а не подставленное из Cloudflare", async () => {
    setTauri(true);
    mocks.mutate.mockResolvedValue(true);

    renderModal();
    const btn = await nsButton();
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));

    fireEvent.change(nsField(), { target: { value: "ns1.hoster.net\n ns2.hoster.net \n\n" } });
    fireEvent.click(btn);

    await waitFor(() => expect(setNsCalls().length).toBe(1));
    // Пустые строки и пробелы не должны уезжать регистратору.
    expect(setNsCalls()[0][1].nameservers).toEqual(["ns1.hoster.net", "ns2.hoster.net"]);
  });

  it("поздний ответ Cloudflare не затирает уже набранное руками", async () => {
    setTauri(true);
    mocks.mutate.mockResolvedValue(true);
    // Ровно та гонка, ради которой заведён флаг `nsEdited`: пользователь
    // печатает, ПОКА `cf_list_zones` ещё летит. Правка «поверх подставленного»
    // этого не проверяет — там ответ уже пришёл.
    let releaseZones: (zones: any[]) => void = () => {};
    const zonesPromise = new Promise<any[]>((resolve) => { releaseZones = resolve; });
    mocks.invokeSynced.mockImplementation(async (cmd: string, args: any) =>
      cmd === "cf_list_zones" ? zonesPromise : mocks.mutate(cmd, args)
    );

    renderModal();
    const btn = await nsButton();
    expect(nsField().value).toBe("");

    fireEvent.change(nsField(), { target: { value: "ns1.mine.net\nns2.mine.net" } });
    await act(async () => { releaseZones([ZONE]); });

    expect(nsField().value).not.toContain("ada.ns.cloudflare.com");
    fireEvent.click(btn);
    await waitFor(() => expect(setNsCalls().length).toBe(1));
    expect(setNsCalls()[0][1].nameservers).toEqual(["ns1.mine.net", "ns2.mine.net"]);
  });

  it("стирание поля не воскрешает подставленные NS под курсором", async () => {
    setTauri(true);

    renderModal();
    await nsButton();
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));

    // Стирание backspace'ом проходит через пустую строку и через строку из
    // пробелов. Если признаком «пользователь ничего не вписал» служит сам текст,
    // поле в этот момент мгновенно наполняется обратно NS зоны — и следующие
    // backspace'ы стирают уже их. Подставляем ровно один раз.
    fireEvent.change(nsField(), { target: { value: "ns1.mine.net" } });
    fireEvent.change(nsField(), { target: { value: "" } });
    await act(async () => {});
    expect(nsField().value).toBe("");

    fireEvent.change(nsField(), { target: { value: "   " } });
    await act(async () => {});
    expect(nsField().value).toBe("   ");
  });

  it("даёт вернуть nameservers зоны после того, как поле стёрли", async () => {
    setTauri(true);

    renderModal();
    await nsButton();
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));

    // Стирание больше не воскрешает NS под курсором — но и вернуть их было
    // нечем: списка зоны в этой модалке нет, помогало только закрыть и открыть
    // карточку. Явное действие вместо неявного побочного эффекта.
    fireEvent.change(nsField(), { target: { value: "" } });
    await act(async () => {});
    expect(nsField().value).toBe("");

    fireEvent.click(screen.getByText(/Restore from Cloudflare/i));
    expect(nsField().value).toBe("ada.ns.cloudflare.com\nbob.ns.cloudflare.com");
  });

  it("не предлагает восстановить то, что и так в поле", async () => {
    setTauri(true);

    renderModal();
    await nsButton();
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));
    // Свежая подстановка совпадает с зоной — предлагать нечего.
    expect(screen.queryByText(/Restore from Cloudflare/i)).toBeNull();

    // Посимвольное сравнение считало бы это отличием: лишний перевод строки в
    // конце и другой регистр — то же содержимое.
    fireEvent.change(nsField(), {
      target: { value: "ADA.ns.cloudflare.com\nbob.ns.cloudflare.com\n" },
    });
    await act(async () => {});
    expect(screen.queryByText(/Restore from Cloudflare/i)).toBeNull();

    // А вот настоящее отличие — предлагаем.
    fireEvent.change(nsField(), { target: { value: "ns1.hoster.net\nns2.hoster.net" } });
    await act(async () => {});
    expect(screen.getByText(/Restore from Cloudflare/i)).toBeTruthy();
  });

  it("не шлёт регистратору дубли и требует хотя бы два nameserver'а", async () => {
    setTauri(true);
    mocks.mutate.mockResolvedValue(true);

    renderModal();
    const btn = await nsButton();
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));

    // Один и тот же NS дважды — обычная опечатка при ручном вводе. Оба
    // регистратора требуют минимум два, так что после схлопывания дублей
    // отправлять нечего: Namecheap ответил бы отказом, а отказ теперь оседает
    // на сервере как `ns_status: error`.
    fireEvent.change(nsField(), { target: { value: "NS1.hoster.net\nns1.hoster.net" } });
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(screen.getByText(/at least 2 distinct nameservers/i)).toBeTruthy();
    fireEvent.click(btn);
    expect(setNsCalls().length).toBe(0);

    // Та же опечатка другой формой: копипаста из зонного файла даёт FQDN с
    // завершающей точкой. Для бейджа делегирования `ns1.hoster.net.` и
    // `ns1.hoster.net` — один сервер; будь они двумя для отправки, порог
    // прошёл бы и регистратор получил бы дубль.
    fireEvent.change(nsField(), { target: { value: "ns1.hoster.net.\nns1.hoster.net" } });
    await waitFor(() => expect(btn.disabled).toBe(true));

    fireEvent.change(nsField(), { target: { value: "NS1.hoster.net\nns1.hoster.net\nns2.hoster.net" } });
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);

    await waitFor(() => expect(setNsCalls().length).toBe(1));
    // Регистр первого вхождения сохраняем: схлопываем повтор, а не «чиним» ввод.
    expect(setNsCalls()[0][1].nameservers).toEqual(["NS1.hoster.net", "ns2.hoster.net"]);
  });

  it("домен без зоны Cloudflare не заперт: NS вводятся руками", async () => {
    setTauri(true);
    mocks.mutate.mockResolvedValue(true);

    renderModal(domain({ cloudflare_account_id: null, cloudflare_zone_id: null }));
    const btn = await nsButton();
    expect(btn.disabled).toBe(true);

    fireEvent.change(nsField(), { target: { value: "ns1.hoster.net,ns2.hoster.net" } });
    await waitFor(() => expect(nsField().value).toContain("ns1.hoster.net"));
    fireEvent.click(screen.getByText(/Set NS/).closest("button") as HTMLButtonElement);

    await waitFor(() => expect(setNsCalls().length).toBe(1));
    expect(setNsCalls()[0][1].nameservers).toEqual(["ns1.hoster.net", "ns2.hoster.net"]);
    // Зону не читаем вовсе: её нет.
    expect(mocks.invokeSynced.mock.calls.some((c: any[]) => c[0] === "cf_list_zones")).toBe(false);
  });
});

describe("Set NS — пустые и ошибочные случаи", () => {
  it("без аккаунта регистратора не даёт нажать и объясняет почему", async () => {
    setTauri(true);

    renderModal(domain({ registrar_id: null }));
    const btn = await nsButton();
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));

    expect(btn.disabled).toBe(true);
    // Именно действие рядом с кнопкой. Про тот же пробел говорит и бейдж
    // делегирования выше («NS у регистратора неизвестны»), но там это ответ на
    // другой вопрос — что мы знаем, а не что нажать.
    expect(screen.getByText(/Assign a registrar account to this domain first/)).toBeTruthy();

    fireEvent.click(btn);
    expect(setNsCalls().length).toBe(0);
  });

  it("без единого nameserver не даёт нажать", async () => {
    setTauri(true);
    mockInvoke({ zones: [{ ...ZONE, name_servers: [] }] });

    renderModal();
    const btn = await nsButton();

    await waitFor(() => expect(btn.disabled).toBe(true));
    // Выключенная кнопка без объяснения — загадка, а не запрет: у каждого
    // условия в `disabled` должна быть своя строчка рядом.
    expect(screen.getByText(/Nothing to push/i)).toBeTruthy();
    fireEvent.click(btn);
    expect(setNsCalls().length).toBe(0);
  });

  it("объясняет провал чтения зоны, но только в десктопе", async () => {
    setTauri(true);
    mockInvoke({ zonesError: new Error("cloudflare: 9109 invalid token") });

    renderModal();
    await nsButton();

    // «Не смогли прочитать» и «у зоны нет NS» — разные ответы на вопрос
    // пользователя, и молчание вместо первого было бы хуже.
    expect(await screen.findByText(/Could not prefill from Cloudflare/)).toBeTruthy();
    expect(screen.getByText(/9109 invalid token/)).toBeTruthy();
  });

  it("показывает отказ регистратора, а не проглатывает его", async () => {
    setTauri(true);
    mocks.mutate.mockRejectedValue(new Error("Namecheap setCustom failed: Invalid nameserver"));

    renderModal();
    const btn = await nsButton();
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));
    fireEvent.click(btn);

    expect(await screen.findByText(/Invalid nameserver/)).toBeTruthy();
  });

  it("показывает отказ, когда команда вернула false", async () => {
    setTauri(true);
    mocks.mutate.mockResolvedValue(false);

    renderModal();
    const btn = await nsButton();
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));
    fireEvent.click(btn);

    expect(
      await screen.findByText("The registrar did not apply the nameserver change.")
    ).toBeTruthy();
  });

  // Пары «чужая ошибка ↔ удавшийся Set NS» удалены вместе с вкладками `db`,
  // `ssl` и `nginx`: чужих действий в карточке больше нет ни одного, а с ними
  // ушли `runAction` и карта ошибок по вкладкам. Осталось то, что и осталось в
  // коде: отказ Set NS, прочитанный из MutationCache.

  it("держит отказ у кнопки, которая его вызвала, а не поверх всей карточки", async () => {
    setTauri(true);
    mocks.mutate.mockRejectedValue(new Error("Namecheap setCustom failed: Invalid nameserver"));

    renderModal();
    const btn = await nsButton();
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));
    fireEvent.click(btn);

    // ВНИМАНИЕ: это принятый РЕГРЕСС, а не переехавшая проверка.
    //
    // Пока вкладки были, карточка открывалась на Overview и отказ прошлой
    // попытки там не показывался вовсе — человек, открывший её заново, не
    // встречал красного про действие, которого в этот заход не совершал
    // (соседний тест ниже как раз утверждает обратное: при переоткрытии отказ
    // виден сразу, без единого клика). Скоуп держался вкладкой, а у экрана без
    // вкладок её нет — и «показывать только тому, кто нажимал» на одном экране
    // не выразить: MutationCache помнит попытку, а не сессию просмотра.
    //
    // Взамен осталось адресование МЕСТОМ: отказ стоит между полем NS и
    // кнопкой, то есть там, где его ждёт нажавший, а не заголовком над сроками,
    // SSL и учётками, к которым отношения не имеет. Это смягчает регресс, но не
    // отменяет его — если он окажется дорогим, лечить надо отдельным признаком
    // «эту попытку уже показывали», а не возвратом вкладок.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Invalid nameserver");
    expect(
      nsField().compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING,
      "отказ обязан стоять ПОСЛЕ поля NS, а не над карточкой",
    ).toBeTruthy();
  });

  it("не теряет отказ, прилетевший после закрытия карточки", async () => {
    setTauri(true);
    let refuse: (e: Error) => void = () => {};
    mocks.mutate.mockImplementationOnce(
      () => new Promise((_res, rej) => { refuse = rej; })
    );

    const first = renderModal();
    const btn = await nsButton();
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));
    fireEvent.click(btn);
    await waitFor(() => expect(setNsCalls().length).toBe(1));

    // Namecheap отвечает секундами; пользователь успевает закрыть карточку.
    // Per-call `onError` тут умирает вместе с observer'ом (`hasListeners()`), и
    // единственным следом отказа остался бы бейдж «NS: Error» в строке таблицы
    // без всякой причины.
    first.unmount();
    await act(async () => { refuse(new Error("Namecheap setCustom failed: Invalid nameserver")); });

    // Карточку открыли заново — отказ на месте: ответ регистратора мог прийти
    // уже после её закрытия, и другого следа, кроме бейджа «NS: Error» в
    // строке таблицы, у него нет.
    renderModal();
    expect(await screen.findByText(/Invalid nameserver/)).toBeTruthy();
  });

  it("не оставляет ошибку прошлой попытки поверх удавшейся следующей", async () => {
    setTauri(true);
    mocks.mutate
      .mockRejectedValueOnce(new Error("Namecheap setCustom failed: Invalid nameserver"))
      .mockResolvedValueOnce(true);

    renderModal();
    const btn = await nsButton();
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));

    fireEvent.click(btn);
    expect(await screen.findByText(/Invalid nameserver/)).toBeTruthy();

    // Повтор на месте — основной сценарий этого блока: поле редактируемое,
    // и всё («Nothing to push», минимум из двух, схлопывание дублей) толкает
    // исправить ввод и нажать ещё раз. Баннер модалки общий и не
    // размонтируется между попытками, так что без явного сброса красное про
    // прошлый отказ висит над удавшейся сменой.
    fireEvent.change(nsField(), { target: { value: "ns1.fixed.net\nns2.fixed.net" } });
    fireEvent.click(btn);

    await waitFor(() => expect(setNsCalls().length).toBe(2));
    await waitFor(() => expect(screen.queryByText(/Invalid nameserver/)).toBeNull());
  });
});

describe("Set NS — веб только смотрит", () => {
  it("кнопка выключена, объяснение ОДНО, ни одного вызова", async () => {
    setTauri(false);

    const { container } = renderModal();
    const btn = await nsButton();

    expect(btn.disabled).toBe(true);
    // Ровно та же фраза, что бросает хук: обе живут в `NS_DESKTOP_NOTE`.
    expect(screen.getAllByText(new RegExp(NS_DESKTOP_NOTE)).length).toBeGreaterThan(0);

    // Вне десктопа зоны не читаются вовсе (`useCloudflareZones` выключен
    // флагом): их отсутствие здесь — правило продукта, а не поломка.
    // Показывать его как «Could not prefill» значит выдавать норму за сбой;
    // «добавьте NS выше» и вовсе предлагает то, чего на вебе не сделать.
    // Одна причина — одна строка.
    await waitFor(() => expect(mocks.invokeSynced).not.toHaveBeenCalled());
    expect(screen.queryByText(/Could not prefill/)).toBeNull();
    expect(screen.queryByText(/Nothing to push/)).toBeNull();

    fireEvent.click(btn);
    expect(setNsCalls().length).toBe(0);
    expect(mocks.apiPost).not.toHaveBeenCalled();
    // Deep link'а `sdmp://set-ns` не существует: parseDeepLinkAction его не
    // знает, и ссылка вела бы в пустоту.
    expect(container.querySelectorAll('a[href^="sdmp://set-ns"]').length).toBe(0);
  });

  it("не предлагает других действий рядом с «только чтение»", async () => {
    setTauri(false);

    renderModal();
    await nsButton();

    // «Read-only here» и три живые мутирующие кнопки на одном экране —
    // взаимоисключающие утверждения. Кнопок больше нет вовсе: роутов
    // `check-ns`/`mark-ns-set` на бэкенде не существует, так что и в десктопе
    // они давали только 404.
    for (const dead of ["Check NS", "Mark NS set", "Unmark NS"]) {
      expect(screen.queryByText(dead), `${dead} должна быть удалена`).toBeNull();
    }
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });
});

describe("карточка домена — один экран без вкладок", () => {
  it("не предлагает DB / SSL / NGINX и Create Site и не ходит по их роутам", async () => {
    setTauri(true);

    renderModal();
    await nsButton();

    // Роутов `create-site`, `create-db`, `db-credentials`, `ssl-request`,
    // `ssl-cancel`, `refresh-ssl` и `nginx-override` на бэкенде нет — каждая из
    // этих вкладок всегда отвечала 404 в общий баннер. Голый «SSL» из списка
    // ушёл: теперь это заголовок read-only секции «Server state» (живое чтение
    // с сервера, без мутаций), а не вкладка-действие. Мёртвые SSL-ДЕЙСТВИЯ
    // (Request/Cancel/Refresh SSL) по-прежнему обязаны отсутствовать.
    for (const dead of ["DB", "NGINX", "Create Site", "Create DB", "Request SSL", "Cancel SSL", "Refresh SSL", "Save and Reload nginx"]) {
      expect(screen.queryByText(dead), `${dead} должна быть удалена`).toBeNull();
    }
    // Переключателя вкладок нет вовсе: NS переехали к аккаунту Cloudflare, а
    // разложенные по двум экранам они заставляли ходить туда-сюда, чтобы
    // понять, почему NS не пушатся.
    for (const tab of ["OVERVIEW", "NS"]) {
      expect(screen.queryByText(tab), `вкладки ${tab} быть не должно`).toBeNull();
    }
    // Поле NS и сроки домена теперь на одном экране, без единого клика.
    expect(nsField()).toBeTruthy();
    expect(screen.getByText("Expires:")).toBeTruthy();

    // По домену карточка не ходит НИ ПО ОДНОМУ роуту: креды БД и
    // nginx-override тянулись `useQuery` с `enabled: !!domainId` прямо при
    // открытии. Списки учёток — не про домен: по ним показываются имена
    // аккаунтов и провайдер регистратора.
    await act(async () => {});
    expect(mocks.apiGet.mock.calls.map((c: any[]) => String(c[0])).sort()).toEqual([
      "/cloudflare/accounts",
      "/registrars/accounts",
    ]);
    expect(mocks.apiPost.mock.calls.map((c: any[]) => String(c[0]))).toEqual([]);
  });
});

describe("мёртвые NS-действия удалены", () => {
  it("карточка не зовёт несуществующие check-ns / mark-ns-set", async () => {
    setTauri(true);

    renderModal();
    await nsButton();

    for (const dead of ["Check NS", "Mark NS set", "Unmark NS"]) {
      expect(screen.queryByText(dead), `${dead} должна быть удалена`).toBeNull();
    }
    // Из NS-действий на карточке осталось только то, что работает.
    expect(screen.getByText(/Set NS/)).toBeTruthy();
    expect(mocks.apiPost.mock.calls.map((c: any[]) => String(c[0]))).toEqual([]);
  });

  it("панель массовых действий не предлагает Check NS / Mark NS Set", () => {
    for (const tauri of [false, true]) {
      setTauri(tauri);
      const { container, unmount } = render(
        <BulkActionToolbar
          selectedCount={2}
          selectedDomainIds={[1, 2]}
          onAssignServer={() => {}}
          onAssignCF={() => {}}
          onSyncCloudflare={() => {}}
          syncPending={false}
          onFullSetup={() => {}}
          fullSetupPending={false}
          onProvision={() => {}}
          onDelete={() => {}}
        />
      );
      // `Promise.all(ids.map(mutateAsync))` без catch на 50 доменах давал 50
      // штук 404 и unhandled rejection в придачу.
      expect(screen.queryByText("Check NS")).toBeNull();
      expect(screen.queryByText("Mark NS Set")).toBeNull();
      expect(container.querySelectorAll('a[href^="sdmp://check-ns"]').length).toBe(0);
      expect(container.querySelectorAll('a[href^="sdmp://mark-ns-set"]').length).toBe(0);
      unmount();
    }
  });
});

describe("массовый Set NS", () => {
  it("панель массовых действий не предлагает Set NS ни на вебе, ни в десктопе", () => {
    for (const tauri of [false, true]) {
      setTauri(tauri);
      const { container, unmount } = render(
        <BulkActionToolbar
          selectedCount={2}
          selectedDomainIds={[1, 2]}
          onAssignServer={() => {}}
          onAssignCF={() => {}}
          onSyncCloudflare={() => {}}
          syncPending={false}
          onFullSetup={() => {}}
          fullSetupPending={false}
          onProvision={() => {}}
          onDelete={() => {}}
        />
      );
      // `POST /domains/bulk-set-ns` не существует, а `sdmp://set-ns` не
      // разбирается parseDeepLinkAction — обе дороги вели в никуда.
      expect(container.querySelectorAll('a[href^="sdmp://set-ns"]').length).toBe(0);
      expect(screen.queryByText("Set NS")).toBeNull();
      unmount();
    }
  });
});
