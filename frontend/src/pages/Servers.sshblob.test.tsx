import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AddServerModal } from "./Servers";
import { b64ToU8 } from "../lib/b64";
import { useAuthStore } from "../store/auth";

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

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SSH_PW = "s3cret-ssh-pw";

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function putBlobArgs(): Record<string, any> {
  const calls = mocks.invokeIfTauri.mock.calls.filter((c: unknown[]) => c[0] === "vault_put_blob");
  if (calls.length !== 1) throw new Error(`vault_put_blob вызвана ${calls.length} раз, ожидался 1`);
  return calls[0][1] as Record<string, any>;
}

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

    const blob = putBlobArgs();
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
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

    const { onClose } = renderModal();
    fillInstallTab(SSH_PW);
    fireEvent.click(screen.getByRole("button", { name: "Add Server" }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(String(alertSpy.mock.calls[0][0])).toContain("keychain locked");
    // Сервер без секрета — это ровно тот 200 OK, после которого баннер «SSH не
    // настроен» не уходит никогда.
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it("в вебе поля пароля нет вовсе, а есть общая фраза про десктоп", async () => {
    setTauri(false);
    const { container } = renderModal();

    // Шифрует Rust мастер-ключом из keychain — из браузера секрет не сохранить.
    // Поле, в которое дали набрать пароль, обещало бы обратное.
    expect(screen.queryByPlaceholderText("••••••••")).toBeNull();
    expect(screen.getByText("Saving secrets runs in the SDMP desktop app.")).toBeTruthy();

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
