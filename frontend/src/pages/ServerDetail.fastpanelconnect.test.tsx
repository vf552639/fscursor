import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ServerDetail from "./ServerDetail";
import {
  setTauri,
  UUID_V4,
  putBlobArgs,
  putBlobCalls,
  blobPlaintext,
  secretBlobLifecycle,
  BLOB_USER_ID,
  DESKTOP_NOTE,
} from "../test/secretBlobKit";

/**
 * Подключение УЖЕ стоящей панели — с карточки сервера, а не из «Add Server».
 * Покрытие переехало сюда из `Servers.fastpanelblob.test.tsx`: путь тот же
 * («блоб → сущность», вид секрета `server_fastpanel_password`, пароль не в
 * теле запроса), а сущность другая — сервер уже существует, поэтому PUT, а не
 * POST, и URL панели собирается из его `ip_address`, а не разбирается обратно
 * ради IP.
 *
 * Сервер, у которого `fastpanel_password_blob_id = NULL`, — это «панель
 * подключена» и панель, к которой нечем подключиться: ровно поэтому провал
 * записи блоба обязан оставить сервер нетронутым.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  invokeIfTauri: vi.fn(),
  invokeSynced: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPut: mocks.apiPut,
}));

// Мокаем транспорт, а не сам `secretBlob`: тест обязан видеть, ЧТО уехало в
// `vault_put_blob`. С заглушкой над `putSecretBlob` форма, записавшая пароль
// панели под `blobKind: server_ssh_password`, прошла бы тест.
vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

// `invokeSynced` — это канал самой установки панели (`useInstallFastPanel`):
// через него тест удерживает её «идущей», чтобы посмотреть на кнопку рядом.
vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

// Тянет argon2/libsodium, к подключению панели отношения не имеет.
vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));

const FP_PW = "fastpanel-pw";
const FP_BLOB = "99999999-8888-4777-8666-555555555555";

const SERVER = {
  id: 7,
  name: "srv-7",
  ip_address: "10.0.0.7",
  ssh_port: 2222,
  ssh_user: "deploy",
  os: "ubuntu-22.04",
  provider: "Hetzner" as string | null,
  status: "active",
  fastpanel_status: "not_installed",
  fastpanel_url: null as string | null,
  fastpanel_user: null as string | null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  has_ssh: true,
  ssh_password_blob_id: "11111111-2222-4333-8444-555555555555" as string | null,
  fastpanel_password_blob_id: null as string | null,
  uptime_seconds: null,
  cpu_usage_pct: null,
  cpu_count: null,
  ram_used_mb: null,
  ram_total_mb: null,
  disk_used_gb: null,
  disk_total_gb: null,
  net_in_kbps: null,
  net_out_kbps: null,
  os_pretty: "Ubuntu 22.04",
  kernel: null,
  fastpanel_version: null as string | null,
  fastpanel_port: null as number | null,
  metrics_collected_at: null,
  last_check_at: null,
  last_check_ok: true,
  last_check_error: null,
};

// Оборвавшаяся установка: write-back успел записать пароль панели, а статус так
// и не стал `installed` — сервер попадает ровно в эту форму, УЖЕ имея блоб.
const SERVER_STUCK = {
  ...SERVER,
  fastpanel_status: "installing",
  fastpanel_password_blob_id: FP_BLOB,
};

// Панель уже подключена: карточка «FastPanel Access» вместо блока установки.
// Правки кред у неё нет намеренно — просили «подключить», а не «переподключить».
const SERVER_FP = {
  ...SERVER,
  fastpanel_status: "installed",
  fastpanel_url: "https://10.0.0.7:8888",
  fastpanel_user: "fastuser",
  fastpanel_password_blob_id: FP_BLOB,
  fastpanel_version: "2.0",
  fastpanel_port: 8888,
};

function renderDetail(server: typeof SERVER = SERVER) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === `/servers/${server.id}`) return server;
    if (url === "/servers") return { items: [server], total: 1 };
    if (url === "/domains") return [];
    throw new Error(`unexpected GET ${url}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ServerDetail server={{ id: server.id }} onBack={() => {}} onFastpanelCreds={() => {}} />
    </QueryClientProvider>,
  );
}

/**
 * Карточка установки панели. Утверждения про веб-ветку меряются ею, а не всей
 * страницей: заметка «Saving secrets» есть и у «Изменить SSH» в шапке, и поиск
 * по документу проходил бы, даже если у подключения панели не осталось ВООБЩЕ
 * ничего.
 */
