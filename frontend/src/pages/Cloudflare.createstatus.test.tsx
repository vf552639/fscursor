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
 * Итог создания аккаунта Cloudflare: удачное создание сообщает об успехе, и
 * ничего про зоны — сервер их не видит (`backend/app/schemas/cloudflare.py`).
 *
 * Утверждения не только про текст, но и про цвет: тот же текст в жёлтой рамке
 * читается как «что-то всё же не так», а рамку выбирает страница.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  invokeIfTauri: vi.fn(),
  invokeSynced: vi.fn(),
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
// транспорта и тянет локальный кэш. Через него же идёт `cf_verify_token` —
// им пользуются тесты про соседство зелёных плашек.
vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

// Тянет argon2/libsodium и к итогу создания отношения не имеет.
vi.mock("../components/RevealSecret", () => ({
  RevealSecret: () => <span>reveal</span>,
}));

const GREEN_BG = "rgb(240, 253, 244)";

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

/** Уже подключённые аккаунты: их двоих хватает, чтобы в шапке была кнопка прогона. */
const EXISTING = [
  {
    id: 5,
    name: "Main CF",
    account_id: "cf-acc-1",
    is_active: true,
    api_token_blob_id: null,
    api_token_masked: "abc…xyz",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: 7,
    name: "Second CF",
    account_id: "cf-acc-2",
    is_active: true,
    api_token_blob_id: null,
    api_token_masked: "abc…xyz",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

function renderPage(accounts: any[] = []) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/cloudflare/accounts") return accounts;
    if (url === "/domains") return [];
    throw new Error(`unexpected GET ${url}`);
  });
  return renderWithClient(<Cloudflare />);
}

/** Зоны здесь ни при чём, а вот все токены живые: сводка должна быть зелёной. */
function mockInvoke() {
  mocks.invokeSynced.mockImplementation(async (cmd: string) => {
    if (cmd === "cf_verify_token") return true;
    return [];
  });
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
    // Цвет — половина утверждения: тот же текст в жёлтом читался бы как отказ.
    expect(banner.style.background).toBe(GREEN_BG);
    // И ни слова о зонах: сервер их не видит, обещать по ним нечего.
    expect(screen.queryByText(/zone sync/i)).toBeNull();
    expect(screen.queryByText(/Linked Cloudflare to/)).toBeNull();
  });

  it("итог не зависит от лишних полей в ответе сервера", async () => {
    // Форма ветвилась по полям ответа, которых схема не объявляет; ответ ниже
    // их содержит, и значить они не должны ничего.
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

  it("создание аккаунта снимает сводку прогона: списка, о котором она говорила, уже нет", async () => {
    setTauri(true);
    mockInvoke();
    mocks.apiPost.mockResolvedValue(CREATED);

    renderPage(EXISTING);
    await screen.findByText("Main CF");

    fireEvent.click(screen.getByRole("button", { name: "Test 2 tokens" }));
    expect(await screen.findByText("2 tokens verified.")).toBeTruthy();

    await addAccount();
    expect(await screen.findByText("Cloudflare account created.")).toBeTruthy();

    // «2 tokens verified.» — утверждение о ПОЛНОМ проходе по списку аккаунтов,
    // а список только что пополнился ни разу не проверенным.
    expect(screen.queryByText(/tokens verified/)).toBeNull();
  });

  it("статус создания гаснет от следующего действия, а не встаёт второй зелёной плашкой", async () => {
    setTauri(true);
    mockInvoke();
    mocks.apiPost.mockResolvedValue(CREATED);

    renderPage(EXISTING);
    await screen.findByText("Main CF");

    await addAccount();
    expect(await screen.findByText("Cloudflare account created.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Test 2 tokens" }));
    const summary = await screen.findByText("2 tokens verified.");

    // Сводка встаёт прямо над статусом, в такой же карточке и таким же зелёным:
    // две неотличимые плашки подряд, из которых верхняя устарела ещё до начала
    // прогона. Итог последнего действия на экране один.
    expect(summary.style.background).toBe(GREEN_BG);
    expect(screen.queryByText("Cloudflare account created.")).toBeNull();
  });
});
