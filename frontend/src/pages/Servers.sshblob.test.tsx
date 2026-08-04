import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AddServerModal } from "./Servers";
import { b64ToU8 } from "../lib/b64";
import { useAuthStore } from "../store/auth";
import { setTauri, UUID_V4, putBlobArgs, putBlobCalls } from "../test/secretBlobKit";

/**
 * Форма слала `ssh_password` плейнтекстом — поля, которого нет в `ServerCreate`
 * на бэкенде: с `extra="ignore"` оно молча выбрасывалось, сервер создавался с
 * `ssh_password_blob_id = NULL` и отвечал 200 OK, а дальше падала любая
 * SSH-команда. Поэтому главное утверждение здесь — не «блоб записан», а
 * «в теле POST пароля НЕТ, а ссылка на блоб ЕСТЬ».
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
// `vault_put_blob` — вид секрета, байты пароля, id. С заглушкой над
// `putSecretBlob` форма, отправляющая в блоб не тот секрет или не тот kind,
// прошла бы тест.
vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

// К добавлению сервера отношения не имеет, а тянет парсер CSV.
vi.mock("../components/ServerBulkImportDialog", () => ({ default: () => null }));

const SSH_PW = "s3cret-ssh-pw";
const FP_PW = "fastpanel-pw";
const DESKTOP_NOTE = "Saving secrets runs in the SDMP desktop app.";

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <AddServerModal onClose={onClose} />
      </QueryClientProvider>,
    ),
  };
}

function fillInstallTab(password?: string) {
  fireEvent.change(screen.getByPlaceholderText("e.g., production-web-01"), {
    target: { value: "srv-1" },
  });
  fireEvent.change(screen.getByPlaceholderText("e.g., 192.168.1.100"), {
    target: { value: "10.0.0.7" },
  });
  if (password !== undefined) {
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: password } });
  }
}

describe("AddServerModal — SSH-пароль через блоб", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  });

  afterEach(() => {
    cleanup();
    setTauri(false);
    useAuthStore.getState().clear();
  });

  it("в десктопе шлёт ssh_password_blob_id и НЕ шлёт ssh_password", async () => {
    setTauri(true);
    mocks.apiPost.mockResolvedValue({ id: 1 });

    const { onClose } = renderModal();
    fillInstallTab(SSH_PW);
    fireEvent.click(screen.getByRole("button", { name: "Add Server" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));

    const blob = putBlobArgs(mocks.invokeIfTauri);
    expect(blob.userId).toBe("user-1");
    expect(blob.blobKind).toBe("server_ssh_password");
    expect(blob.blobId).toMatch(UUID_V4);
    // Именно набранный пароль, байт в байт: kind и plaintext — два соседних
    // строковых аргумента команды, и перепутать их значит записать пароль в
    // `blob_kind` (а оттуда в audit-метаданные).
    expect(new TextDecoder().decode(b64ToU8(blob.plaintextB64))).toBe(SSH_PW);

    const [url, body] = mocks.apiPost.mock.calls[0];
    expect(url).toBe("/servers");
    expect(body.ssh_password_blob_id).toBe(blob.blobId);
    // Ради этой строки и затевался спринт: поля нет, а не «есть, но сервер его
    // игнорирует».
    expect(body).not.toHaveProperty("ssh_password");
    expect(JSON.stringify(body)).not.toContain(SSH_PW);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("упавшая запись блоба не создаёт сервер и не молчит", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockRejectedValue(new Error("keychain locked"));

    const { onClose } = renderModal();
    fillInstallTab(SSH_PW);
    fireEvent.click(screen.getByRole("button", { name: "Add Server" }));

    // Ошибка — в форме, куда пользователь сейчас смотрит, и той же фразой, что
    // в модалке SSH на карточке сервера.
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "keychain locked");
    // Сервер без секрета — это ровно тот 200 OK, после которого баннер «SSH не
    // настроен» не уходит никогда.
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("второй клик в окне записи блоба не пишет второй блоб", async () => {
    setTauri(true);
    // Запись блоба и создание сервера идут асинхронно; пока они идут, кнопка
    // обязана быть мёртвой. Иначе двойной клик оставляет лишний блоб и второй
    // сервер с тем же IP.
    let releaseBlob: () => void = () => {};
    mocks.invokeIfTauri.mockReturnValue(new Promise<void>((r) => { releaseBlob = () => r(); }));
    mocks.apiPost.mockResolvedValue({ id: 1 });

    renderModal();
    fillInstallTab(SSH_PW);
    const btn = screen.getByRole("button", { name: "Add Server" }) as HTMLButtonElement;
    fireEvent.click(btn);

    await waitFor(() => expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(1));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Adding..." }) as HTMLButtonElement).disabled).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Adding..." }));

    releaseBlob();
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(1);
  });

  it("пароль не переезжает с вкладки connect на install", async () => {
    setTauri(true);
    mocks.apiPost.mockResolvedValue({ id: 1 });

    renderModal();
    // На connect в поле «Password» набирают пароль ПАНЕЛИ. Уехав на install,
    // он был бы записан в блоб как SSH-пароль сервера — секрет не того вида под
    // не тем `blobKind`.
    fireEvent.click(screen.getByText(/Connect Existing Fastpanel/));
    fireEvent.change(screen.getByPlaceholderText("Enter password"), { target: { value: FP_PW } });
    fireEvent.click(screen.getByText(/Install New Fastpanel/));

    expect((screen.getByPlaceholderText("••••••••") as HTMLInputElement).value).toBe("");
    fillInstallTab(SSH_PW);
    fireEvent.click(screen.getByRole("button", { name: "Add Server" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    const blob = putBlobArgs(mocks.invokeIfTauri);
    expect(new TextDecoder().decode(b64ToU8(blob.plaintextB64))).toBe(SSH_PW);
  });

  it("в вебе поля пароля нет вовсе, а есть общая фраза про десктоп", async () => {
    setTauri(false);
    const { container } = renderModal();

    // Шифрует Rust мастер-ключом из keychain — из браузера секрет не сохранить.
    // Поле, в которое дали набрать пароль, обещало бы обратное.
    expect(screen.queryByPlaceholderText("••••••••")).toBeNull();
    expect(screen.getByText(DESKTOP_NOTE)).toBeTruthy();

    // Сервер без SSH завести законно — форма остаётся, но её действие ведёт в
    // десктоп тем же deep link'ом, что и остальные исполняющие действия.
    const link = container.querySelector('a[href^="sdmp://add-server"]');
    expect(link).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add Server" })).toBeNull();

    fillInstallTab();
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });
});
