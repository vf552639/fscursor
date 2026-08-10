import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";

import Cloudflare, { AddCfAccountModal } from "./Cloudflare";
import { useDeleteCloudflareAccount } from "../api/cloudflare";
import {
  setTauri,
  UUID_V4,
  putBlobArgs,
  putBlobCalls,
  blobPlaintext,
  expectBlobsGoneAfterEntity,
  expectDeleteIgnoresBlobFailure,
  renderWithClient,
  secretBlobLifecycle,
  BLOB_USER_ID,
  DESKTOP_NOTE,
} from "../test/secretBlobKit";

/**
 * Форма Cloudflare слала `api_token` плейнтекстом — поля, которого нет в
 * `CloudflareAccountCreate`/`Update` на бэкенде: с тогдашним `extra="ignore"`
 * оно молча выбрасывалось, аккаунт заводился с `api_token_blob_id = NULL` и
 * отвечал 200 OK, а дальше падали все cf-команды («зоны не грузятся», «токен
 * не настроен»). Поэтому главное утверждение здесь — не «блоб записан», а «в
 * теле запроса токена НЕТ, а ссылка на блоб ЕСТЬ».
 *
 * Сегодня схемы стоят с `extra="forbid"`, и такое тело получило бы 422, — но
 * тест на это живёт в бэкенде (`tests/test_secret_write_path.py`): здесь
 * `apiPost` замокан, сервера в сценарии нет вовсе, и его отказ ничего бы не
 * доказал. Здесь стережётся содержимое тела.
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

// Транспорт, а не `secretBlob`: тест обязан видеть, ЧТО уехало в
// `vault_put_blob`. С заглушкой над `putSecretBlob` форма, записавшая токен под
// чужим `blobKind` или потерявшая существующий id, прошла бы тест.
vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

// Список зон к записи токена отношения не имеет, а ходит в Tauri мимо мока
// транспорта (`invokeSynced`) и тянет локальный кэш.
vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: vi.fn(async () => []),
  syncLocalCache: vi.fn(async () => {}),
}));

// Тянет argon2/libsodium и к записи токена отношения не имеет.
vi.mock("../components/RevealSecret", () => ({
  RevealSecret: () => <span>reveal</span>,
}));

const EXISTING_BLOB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TOKEN = "cf-token-42";

const ACC = {
  id: 5,
  name: "cf-main",
  account_id: "acc-1",
  is_active: true,
  api_token_blob_id: EXISTING_BLOB,
  api_token_masked: "••••eeee",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function renderPage(accounts: any[] = [ACC]) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/cloudflare/accounts") return accounts;
    if (url === "/domains") return [];
    throw new Error(`unexpected GET ${url}`);
  });
  return renderWithClient(<Cloudflare />);
}

async function openAddModal() {
  fireEvent.click((await screen.findAllByRole("button", { name: "+ Add Account" }))[0]);
}

function fillAddModal(token?: string) {
  fireEvent.change(screen.getByPlaceholderText("e.g., Main CF Account"), {
    target: { value: "cf-new" },
  });
  fireEvent.change(screen.getByPlaceholderText("abc123def456..."), {
    target: { value: "acc-9" },
  });
  if (token !== undefined) {
    fireEvent.change(screen.getByPlaceholderText("••••••••••••••••"), {
      target: { value: token },
    });
  }
}

async function openEditModal() {
  fireEvent.click(await screen.findByRole("button", { name: "✎ Edit" }));
}

/** Тело карточки (там, где жил блок токена) свёрнуто по умолчанию. */
async function expandCard() {
  fireEvent.click(await screen.findByLabelText(`Свернуть/развернуть аккаунт ${ACC.name}`));
}

