import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";

import Cloudflare from "./Cloudflare";
import { useDeleteCloudflareAccount } from "../api/cloudflare";
import { b64ToU8 } from "../lib/b64";
import {
  setTauri,
  UUID_V4,
  putBlobArgs,
  putBlobCalls,
  deletedBlobIds,
  renderWithClient,
  renderHookWithClient,
  secretBlobLifecycle,
  BLOB_USER_ID,
  DESKTOP_NOTE,
} from "../test/secretBlobKit";

/**
 * Форма Cloudflare слала `api_token` плейнтекстом — поля, которого нет в
 * `CloudflareAccountCreate`/`Update` на бэкенде: с `extra="ignore"` оно молча
 * выбрасывалось, аккаунт заводился с `api_token_blob_id = NULL` и отвечал
 * 200 OK, а дальше падали все cf-команды («зоны не грузятся», «токен не
 * настроен»). Поэтому главное утверждение здесь — не «блоб записан», а «в теле
 * запроса токена НЕТ, а ссылка на блоб ЕСТЬ».
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  invokeIfTauri: vi.fn(),
}));

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

describe("Cloudflare — api_token через блоб", () => {
  secretBlobLifecycle();

  it("в десктопе шлёт api_token_blob_id и НЕ шлёт api_token", async () => {
    setTauri(true);
    mocks.apiPost.mockResolvedValue({ ...ACC, id: 6, sync_result: { updated: 2, skipped: 0, total_zones: 2 } });

    renderPage([]);
    await openAddModal();
    fillAddModal(TOKEN);
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));

    const blob = putBlobArgs(mocks.invokeIfTauri);
    expect(blob.userId).toBe(BLOB_USER_ID);
    // Вид секрета — не косметика: под ним блоб лежит в хранилище, и токен,
    // записанный как `server_ssh_password`, найдёт не тот потребитель.
    expect(blob.blobKind).toBe("cloudflare_api_token");
    expect(blob.blobId).toMatch(UUID_V4);
    expect(new TextDecoder().decode(b64ToU8(blob.plaintextB64))).toBe(TOKEN);

    const [url, body] = mocks.apiPost.mock.calls[0];
    expect(url).toBe("/cloudflare/accounts");
    expect(body.api_token_blob_id).toBe(blob.blobId);
    // Ради этой строки и затевался спринт: поля нет, а не «есть, но сервер его
    // игнорирует».
    expect(body).not.toHaveProperty("api_token");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(body.name).toBe("cf-new");

    // Итог синхронизации зон показывается по-прежнему: перевод формы на
    // `mutateAsync` не должен был съесть ответ создания.
    expect(await screen.findByText(/Linked Cloudflare to 2 existing domains/)).toBeTruthy();
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
    fireEvent.change(screen.getByPlaceholderText("Leave empty to keep current"), {
      target: { value: TOKEN },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));

    const blob = putBlobArgs(mocks.invokeIfTauri);
    // Новый id здесь = аккаунт продолжает указывать на старый токен.
    expect(blob.blobId).toBe(EXISTING_BLOB);
    expect(blob.blobKind).toBe("cloudflare_api_token");

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

  it("удаление аккаунта снимает и его блоб — после самого удаления", async () => {
    setTauri(true);
    vi.stubGlobal("confirm", vi.fn(() => true));
    mocks.apiDelete.mockResolvedValue(undefined);

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "✕" }));

    await waitFor(() => expect(deletedBlobIds(mocks.invokeIfTauri)).toEqual([EXISTING_BLOB]));
    expect(mocks.apiDelete).toHaveBeenCalledWith("/cloudflare/accounts/5");
    // Порядок обратен записи: сначала сущность, потом блоб. Наоборот — это
    // живой аккаунт со ссылкой на стёртый блоб, если DELETE не доедет.
    const deleteBlobCall = mocks.invokeIfTauri.mock.invocationCallOrder[0];
    expect(mocks.apiDelete.mock.invocationCallOrder[0]).toBeLessThan(deleteBlobCall);
  });

  it("упавшая уборка блоба не делает удаление аккаунта проваленным", async () => {
    setTauri(true);
    mocks.apiDelete.mockResolvedValue(undefined);
    mocks.invokeIfTauri.mockRejectedValue(new Error("blob storage down"));

    const { result } = renderHookWithClient(() => useDeleteCloudflareAccount());
    // Осиротевший блоб не виден никому и ничему не мешает, а красное на
    // удалённом аккаунте — это вопрос «так удалился или нет?», ответа на
    // который у пользователя нет.
    await act(async () => {
      await result.current.mutateAsync(ACC as any);
    });
    expect(mocks.apiDelete).toHaveBeenCalledWith("/cloudflare/accounts/5");
    expect(result.current.isError).toBe(false);
  });
});
