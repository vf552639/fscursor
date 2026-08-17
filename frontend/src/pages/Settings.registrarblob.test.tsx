import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";

import Settings, { AddRegistrarModal } from "./Settings";
import { useDeleteRegistrarAccount } from "../api/registrars";
import {
  setTauri,
  UUID_V4,
  putBlobCalls,
  blobPlaintext,
  deletedBlobIds,
  expectBlobsGoneAfterEntity,
  expectDeleteIgnoresBlobFailure,
  renderWithClient,
  secretBlobLifecycle,
  DESKTOP_NOTE,
} from "../test/secretBlobKit";

/**
 * Единственная форма спринта с ДВУМЯ секретами — ради неё и заведён
 * `useMultiSecretSave`: `api_key` и `api_secret` сохраняются одним POST, то
 * есть оба блоба обязаны быть записаны ДО него. Два отдельных `useSecretSave`
 * дали бы два запроса вместо одного (и упирались бы в защиту от вложенности).
 *
 * `api_secret` до этого не имел поля вовсе, хотя десктоп его читает: у
 * Namecheap это whitelisted client IP (`commands/registrars.rs`), без которого
 * аккаунт нельзя настроить до конца. Поэтому поле — только у Namecheap: Hostiq
 * этот параметр не получает вообще (`registrars::make_service`).
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  invokeIfTauri: vi.fn(),
  confirmAction: vi.fn(),
}));

// Вопрос «удалять?» задаёт нативный диалог Tauri, которого в jsdom нет: без
// мока `confirmAction` поймала бы отсутствие плагина и вернула `false` — тест
// проверял бы отказ, а не удаление.
vi.mock("../lib/confirmDialog", () => ({ confirmAction: mocks.confirmAction }));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiPut: mocks.apiPut,
  apiDelete: mocks.apiDelete,
}));

// Транспорт, а не `secretBlob`: тест обязан видеть, ЧТО уехало в каждый из двух
// `vault_put_blob` — перепутанные местами ключ и IP заглушка над
// `putSecretBlob` пропустила бы.
vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

const KEY_BLOB = "11111111-1111-4111-8111-111111111111";
const SECRET_BLOB = "22222222-2222-4222-8222-222222222222";
const API_KEY = "nc-api-key";
const CLIENT_IP = "203.0.113.7";

const NAMECHEAP = {
  id: 3,
  provider: "namecheap",
  name: "nc-main",
  api_user: "ncuser",
  is_active: true,
  api_key_blob_id: KEY_BLOB,
  api_secret_blob_id: SECRET_BLOB,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function renderPage(accounts: any[] = [NAMECHEAP]) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/registrars/accounts") return accounts;
    if (url === "/settings/config") return [];
    throw new Error(`unexpected GET ${url}`);
  });
  return renderWithClient(<Settings />);
}

async function openAddModal(provider: "hostiq" | "namecheap") {
  fireEvent.click((await screen.findAllByRole("button", { name: "+ Add Registrar" }))[0]);
  if (provider === "namecheap") {
    // Комбобокс вместо карточек: открыть и выбрать опцию.
    fireEvent.click(screen.getByRole("button", { name: /provider/i }));
    fireEvent.click(screen.getByRole("option", { name: /Namecheap/ }));
  }
  fireEvent.change(screen.getByPlaceholderText("e.g., Hostiq Main"), {
    target: { value: "reg-new" },
  });
}

/** Аргументы `vault_put_blob` по виду секрета: их тут два, и порядок неважен. */
function blobOfKind(kind: string) {
  const calls = putBlobCalls(mocks.invokeIfTauri).filter((c) => c.blobKind === kind);
  expect(calls.length).toBe(1);
  return calls[0];
}