describe("Cloudflare — api_token через блоб", () => {
  secretBlobLifecycle();

  it("в десктопе шлёт api_token_blob_id и НЕ шлёт api_token", async () => {
    setTauri(true);
    mocks.apiPost.mockResolvedValue({ ...ACC, id: 6 });

    renderPage([]);
    await openAddModal();
    // С пробелами по краям, а не начисто: токен копируют из панели Cloudflare
    // вместе с `\n`, и зашифрованный вместе с ним он даёт 403 на Test
    // connection без всякой связи с формой. Утверждение ниже — про содержимое
    // блоба: `"   "` отбивался бы и без `trim` (пустое поле), а такой ввод — нет.
    fillAddModal(`  ${TOKEN}  `);
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));

    const blob = putBlobArgs(mocks.invokeIfTauri);
    expect(blob.userId).toBe(BLOB_USER_ID);
    // Вид секрета — не косметика: под ним блоб лежит в хранилище, и токен,
    // записанный как `server_ssh_password`, найдёт не тот потребитель.
    expect(blob.blobKind).toBe("cloudflare_api_token");
    expect(blob.blobId).toMatch(UUID_V4);
    expect(blobPlaintext(blob)).toBe(TOKEN);

    const [url, body] = mocks.apiPost.mock.calls[0];
    expect(url).toBe("/cloudflare/accounts");
    expect(body.api_token_blob_id).toBe(blob.blobId);
    // Ради этой строки и затевался спринт: поля нет, а не «есть, но сервер его
    // игнорирует».
    expect(body).not.toHaveProperty("api_token");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(body.name).toBe("cf-new");

    // Итог создания показывается по-прежнему: перевод формы на `mutateAsync`
    // не должен был съесть ответ. Что именно в нём написано — в
    // `Cloudflare.createstatus.test.tsx`.
    expect(await screen.findByText("Cloudflare account created.")).toBeTruthy();
  });

  it("упавшая запись блоба не создаёт аккаунт и не молчит", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockRejectedValue(new Error("keychain locked"));

    renderPage([]);
    await openAddModal();
    fillAddModal(TOKEN);
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "keychain locked");
    // Аккаунт с `api_token_blob_id = NULL` — это 200 OK и Cloudflare, который
    // не отвечает ни на один запрос; лучше не заводить его вовсе.
    expect(mocks.apiPost).not.toHaveBeenCalled();
    // Модалка осталась открытой, и набранный токен цел: повтор не требует
    // ходить за ним в Cloudflare заново.
    expect((screen.getByPlaceholderText("••••••••••••••••") as HTMLInputElement).value).toBe(TOKEN);
  });

  it("правка перезаписывает ТОТ ЖЕ блоб и шлёт только его id", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...ACC });

    renderPage();
    await openEditModal();
    // Тоже с пробелами по краям: на правке цена нетримленного токена выше —
    // рабочий блоб перезаписывается мусором, и вернуть его можно только
    // перенабором.
    fireEvent.change(screen.getByPlaceholderText("Leave empty to keep current"), {
      target: { value: `  ${TOKEN}  ` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));

    const blob = putBlobArgs(mocks.invokeIfTauri);
    // Новый id здесь = аккаунт продолжает указывать на старый токен.
    expect(blob.blobId).toBe(EXISTING_BLOB);
    expect(blob.blobKind).toBe("cloudflare_api_token");
    expect(blobPlaintext(blob)).toBe(TOKEN);

    const [url, body] = mocks.apiPut.mock.calls[0];
    expect(url).toBe("/cloudflare/accounts/5");
    expect(body.api_token_blob_id).toBe(EXISTING_BLOB);
    expect(body).not.toHaveProperty("api_token");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("переименование без токена не трогает блоб и не шлёт его id", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...ACC });

    renderPage();
    await openEditModal();
    fireEvent.change(screen.getByDisplayValue("cf-main"), { target: { value: "cf-renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    // Пустое поле — это «оставь текущий», а не «сохрани пустой токен»: блоба из
    // нуля байт быть не должно, и `api_token_blob_id` в PATCH тоже.
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(0);
    const body = mocks.apiPut.mock.calls[0][1];
    expect(body.name).toBe("cf-renamed");
    expect(body).not.toHaveProperty("api_token_blob_id");
  });

  it("в вебе форма не открывается вовсе — объяснение стоит на месте кнопки", async () => {
    setTauri(false);
    renderPage([]);

    // Объяснение ДО клика, а не после: кнопка, за которой окно без единого
    // действия кроме Cancel, — это тупик, в который человека сначала завели.
    expect(await screen.findByText(DESKTOP_NOTE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+ Add Account" })).toBeNull();
    // Ни поля токена, ни кнопки сохранения: без входа в модалку их и не
    // отрисовать, но проверяем именно отсутствие на экране — это то, что видит
    // пользователь.
    expect(screen.queryByPlaceholderText("••••••••••••••••")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Account" })).toBeNull();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("сама форма в вебе не даёт ни поля токена, ни кнопки сохранения", async () => {
    // Через страницу это уже не проверить: в вебе туда нет входа, и любое
    // утверждение о содержимом формы выполнялось бы вакуумно — гвард внутри
    // модалки перестал бы удерживаться хоть чем-то. Поэтому рендерим форму
    // НАПРЯМУЮ, как `Servers.sshblob` рендерит `AddServerModal`: этот тест
    // держит последний рубеж независимо от того, как страница гейтит вход.
    setTauri(false);
    const onClose = vi.fn();
    renderWithClient(<AddCfAccountModal onClose={onClose} onStatus={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("e.g., Main CF Account"), {
      target: { value: "cf-new" },
    });
    expect(screen.queryByPlaceholderText("••••••••••••••••")).toBeNull();
    expect(screen.getByText(DESKTOP_NOTE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add Account" })).toBeNull();
    // Выход у формы есть всегда — окно без единого действия было бы тупиком.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();

    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("удаление аккаунта снимает и его блоб — после самого удаления", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(true);
    mocks.apiDelete.mockResolvedValue(undefined);

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "✕" }));

    await expectBlobsGoneAfterEntity({
      apiDelete: mocks.apiDelete,
      invokeIfTauri: mocks.invokeIfTauri,
      url: "/cloudflare/accounts/5",
      blobIds: [EXISTING_BLOB],
    });
  });

  it("упавшая уборка блоба не делает удаление аккаунта проваленным", async () => {
    setTauri(true);
    mocks.apiDelete.mockResolvedValue(undefined);
    mocks.invokeIfTauri.mockRejectedValue(new Error("blob storage down"));

    // Осиротевший блоб не виден никому и ничему не мешает, а красное на
    // удалённом аккаунте — это вопрос «так удалился или нет?», ответа на
    // который у пользователя нет. `ACC` идёт в хук без каста: заодно держим его
    // сигнатуру `Pick<CloudflareAccount, "id" | "api_token_blob_id">`.
    await expectDeleteIgnoresBlobFailure(useDeleteCloudflareAccount, ACC);
    expect(mocks.apiDelete).toHaveBeenCalledWith("/cloudflare/accounts/5");
  });

  it("в вебе карточка даёт расшифровать токен по блобу, а не показывает хвост blob_id", async () => {
    // Под подписью «Token: ••••xxxx» стоял хвост `api_token_blob_id`: с
    // переездом на блобы плейнтекстовой колонки не стало, и маскировать было
    // нечего. Сверять этот хвост с панелью Cloudflare бесполезно, а выглядел он
    // как «вот твой токен». Настоящий токен вебу отдаёт только RevealSecret —
    // расшифровкой блоба на клиенте.
    setTauri(false);
    renderPage();
    await expandCard();

    expect(within(screen.getByTestId("account-token")).getByText("reveal")).toBeTruthy();
    expect(screen.queryByText(/Token:/)).toBeNull();
    expect(screen.queryByText(ACC.api_token_masked)).toBeNull();
  });

  it("в десктопе блока токена нет вовсе — ни строки, ни пустой полосы", async () => {
    // В десктопе `RevealSecret` не нужен (токен проверяют кнопкой Test), и
    // после удаления строки внутри блока не остаётся ничего: отрисованный, он
    // был бы полосой с рамкой ни о чём.
    setTauri(true);
    renderPage();
    await expandCard();

    // Карточка действительно раскрыта — иначе утверждения ниже вакуумны.
    expect(await screen.findByText(/^Zones \(/)).toBeTruthy();
    expect(screen.queryByTestId("account-token")).toBeNull();
    expect(screen.queryByText(/Token:/)).toBeNull();
    expect(screen.queryByText(ACC.api_token_masked)).toBeNull();
  });

  it("пробел в поле токена не перезаписывает живой блоб", async () => {
    // `" "` проходил и «поле пустое?» формы, и проверку пустоты в хуке, и
    // уезжал в `putSecretBlob` с СУЩЕСТВУЮЩИМ blob_id — то есть затирал рабочий
    // токен пробелом, а вернуть его можно было только перенабором. Ровно тот же
    // класс потери, ради которого затевался спринт, только на шаг позже.
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...ACC });

    renderPage();
    await openEditModal();
    fireEvent.change(screen.getByPlaceholderText("Leave empty to keep current"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(0);
    expect(mocks.apiPut.mock.calls[0][1]).not.toHaveProperty("api_token_blob_id");
  });
});
