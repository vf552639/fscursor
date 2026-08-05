import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";

import { AddServerModal } from "./Servers";
import { b64ToU8 } from "../lib/b64";
import {
  setTauri,
  UUID_V4,
  putBlobArgs,
  putBlobCalls,
  renderWithClient,
  secretBlobLifecycle,
  BLOB_USER_ID,
  DESKTOP_NOTE,
} from "../test/secretBlobKit";

/**
 * Вкладка connect теряла пароль панели ровно так же, как install терял
 * SSH-пароль: `fastpanel_password` в `ServerCreate` не объявлен, тогдашний
 * `extra="ignore"` его выбрасывал, сервер создавался с
 * `fastpanel_password_blob_id = NULL` и отвечал 200 OK (сегодня схема стоит с
 * `extra="forbid"` — это 422, и стережёт его бэкенд-тест
 * `tests/test_secret_write_path.py`). Отличие одно и оно важно для веба:
 * сервер, подключаемый к УЖЕ стоящей панели, без её пароля бесполезен
 * целиком — поэтому здесь же проверяется, что из браузера такой сервер не
 * завести никак.
 *
 * Сброс поля панели при смене вкладки лежит в `Servers.sshblob.test.tsx`: там
 * обе вкладки в одном сценарии, и красный тест придёт оттуда.
 */

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  invokeIfTauri: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiPost: mocks.apiPost,
}));

// Мокаем транспорт, а не сам `secretBlob`: тест обязан видеть, ЧТО уехало в
// `vault_put_blob`. С заглушкой над `putSecretBlob` форма, записавшая пароль
// панели под `blobKind: server_ssh_password`, прошла бы тест.
vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

// К добавлению сервера отношения не имеет, а тянет парсер CSV.
vi.mock("../components/ServerBulkImportDialog", () => ({ default: () => null }));

const FP_PW = "fastpanel-pw";

function renderModal(onClose = vi.fn()) {
  // Подсказки провайдеров тут ни при чём — пустым списком; за их содержимое
  // отвечает Servers.provider.test.tsx.
  return { onClose, ...renderWithClient(<AddServerModal onClose={onClose} providers={[]} />) };
}

function openConnectTab() {
  fireEvent.click(screen.getByRole("button", { name: /Connect Existing Fastpanel/ }));
}

function fillConnectTab(password: string) {
  fireEvent.change(screen.getByPlaceholderText("e.g., production-web-01"), {
    target: { value: "srv-fp" },
  });
  fireEvent.change(screen.getByPlaceholderText("https://192.168.1.100:8888"), {
    target: { value: "https://10.0.0.9:8888" },
  });
  fireEvent.change(screen.getByPlaceholderText("Enter login"), {
    target: { value: "fastuser" },
  });
  fireEvent.change(screen.getByPlaceholderText("Enter password"), {
    target: { value: password },
  });
}