describe("Settings — ключ и секрет регистратора через блобы", () => {
  secretBlobLifecycle();

  it("Namecheap: оба блоба записаны ДО единственного POST", async () => {
    setTauri(true);
    mocks.apiPost.mockResolvedValue({ ...NAMECHEAP });

    renderPage([]);
    await openAddModal("namecheap");
    fireEvent.change(screen.getByPlaceholderText("your_namecheap_username"), {
      target: { value: "ncuser" },
    });
    // Оба поля — с пробелами по краям: ключ копируют из панели регистратора
    // вместе с `\n`, а Client IP с пробелом просто не совпадёт с whitelist.
    // `"   "` отбивался бы и без `trim` (поле пустое), а такой ввод — нет,
    // поэтому утверждения ниже смотрят на содержимое блобов.
    fireEvent.change(screen.getByPlaceholderText("••••••••"), {
      target: { value: `  ${API_KEY}  ` },
    });
    fireEvent.change(screen.getByPlaceholderText("127.0.0.1"), {
      target: { value: `  ${CLIENT_IP}  ` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));

    const key = blobOfKind("registrar_api_key");
    const secret = blobOfKind("registrar_api_secret");
    expect(blobPlaintext(key)).toBe(API_KEY);
    // Перепутанные виды секретов компилируются и проходят серверную валидацию:
    // IP уехал бы в блоб ключа, а команда регистратора получила бы их наоборот.
    expect(blobPlaintext(secret)).toBe(CLIENT_IP);
    expect(key.blobId).toMatch(UUID_V4);
    expect(secret.blobId).toMatch(UUID_V4);

    const [url, body] = mocks.apiPost.mock.calls[0];
    expect(url).toBe("/registrars/accounts");
    expect(body.api_key_blob_id).toBe(key.blobId);
    expect(body.api_secret_blob_id).toBe(secret.blobId);
    // Ради этих строк и затевался спринт: полей нет, а не «есть, но сервер их
    // игнорирует».
    expect(body).not.toHaveProperty("api_key");
    expect(body).not.toHaveProperty("api_secret");
    expect(JSON.stringify(body)).not.toContain(API_KEY);
    expect(JSON.stringify(body)).not.toContain(CLIENT_IP);

    // Один POST, а не два: ради этого форма и держит один `saveAll`, а не два
    // хука на поле. И оба блоба — до него: аккаунт со ссылкой NULL это 200 OK
    // и «registrar account has no api_key_blob_id» в каждой команде.
    const postAt = mocks.apiPost.mock.invocationCallOrder[0];
    expect(Math.max(...mocks.invokeIfTauri.mock.invocationCallOrder)).toBeLessThan(postAt);
  });

  it("Hostiq: пишет только ключ, api_secret_blob_id не шлёт вовсе", async () => {
    setTauri(true);
    mocks.apiPost.mockResolvedValue({ ...NAMECHEAP, provider: "hostiq" });

    renderPage([]);
    await openAddModal("hostiq");
    fireEvent.change(screen.getByPlaceholderText("admin@hostiq.ua"), {
      target: { value: "admin@hostiq.ua" },
    });
    // У Hostiq поле ключа своё (другой плейсхолдер) и свой `trim` в onChange —
    // значит и пробелы по краям надо ловить отдельно от Namecheap.
    fireEvent.change(screen.getByPlaceholderText("••••••••••••••••"), {
      target: { value: `  ${API_KEY}  ` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));

    // Hostiq этот параметр не получает вообще (`make_service`), поэтому и поля
    // у него нет: собранный секрет, который никто не читает, — лишний блоб.
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(1);
    expect(blobPlaintext(blobOfKind("registrar_api_key"))).toBe(API_KEY);
    expect(mocks.apiPost.mock.calls[0][1]).not.toHaveProperty("api_secret_blob_id");
  });

  it("ручной провайдер: без полей секретов, создаётся с null-блобами", async () => {
    setTauri(true);
    mocks.apiPost.mockResolvedValue({ id: 9, provider: "GoDaddy", name: "gd", api_user: null,
      is_active: true, api_key_blob_id: null, api_secret_blob_id: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });

    renderPage([]);
    fireEvent.click((await screen.findAllByRole("button", { name: "+ Add Registrar" }))[0]);
    fireEvent.click(screen.getByRole("button", { name: /provider/i }));
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), { target: { value: "GoDaddy" } });
    fireEvent.click(screen.getByText(/Создать/));
    fireEvent.change(screen.getByPlaceholderText("e.g., Hostiq Main"), { target: { value: "gd" } });

    // Полей секретов нет вовсе.
    expect(screen.queryByPlaceholderText("••••••••")).toBeNull();
    expect(screen.queryByPlaceholderText("••••••••••••••••")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));

    // Ни одного блоба; тело без ссылок на секреты.
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(0);
    const [url, body] = mocks.apiPost.mock.calls[0];
    expect(url).toBe("/registrars/accounts");
    expect(body.provider).toBe("GoDaddy");
    expect(body).not.toHaveProperty("api_key_blob_id");
    expect(body).not.toHaveProperty("api_secret_blob_id");
    // Поле API User у ручного провайдера не показано — значит и уехать в аккаунт
    // ему нечем: `null`, а не пустая строка и не остаток от прошлого провайдера.
    expect(body.api_user).toBeNull();
  });

  it("ручной провайдер: упавшее создание показывает ошибку и не закрывает форму", async () => {
    // Ради этого теста ручной провайдер и идёт ЧЕРЕЗ `saveAll` с пустым
    // `secrets`, а не мимо хука: ветка в обход осталась бы без единственного
    // канала ошибки (`secrets.error`) и без `saving` на кнопке — упавший POST
    // не показал бы пользователю ничего.
    setTauri(true);
    mocks.apiPost.mockRejectedValue(new Error("provider name already taken"));

    renderPage([]);
    fireEvent.click((await screen.findAllByRole("button", { name: "+ Add Registrar" }))[0]);
    fireEvent.click(screen.getByRole("button", { name: /provider/i }));
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), { target: { value: "GoDaddy" } });
    fireEvent.click(screen.getByText(/Создать/));
    fireEvent.change(screen.getByPlaceholderText("e.g., Hostiq Main"), { target: { value: "gd" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "provider name already taken",
    );
    // Форма на экране: набранное имя цело, повтор не требует начинать заново.
    expect((screen.getByPlaceholderText("e.g., Hostiq Main") as HTMLInputElement).value).toBe("gd");
    // И кнопка снова рабочая — вторая половина того же утверждения: канал ошибки
    // без вернувшейся кнопки оставил бы форму, из которой видно отказ, но нельзя
    // повторить. Само имя «Add Account» (а не «Adding...») уже говорит, что
    // `saving` снят; `disabled` проверяем отдельно — гейт у кнопки не один.
    expect((screen.getByRole("button", { name: "Add Account" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("имя аккаунта уезжает в POST без пробелов по краям", async () => {
    // Создание и правка обязаны понимать имя одинаково: `EditRegistrarModal`
    // тримит его в `patch`, и без trim здесь первая же правка такого аккаунта
    // молча переименовала бы его — пользователь увидел бы изменение, которого не
    // просил. Сервер имя не чистит (`name: str` без валидатора), а гейт кнопки уже
    // считает пробельное имя пустым — значит и в тело POST оно идёт тримленным.
    setTauri(true);
    mocks.apiPost.mockResolvedValue({ ...NAMECHEAP, provider: "hostiq" });

    renderPage([]);
    await openAddModal("hostiq");
    fireEvent.change(screen.getByPlaceholderText("e.g., Hostiq Main"), {
      target: { value: "  reg-new  " },
    });
    fireEvent.change(screen.getByPlaceholderText("••••••••••••••••"), {
      target: { value: API_KEY },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    expect(mocks.apiPost.mock.calls[0][1].name).toBe("reg-new");
  });

  it("имя аккаунта обязательно: без него «Add Account» выключена", async () => {
    setTauri(true);
    renderPage([]);
    fireEvent.click((await screen.findAllByRole("button", { name: "+ Add Registrar" }))[0]);

    // Пустое имя — единственное, что отличает форму ручного провайдера от
    // готовой к отправке: секретов у него нет, и без этой проверки клик завёл бы
    // безымянный аккаунт.
    expect((screen.getByRole("button", { name: "Add Account" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("e.g., Hostiq Main"), { target: { value: "  " } });
    expect((screen.getByRole("button", { name: "Add Account" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("e.g., Hostiq Main"), { target: { value: "gd" } });
    expect((screen.getByRole("button", { name: "Add Account" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("объявленный, но пустой Client IP отказывает ДО первой записи блоба", async () => {
    setTauri(true);

    renderPage([]);
    await openAddModal("namecheap");
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: API_KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Client IP is required");
    // Проверка ДО первой записи: иначе блоб ключа уже лежал бы в хранилище от
    // формы, которая так и не создала аккаунт.
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("упавшая запись блоба не создаёт аккаунт и не молчит", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockRejectedValue(new Error("keychain locked"));

    renderPage([]);
    await openAddModal("namecheap");
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: API_KEY } });
    fireEvent.change(screen.getByPlaceholderText("127.0.0.1"), { target: { value: CLIENT_IP } });
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "keychain locked");
    // Аккаунт с NULL-ссылкой на ключ — 200 OK и мёртвый регистратор.
    expect(mocks.apiPost).not.toHaveBeenCalled();
    // Набранное цело: повтор не требует ходить за ключом в панель регистратора.
    expect((screen.getByPlaceholderText("••••••••") as HTMLInputElement).value).toBe(API_KEY);
  });

  it("правка: тронутый ключ перезаписывает ТОТ ЖЕ блоб, нетронутый IP не трогается", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...NAMECHEAP });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "✎ Edit" }));
    // С пробелами по краям: на правке цена нетримленного ключа выше — рабочий
    // блоб перезаписывается мусором, и вернуть его можно только перенабором.
    fireEvent.change(screen.getByPlaceholderText("Leave empty to keep current key"), {
      target: { value: "  rotated-key  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));

    // Ровно один блоб: пустое поле IP значит «не меняем», а не «сохрани пустой».
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(1);
    const key = blobOfKind("registrar_api_key");
    // Новый id здесь = аккаунт продолжает ходить в API со старым ключом.
    expect(key.blobId).toBe(KEY_BLOB);
    expect(blobPlaintext(key)).toBe("rotated-key");

    const [url, body] = mocks.apiPut.mock.calls[0];
    expect(url).toBe("/registrars/accounts/3");
    expect(body.api_key_blob_id).toBe(KEY_BLOB);
    // Нетронутого секрета в теле нет вовсе: сервер оставляет прежнюю ссылку.
    expect(body).not.toHaveProperty("api_secret_blob_id");
    expect(body).not.toHaveProperty("api_key");
  });

  it("правка: тронутый Client IP уезжает в свой блоб без пробелов по краям", async () => {
    // Отдельным тестом, а не строкой в предыдущем: там утверждение ровно
    // обратное — нетронутый IP не трогается. Поле правки у IP своё, и `trim` в
    // его onChange свой; без этого теста его снятие ничего бы не покрасило.
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...NAMECHEAP });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "✎ Edit" }));
    fireEvent.change(screen.getByPlaceholderText("Leave empty to keep current IP"), {
      target: { value: `  ${CLIENT_IP}  ` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));

    // Ровно один блоб: пустое поле ключа значит «не меняем».
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(1);
    const secret = blobOfKind("registrar_api_secret");
    // Новый id здесь = аккаунт продолжает ходить в API со старым IP.
    expect(secret.blobId).toBe(SECRET_BLOB);
    // IP с пробелом не совпадёт с whitelist Namecheap: отказ придёт от API, а
    // не от формы, и связи с набранным у него не будет.
    expect(blobPlaintext(secret)).toBe(CLIENT_IP);

    const body = mocks.apiPut.mock.calls[0][1];
    expect(body.api_secret_blob_id).toBe(SECRET_BLOB);
    expect(body).not.toHaveProperty("api_key_blob_id");
  });

  it("переименование без секретов не пишет ни одного блоба", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...NAMECHEAP });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "✎ Edit" }));
    fireEvent.change(screen.getByDisplayValue("nc-main"), { target: { value: "nc-renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(0);
    const body = mocks.apiPut.mock.calls[0][1];
    expect(body.name).toBe("nc-renamed");
    expect(body).not.toHaveProperty("api_key_blob_id");
    expect(body).not.toHaveProperty("api_secret_blob_id");
  });

  it("карточка ручного провайдера: подпись manual и без кнопки Test", async () => {
    setTauri(true);
    renderPage([{ id: 9, provider: "GoDaddy", name: "gd", api_user: null, is_active: true,
      api_key_blob_id: null, api_secret_blob_id: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]);

    expect(await screen.findByText(/GoDaddy · manual/)).toBeTruthy();
    // Аватар — сгенерированный, а не «?» на сером: это прямой пункт acceptance
    // criteria плана, и до него карточка красила «?» любому провайдеру вне
    // зашитой пары. Проверяем и букву, и отсутствие прежней заглушки.
    expect(screen.getByText("G")).toBeTruthy();
    expect(screen.queryByText("?")).toBeNull();
    // У ручного провайдера Test недостижим (десктоп вернул бы unknown provider).
    expect(screen.queryByRole("button", { name: "🔌 Test" })).toBeNull();
    // Правка и удаление остаются: ярлык переименовывают и убирают, как любой
    // другой аккаунт, — гейт по API касается только Test.
    expect(screen.getByRole("button", { name: "✎ Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "✕" })).toBeTruthy();
  });

  it("карточка API-провайдера сохраняет кнопку Test и api_user", async () => {
    setTauri(true);
    renderPage(); // NAMECHEAP по умолчанию
    expect(await screen.findByText(/Namecheap ·/)).toBeTruthy();
    expect(screen.getByText("ncuser")).toBeTruthy();
    expect(screen.getByRole("button", { name: "🔌 Test" })).toBeTruthy();
  });

  it("API-провайдер без api_user: подпись без висящей точки", async () => {
    // Состояние достижимо и из приложения, и из БД: `AddRegistrarModal` не
    // требует API User (кнопка гейтится только именем аккаунта), а колонка
    // nullable — старые строки и чужой импорт дают `null`. Подпись «Hostiq · »
    // с оборванным хвостом читается как «тут что-то было и пропало».
    setTauri(true);
    renderPage([{ id: 7, provider: "hostiq", name: "hq", api_user: null, is_active: true,
      api_key_blob_id: KEY_BLOB, api_secret_blob_id: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]);

    expect(await screen.findByText("Hostiq")).toBeTruthy();
    expect(screen.queryByText(/Hostiq ·/)).toBeNull();
    // Провайдер при этом остаётся API-провайдером: бейдж и Test — про
    // способность провайдера, а не про полноту учётки.
    expect(screen.getByRole("button", { name: "🔌 Test" })).toBeTruthy();
  });

  it("в вебе форма не открывается вовсе — объяснение стоит на месте кнопки", async () => {
    setTauri(false);
    renderPage([]);

    // Объяснение ДО клика, а не после: кнопка, за которой окно без единого
    // действия кроме Cancel, — это тупик, в который человека сначала завели.
    expect(await screen.findByText(DESKTOP_NOTE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+ Add Registrar" })).toBeNull();
    // Ни полей секретов, ни кнопки сохранения на экране.
    expect(screen.queryByPlaceholderText("••••••••")).toBeNull();
    expect(screen.queryByPlaceholderText("127.0.0.1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Account" })).toBeNull();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("сама форма в вебе не даёт ни полей секретов, ни кнопки сохранения", async () => {
    // Через страницу это уже не проверить: в вебе туда нет входа, и любое
    // утверждение о содержимом формы выполнялось бы вакуумно — гварды внутри
    // модалки перестали бы удерживаться хоть чем-то. Поэтому рендерим форму
    // НАПРЯМУЮ, как `Servers.sshblob` рендерит `AddServerModal`, и проходим ОБА
    // провайдера: у Hostiq гвард один, у Namecheap — два.
    setTauri(false);
    const onClose = vi.fn();
    renderWithClient(<AddRegistrarModal onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText("e.g., Hostiq Main"), {
      target: { value: "reg-new" },
    });
    expect(screen.queryByPlaceholderText("••••••••••••••••")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /provider/i }));
    fireEvent.click(screen.getByRole("option", { name: /Namecheap/ }));
    expect(screen.queryByPlaceholderText("••••••••")).toBeNull();
    expect(screen.queryByPlaceholderText("127.0.0.1")).toBeNull();

    expect(screen.getAllByText(DESKTOP_NOTE).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Add Account" })).toBeNull();
    // Выход у формы есть всегда — окно без единого действия было бы тупиком.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();

    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("удаление аккаунта снимает оба его блоба — после самого удаления", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(true);
    mocks.apiDelete.mockResolvedValue(undefined);

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "✕" }));

    await expectBlobsGoneAfterEntity({
      apiDelete: mocks.apiDelete,
      invokeIfTauri: mocks.invokeIfTauri,
      url: "/registrars/accounts/3",
      blobIds: [KEY_BLOB, SECRET_BLOB],
    });
  });

  it("упавшая уборка блоба не отменяет удаление и не мешает второму блобу", async () => {
    setTauri(true);
    mocks.apiDelete.mockResolvedValue(undefined);
    mocks.invokeIfTauri.mockRejectedValue(new Error("blob storage down"));

    // Осиротевший блоб не виден никому, а красное на удалённом аккаунте — это
    // вопрос «так удалился или нет?», ответа на который у пользователя нет.
    // Падение на первом id не отменяет попытку по второму — иначе второй секрет
    // оставался бы в хранилище всегда, когда первый уже не удаётся стереть.
    await expectDeleteIgnoresBlobFailure(useDeleteRegistrarAccount, NAMECHEAP);
    expect(deletedBlobIds(mocks.invokeIfTauri)).toEqual([KEY_BLOB, SECRET_BLOB]);
  });

  it("пробел в поле ключа не перезаписывает живой блоб", async () => {
    // `" "` проходил и «поле тронуто?» формы, и проверку пустоты в хуке, и
    // уезжал в `putSecretBlob` с СУЩЕСТВУЮЩИМ blob_id — то есть затирал рабочий
    // ключ пробелом, а вернуть его можно было только перенабором.
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...NAMECHEAP });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "✎ Edit" }));
    fireEvent.change(screen.getByPlaceholderText("Leave empty to keep current key"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(0);
    expect(mocks.apiPut.mock.calls[0][1]).not.toHaveProperty("api_key_blob_id");
  });
});