function installCard(): HTMLElement {
  return screen.getByText("⚡ FastPanel Installation").parentElement!.parentElement!;
}

async function openConnectForm() {
  fireEvent.click(await screen.findByRole("button", { name: "Connect Existing" }));
  const url = (await screen.findByPlaceholderText(
    "https://192.168.1.100:8888",
  )) as HTMLInputElement;
  return {
    url,
    login: screen.getByPlaceholderText("Enter login") as HTMLInputElement,
    password: screen.getByPlaceholderText("Enter password") as HTMLInputElement,
  };
}

describe("ServerDetail — подключение существующей панели", () => {
  secretBlobLifecycle();

  it("в десктопе шлёт fastpanel_password_blob_id и НЕ шлёт fastpanel_password", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...SERVER_FP });

    renderDetail();
    const form = await openConnectForm();
    fireEvent.change(form.password, { target: { value: FP_PW } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));

    const blob = putBlobArgs(mocks.invokeIfTauri);
    expect(blob.userId).toBe(BLOB_USER_ID);
    // Вид секрета — не косметика: под ним блоб лежит в хранилище и по нему его
    // ищут команды. Пароль панели под `server_ssh_password` — это ссылка,
    // которую откроет не тот потребитель.
    expect(blob.blobKind).toBe("server_fastpanel_password");
    // Пароля панели у сервера ещё не было — значит новый id.
    expect(blob.blobId).toMatch(UUID_V4);
    expect(blobPlaintext(blob)).toBe(FP_PW);

    const [url, body] = mocks.apiPut.mock.calls[0];
    expect(url).toBe("/servers/7");
    expect(body.fastpanel_password_blob_id).toBe(blob.blobId);
    // Ради этой строки всё и затевалось: поля нет, а не «есть, но сервер его
    // игнорирует».
    expect(body).not.toHaveProperty("fastpanel_password");
    expect(JSON.stringify(body)).not.toContain(FP_PW);
    // Остальные поля подключения на месте: без `fastpanel_status` сервер так и
    // остался бы с блоком установки поверх работающей панели.
    expect(body.fastpanel_user).toBe("fastuser");
    expect(body.fastpanel_url).toBe("https://10.0.0.7:8888");
    expect(body.fastpanel_status).toBe("installed");

    await waitFor(() => expect(screen.queryByPlaceholderText("Enter password")).toBeNull());
  });

  it("перезаписывает ТОТ ЖЕ блоб, если пароль панели у сервера уже есть", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...SERVER_FP });

    renderDetail(SERVER_STUCK);
    const form = await openConnectForm();
    fireEvent.change(form.password, { target: { value: FP_PW } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    const blob = putBlobArgs(mocks.invokeIfTauri);
    // Новый id здесь = сущность продолжает указывать на прежний пароль, а
    // версии блоба, которые сервер ведёт внутри одного id, теряются вместе с
    // осиротевшим блобом.
    expect(blob.blobId).toBe(FP_BLOB);
    expect(mocks.apiPut.mock.calls[0][1].fastpanel_password_blob_id).toBe(FP_BLOB);
  });

  it("подставляет URL из IP сервера и логин панели по умолчанию", async () => {
    setTauri(true);
    renderDetail();
    const form = await openConnectForm();
    // Адрес сервера здесь уже известен. Пустое поле заставило бы набрать руками
    // то, что программа и так знает.
    expect(form.url.value).toBe("https://10.0.0.7:8888");
    expect(form.login.value).toBe("fastuser");
  });

  it("упавшая запись блоба не трогает сервер и не молчит", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockRejectedValue(new Error("keychain locked"));

    renderDetail();
    const form = await openConnectForm();
    fireEvent.change(form.password, { target: { value: FP_PW } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Ошибка — в форме, а не в `alert`: пользователь вернётся к тому же полю.
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "keychain locked");
    // PUT со ссылкой на несуществующий блоб — это 200 OK и панель, к которой
    // нечем подключиться.
    expect(mocks.apiPut).not.toHaveBeenCalled();
    // Закрытая форма выглядела бы как «сохранено», а сохранено не было.
    expect(screen.getByPlaceholderText("Enter password")).toBeTruthy();
  });

  it("URL с кредами внутри не уходит на сервер и не жжёт блоб", async () => {
    // Такой URL отвергает и схема бэкенда, но её 422 приезжает в форму как
    // `[object Object]` — значит промах должен ловиться здесь и называться
    // словами. Блоб при этом не пишется вовсе: проверка идёт ДО `save()`, и
    // провал не должен оставлять в хранилище пароль от неподключённой панели.
    setTauri(true);
    renderDetail();
    const form = await openConnectForm();
    fireEvent.change(form.password, { target: { value: FP_PW } });
    fireEvent.change(form.url, { target: { value: "https://fastuser:panelpw@10.0.0.9:8888" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/must not be stored in the URL/)).toBeTruthy();
    expect(mocks.apiPut).not.toHaveBeenCalled();
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(0);
  });

  it("пустой пароль не пишет блоб из нуля байт", async () => {
    setTauri(true);
    renderDetail();
    await openConnectForm();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Password is required")).toBeTruthy();
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("второй клик в окне записи блоба не пишет второй блоб", async () => {
    setTauri(true);
    // Кнопка обязана быть мёртвой всё время записи блоба И сохранения сервера:
    // между ними нет кадра, где оба флага ложны.
    let releaseBlob: () => void = () => {};
    mocks.invokeIfTauri.mockReturnValue(new Promise<void>((r) => { releaseBlob = () => r(); }));
    mocks.apiPut.mockResolvedValue({ ...SERVER_FP });

    renderDetail();
    const form = await openConnectForm();
    fireEvent.change(form.password, { target: { value: FP_PW } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(1));
    const saving = (await screen.findByText("Saving...")).closest("button") as HTMLButtonElement;
    expect(saving.disabled).toBe(true);
    fireEvent.click(saving);

    // Cancel мёртв по своей причине: он зовёт `reset()`, то есть посреди записи
    // стёр бы плейнтекст, который хук держит на случай повтора.
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    expect(screen.getByPlaceholderText("Enter password")).toBeTruthy();

    releaseBlob();
    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(1);
  });

  it("во время идущей установки подключить панель нельзя", async () => {
    setTauri(true);
    // Установка, которая никогда не кончится: ровно так она и выглядит первые
    // полчаса.
    mocks.invokeSynced.mockReturnValue(new Promise<void>(() => {}));

    renderDetail();
    fireEvent.click(await screen.findByText("Install FastPanel"));

    // Иначе подключение поставило бы `fastpanel_status: "installed"`, карточка
    // установки исчезла бы вместе с индикатором «Installing…», а write-back
    // установки через полчаса перезаписал бы подключённые креды своими.
    const connect = await screen.findByRole("button", { name: "Connect Existing" });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(true));
  });

  it.each([["Cancel"], ["✕"]])(
    "повторное открытие формы (выход через «%s») даёт пустое поле пароля",
    async (exit) => {
      setTauri(true);
      renderDetail();
      const form = await openConnectForm();
      fireEvent.change(form.password, { target: { value: FP_PW } });
      // Оба выхода ведут в `closeConnectModal` — и оба обязаны оставить форму
      // такой, чтобы следующий, кто её откроет, не увидел чужой набранный
      // пароль.
      fireEvent.click(screen.getByRole("button", { name: exit }));

      const reopened = await openConnectForm();
      expect(reopened.password.value).toBe("");
    },
  );

  it("в вебе кнопки нет вовсе — только объяснение", async () => {
    setTauri(false);
    renderDetail();

    await screen.findByText("⚡ FastPanel Installation");
    // Кнопки нет, и поля пароля тоже: шифрует Rust мастер-ключом из keychain,
    // и форма, в которой дали набрать пароль, обещала бы сохранение уже после
    // того, как он набран.
    expect(screen.queryByRole("button", { name: "Connect Existing" })).toBeNull();
    expect(screen.queryByPlaceholderText("Enter password")).toBeNull();
    // Именно в карточке установки: заметка где-нибудь на странице оставила бы
    // веб-пользователя перед пропавшим действием без единого слова о том, почему.
    expect(within(installCard()).getByText(DESKTOP_NOTE)).toBeTruthy();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("у подключённой панели ни блока установки, ни кнопки подключения", async () => {
    setTauri(true);
    renderDetail(SERVER_FP);

    // Правки кред уже подключённой панели здесь нет намеренно: просили
    // «подключить». Появится нужда — появится и своя кнопка в этой карточке.
    expect(await screen.findByText(/FastPanel Access/)).toBeTruthy();
    expect(screen.queryByText("⚡ FastPanel Installation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect Existing" })).toBeNull();
  });
});