describe("AddServerModal — пароль FastPanel через блоб", () => {
  secretBlobLifecycle();

  it("в десктопе шлёт fastpanel_password_blob_id и НЕ шлёт fastpanel_password", async () => {
    setTauri(true);
    mocks.apiPost.mockResolvedValue({ id: 2 });

    const { onClose } = renderModal();
    openConnectTab();
    fillConnectTab(FP_PW);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));

    const blob = putBlobArgs(mocks.invokeIfTauri);
    expect(blob.userId).toBe(BLOB_USER_ID);
    // Вид секрета — не косметика: под ним блоб лежит в хранилище и по нему его
    // ищут 26 команд. Пароль панели под `server_ssh_password` — это ссылка,
    // которую откроет не тот потребитель.
    expect(blob.blobKind).toBe("server_fastpanel_password");
    expect(blob.blobId).toMatch(UUID_V4);
    expect(new TextDecoder().decode(b64ToU8(blob.plaintextB64))).toBe(FP_PW);

    const [url, body] = mocks.apiPost.mock.calls[0];
    expect(url).toBe("/servers");
    expect(body.fastpanel_password_blob_id).toBe(blob.blobId);
    // Ради этой строки и затевался спринт: поля нет, а не «есть, но сервер его
    // игнорирует».
    expect(body).not.toHaveProperty("fastpanel_password");
    expect(JSON.stringify(body)).not.toContain(FP_PW);
    // Остальное тело вкладки connect не пострадало от переезда пароля.
    expect(body.fastpanel_user).toBe("fastuser");
    expect(body.fastpanel_url).toBe("https://10.0.0.9:8888");

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("упавшая запись блоба не создаёт сервер и не молчит", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockRejectedValue(new Error("keychain locked"));

    const { onClose } = renderModal();
    openConnectTab();
    fillConnectTab(FP_PW);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Ошибка — в форме, а не в `alert`: пользователь вернётся к тому же полю.
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "keychain locked");
    // Сервер с `fastpanel_password_blob_id = NULL` — это 200 OK и панель, к
    // которой нельзя подключиться; лучше не создавать его вовсе.
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("во время записи блоба уйти на соседнюю вкладку нельзя", async () => {
    // Иначе `setError` упавшей записи приземлится на хук скрытой вкладки:
    // ни сообщения, ни сервера, а плейнтекст для повтора уже стёрт `reset`.
    // Окно — весь round-trip `vault_put_blob` (это PUT на бэкенд, а не
    // локальное шифрование), то есть ровно столько, сколько человек скучает.
    setTauri(true);
    let failBlob: (e: Error) => void = () => {};
    mocks.invokeIfTauri.mockReturnValue(new Promise<void>((_, reject) => { failBlob = reject; }));

    renderModal();
    openConnectTab();
    fillConnectTab(FP_PW);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: /Install New Fastpanel/ }));

    failBlob(new Error("keychain locked"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "keychain locked");
    // Остались на connect, и набранный пароль цел: повтор не требует набирать
    // его заново — ради этого хук и держит плейнтекст до успеха.
    expect((screen.getByPlaceholderText("Enter password") as HTMLInputElement).value).toBe(FP_PW);
  });

  it("URL с кредами внутри не уходит на сервер и не жжёт блоб", async () => {
    // Схема `ServerCreate` такой URL отвергает (долг №10), а её 422 приезжает
    // в форму как `[object Object]` — значит промах должен ловиться здесь и
    // называться словами. Блоб при этом не пишется вовсе: порядок в `handleAdd`
    // — сначала `validate()`, потом `save()`, и провал проверки не должен
    // оставлять в хранилище пароль от несозданного сервера.
    setTauri(true);
    const { onClose } = renderModal();
    openConnectTab();
    fillConnectTab(FP_PW);
    fireEvent.change(screen.getByPlaceholderText("https://192.168.1.100:8888"), {
      target: { value: "https://fastuser:panelpw@10.0.0.9:8888" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/must not be stored in the URL/)).toBeTruthy();
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("в вебе connect не даёт ни поля, ни кнопки — только путь в десктоп", async () => {
    setTauri(false);
    const { container } = renderModal();
    openConnectTab();

    // Поля нет вовсе: шифрует Rust мастер-ключом из keychain, и поле, в которое
    // дали набрать пароль, обещало бы сохранение уже после того, как он набран.
    expect(screen.queryByPlaceholderText("Enter password")).toBeNull();
    expect(screen.getByText(DESKTOP_NOTE)).toBeTruthy();

    // Кнопки сохранения в вебе нет ни на одной вкладке — это общее поведение
    // формы, не связанное с паролем. Здесь оно нужно как гарантия: без поля
    // пароля connect создавал бы сервер, к панели которого нечем подключиться,
    // поэтому единственное действие — тот же deep link, что у прочих
    // исполняющих действий.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(container.querySelector('a[href^="sdmp://add-server"]')).toBeTruthy();
  });
});
