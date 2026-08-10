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
 * Форма слала `ssh_password` плейнтекстом — поля, которого нет в `ServerCreate`
 * на бэкенде: с тогдашним `extra="ignore"` оно молча выбрасывалось, сервер
 * создавался с `ssh_password_blob_id = NULL` и отвечал 200 OK, а дальше падала
 * любая SSH-команда. Поэтому главное утверждение здесь — не «блоб записан», а
 * «в теле POST пароля НЕТ, а ссылка на блоб ЕСТЬ».
 *
 * Сегодня схема стоит с `extra="forbid"` и такое тело получает 422, но это
 * утверждение бэкенд-теста (`tests/test_secret_write_path.py`): здесь `apiPost`
 * замокан, сервера в сценарии нет, и его отказ ничего бы не доказал.
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

function renderModal(onClose = vi.fn()) {
  // Подсказки провайдеров тут ни при чём — пустым списком; за их содержимое
  // отвечает Servers.provider.test.tsx.
  return { onClose, ...renderWithClient(<AddServerModal onClose={onClose} providers={[]} />) };
}

function fillForm(password?: string) {
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
  secretBlobLifecycle();

  it("в десктопе шлёт ssh_password_blob_id и НЕ шлёт ssh_password", async () => {
    setTauri(true);
    mocks.apiPost.mockResolvedValue({ id: 1 });

    const { onClose } = renderModal();
    fillForm(SSH_PW);
    fireEvent.click(screen.getByRole("button", { name: "Add Server" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));

    const blob = putBlobArgs(mocks.invokeIfTauri);
    expect(blob.userId).toBe(BLOB_USER_ID);
    expect(blob.blobKind).toBe("server_ssh_password");
    expect(blob.blobId).toMatch(UUID_V4);
    // Именно набранный пароль, байт в байт: kind и plaintext — два соседних
    // строковых аргумента команды, и перепутать их значит записать пароль в
    // `blob_kind` (а оттуда в audit-метаданные).
    expect(new TextDecoder().decode(b64ToU8(blob.plaintextB64))).toBe(SSH_PW);

    const [url, body] = mocks.apiPost.mock.calls[0];
    expect(url).toBe("/servers");
    expect(body.ssh_password_blob_id).toBe(blob.blobId);
    // Дефолт формы — чистое имя семейства ОС, а не строка с версией/архитектурой:
    // десктоп разбирает `os` подстрокой, версия в ней лишняя.
    expect(body.os).toBe("Ubuntu");
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
    fillForm(SSH_PW);
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
    fillForm(SSH_PW);
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
    // Подпись говорит про добавление сервера и только: пока форма умела ещё и
    // подключать панель, она ветвилась на «Connect server in desktop app», и
    // веб-пользователь читал бы обещание сценария, которого в форме нет.
    expect(link!.textContent).toContain("Add server in desktop app");
    expect(screen.queryByRole("button", { name: "Add Server" })).toBeNull();

    fillForm();
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });
});

/**
 * Панель на этапе добавления сервера НЕ выбирается: раньше здесь стояли две
 * вкладки («Install New Fastpanel» / «Connect Existing Fastpanel»), и решение
 * приходилось принимать до того, как сервер вообще завёлся. Теперь и установка,
 * и подключение живут на странице сервера, а форма заводит «голый» сервер по
 * SSH.
 */
describe("AddServerModal — панель здесь не выбирается", () => {
  secretBlobLifecycle();

  it("не шлёт ни одного поля fastpanel_*", async () => {
    setTauri(true);
    mocks.apiPost.mockResolvedValue({ id: 1 });

    renderModal();
    fillForm(SSH_PW);
    fireEvent.click(screen.getByRole("button", { name: "Add Server" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    const body = mocks.apiPost.mock.calls[0][1];
    // Именно «ключа нет», а не «ключ с пустым значением»: `fastpanel_status`
    // отсюда — это ложь про сервер, у которого панели ещё нет. «installed»
    // накрыл бы блок установки видом подключённой панели, к которой нечем
    // подключиться, а «not_installed» дублировал бы дефолт бэкенда — и разошёлся
    // бы с ним, стоит тому измениться.
    expect(Object.keys(body).filter((k) => k.startsWith("fastpanel"))).toEqual([]);
  });

  it("переключателя вкладок в форме нет вовсе", async () => {
    setTauri(true);
    renderModal();

    // Сценарий один, и выбирать между ними нечего. Кнопки-вкладки поверх формы
    // обещали бы обратное.
    expect(screen.queryByText(/Install New Fastpanel/)).toBeNull();
    expect(screen.queryByText(/Connect Existing Fastpanel/)).toBeNull();
    // Полей панели тоже нет: пароль панели, набранный здесь, уехал бы в блоб
    // под видом SSH-пароля — поля-то называются одинаково.
    expect(screen.queryByPlaceholderText("https://192.168.1.100:8888")).toBeNull();
    expect(screen.queryByPlaceholderText("Enter password")).toBeNull();
  });
});
