import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";

import Cloudflare, { AddCfAccountModal } from "./Cloudflare";
import {
  setTauri,
  renderWithClient,
  secretBlobLifecycle,
} from "../test/secretBlobKit";

/**
 * Итог создания аккаунта Cloudflare.
 *
 * Форма ветвилась по `sync_result` из ответа создания, а бэкенд зашивал туда
 * `None` — синхронизации зон на сервере нет и быть не может (токен
 * расшифровывается на клиенте). Значит ветка успеха была недостижима, и КАЖДОЕ
 * удачное создание заканчивалось жёлтым «Account created, but zone sync did not
 * complete»: человек видел предупреждение о несделанном там, где всё сделано.
 *
 * Поэтому утверждения здесь не только про текст, но и про цвет: «зелёный
 * баннер» — это и есть разница между честным успехом и прежним предупреждением,
 * а текст без цвета прошёл бы и в жёлтой рамке.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  invokeIfTauri: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
}));

vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

// Список зон к итогу создания отношения не имеет, а ходит в Tauri мимо мока
// транспорта и тянет локальный кэш.
vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: vi.fn(async () => []),
  syncLocalCache: vi.fn(async () => {}),
}));

// Тянет argon2/libsodium и к итогу создания отношения не имеет.
vi.mock("../components/RevealSecret", () => ({
  RevealSecret: () => <span>reveal</span>,
}));

const GREEN_BG = "rgb(240, 253, 244)";
const AMBER_BG = "rgb(255, 251, 235)";

/** Ответ создания — ровно то, что сегодня отдаёт `CloudflareAccountResponse`. */
const CREATED = {
  id: 6,
  name: "cf-new",
  account_id: "acc-9",
  is_active: true,
  api_token_blob_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  api_token_masked: "••••eeee",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function renderPage() {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/cloudflare/accounts") return [];
    if (url === "/domains") return [];
    throw new Error(`unexpected GET ${url}`);
  });
  return renderWithClient(<Cloudflare />);
}

async function addAccount() {
  fireEvent.click((await screen.findAllByRole("button", { name: "+ Add Account" }))[0]);
  fireEvent.change(screen.getByPlaceholderText("e.g., Main CF Account"), {
    target: { value: "cf-new" },
  });
  fireEvent.change(screen.getByPlaceholderText("abc123def456..."), {
    target: { value: "acc-9" },
  });
  fireEvent.change(screen.getByPlaceholderText("••••••••••••••••"), {
    target: { value: "cf-token-42" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add Account" }));
}

describe("Cloudflare — итог создания аккаунта", () => {
  secretBlobLifecycle();

  it("удачное создание даёт зелёный успех, а не предупреждение о синхронизации", async () => {
    setTauri(true);
    mocks.apiPost.mockResolvedValue(CREATED);

    renderPage();
    await addAccount();

    const banner = await screen.findByText("Cloudflare account created.");
    // Цвет — половина утверждения: прежняя ветка выдавала свой текст в жёлтом.
    expect(banner.style.background).toBe(GREEN_BG);
    expect(banner.style.background).not.toBe(AMBER_BG);
    // И ни слова о зонах: сервер их не видел и не увидит, обещать по ним нечего.
    expect(screen.queryByText(/zone sync/i)).toBeNull();
    expect(screen.queryByText(/Linked Cloudflare to/)).toBeNull();
  });

  it("итог не зависит от лишних полей в ответе сервера", async () => {
    // Форма читала из ответа `sync_result`/`sync_warning` — полей, которых схема
    // больше не объявляет. Если чтение вернётся, старый ответ снова начнёт
    // менять текст: здесь он подсунут целиком и не должен значить ничего.
    setTauri(true);
    mocks.apiPost.mockResolvedValue({
      ...CREATED,
      sync_result: { updated: 2, skipped: 1, total_zones: 3 },
      sync_warning: "zone sync did not complete",
    });

    const onStatus = vi.fn();
    renderWithClient(<AddCfAccountModal onClose={vi.fn()} onStatus={onStatus} />);
    fireEvent.change(screen.getByPlaceholderText("e.g., Main CF Account"), {
      target: { value: "cf-new" },
    });
    fireEvent.change(screen.getByPlaceholderText("••••••••••••••••"), {
      target: { value: "cf-token-42" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));

    await waitFor(() => expect(onStatus).toHaveBeenCalledTimes(1));
    expect(onStatus).toHaveBeenCalledWith("Cloudflare account created.");
  });
});
