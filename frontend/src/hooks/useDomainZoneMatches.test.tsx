import React, { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";
import { MatchableDomain } from "../lib/cfZoneMatch";
import { DomainZoneMatches, useDomainZoneMatches } from "./useDomainZoneMatches";

/**
 * Живой матч доменов на зоны Cloudflare — то, что вкладка Domains показывает
 * подсказкой в строке.
 *
 * Проверяется здесь, а не на странице, потому что предмет — не разметка, а два
 * свойства ответа: он честен (аккаунт, зоны которого не прочитались, подсказок
 * не даёт и назван отдельно) и он СТАБИЛЕН по ссылке. Второе проверить глазами
 * нельзя вовсе: карта, пересобранная на каждый рендер, выглядит одинаково и
 * молча снимает мемоизацию двухсот строк.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  invokeSynced: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

function account(id: number, name: string, is_active = true) {
  return {
    id,
    name,
    account_id: null,
    is_active,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function domain(id: number, domain_name: string, cloudflare_account_id: number | null = null): MatchableDomain {
  return { id, domain_name, cloudflare_account_id };
}

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/** Аккаунты, которыми отвечает `GET /cloudflare/accounts`. */
function accountsAre(accounts: unknown[]) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/cloudflare/accounts") return accounts;
    return {};
  });
}

/** Зоны по аккаунтам: `cf_list_zones` получает id аккаунта строкой. */
function zonesAre(byAccount: Record<string, Array<{ id: string; name: string }> | Error>) {
  mocks.invokeSynced.mockImplementation(async (cmd: string, args: any) => {
    if (cmd !== "cf_list_zones") throw new Error(`unexpected command ${cmd}`);
    const zones = byAccount[String(args.accountId)];
    if (zones instanceof Error) throw zones;
    return (zones ?? []).map((z) => ({ ...z, name_servers: [], status: "active" }));
  });
}

/** Что хук отдал на каждом рендере — по ним и видно, менялась ли ссылка. */
let seen: DomainZoneMatches[] = [];

function Harness({ domains }: { domains: MatchableDomain[] }) {
  const matches = useDomainZoneMatches(domains);
  seen.push(matches);
  const [, force] = useState(0);
  return (
    <div>
      <button onClick={() => force((n) => n + 1)}>rerender</button>
      <div data-testid="hints">
        {[...matches.hints]
          .map(([id, h]) => `${id}:${h.outcome === "matched" ? h.account.name : "ambiguous"}`)
          .join(",")}
      </div>
      <div data-testid="unread">{matches.unreadAccounts.map((a) => a.name).join(",")}</div>
    </div>
  );
}

function renderHook(domains: MatchableDomain[]) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness domains={domains} />
    </QueryClientProvider>,
  );
}

const hints = () => screen.getByTestId("hints").textContent;
const unread = () => screen.getByTestId("unread").textContent;

beforeEach(() => {
  vi.resetAllMocks();
  seen = [];
  queryClient.clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...base,
    queries: { ...base.queries, retry: false },
    mutations: { ...base.mutations, retry: false },
  });
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  setTauri(false);
  useAuthStore.getState().clear();
});

describe("useDomainZoneMatches", () => {
  it("домен, совпавший ровно с одной зоной, получает имя её аккаунта", async () => {
    setTauri(true);
    accountsAre([account(7, "main")]);
    zonesAre({ "7": [{ id: "zone-a", name: "a.com" }] });

    renderHook([domain(1, "A.com")]);

    // Регистр значения не имеет: имена зон Cloudflare отдаёт в нижнем.
    await waitFor(() => expect(hints()).toBe("1:main"));
    expect(unread()).toBe("");
  });

  it("домену с сохранённой привязкой подсказка не нужна", async () => {
    setTauri(true);
    accountsAre([account(7, "main")]);
    zonesAre({ "7": [{ id: "zone-a", name: "a.com" }] });

    renderHook([domain(1, "a.com", 7)]);

    // Строка такого домена рисует сохранённое имя аккаунта, а подсказка поверх
    // факта — это второй источник правды в одной ячейке.
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalled());
    expect(hints()).toBe("");
  });

  it("совпадение в двух аккаунтах остаётся неоднозначностью, а не выбором за пользователя", async () => {
    setTauri(true);
    accountsAre([account(7, "main"), account(8, "second")]);
    zonesAre({
      "7": [{ id: "zone-a", name: "a.com" }],
      "8": [{ id: "zone-x", name: "a.com" }],
    });

    renderHook([domain(1, "a.com")]);

    await waitFor(() => expect(hints()).toBe("1:ambiguous"));
  });

  it("выключенный аккаунт в матч не входит", async () => {
    setTauri(true);
    accountsAre([account(7, "off", false)]);
    zonesAre({ "7": [{ id: "zone-a", name: "a.com" }] });

    renderHook([domain(1, "a.com")]);

    await waitFor(() => expect(screen.getByTestId("hints")).toBeTruthy());
    expect(hints()).toBe("");
    // Зоны выключенного аккаунта не читаются вовсе: он выключен пользователем.
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
  });

  it("в вебе подсказок нет и в Cloudflare никто не ходит", async () => {
    setTauri(false);
    accountsAre([account(7, "main")]);
    zonesAre({ "7": [{ id: "zone-a", name: "a.com" }] });

    renderHook([domain(1, "a.com")]);

    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalled());
    expect(hints()).toBe("");
    // Зоны читает Tauri-команда, и веб-панель «только смотрит».
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
  });

  it("аккаунт со сломанным токеном назван отдельно, а не проглочен прочерком", async () => {
    setTauri(true);
    accountsAre([account(7, "main"), account(8, "broken")]);
    zonesAre({
      "7": [{ id: "zone-a", name: "a.com" }],
      "8": new Error("Invalid API Token"),
    });

    renderHook([domain(1, "a.com"), domain(2, "b.com")]);

    // Живой аккаунт продолжает подсказывать: истёкший токен на одном из двух не
    // должен отменять матч по остальным.
    await waitFor(() => expect(unread()).toBe("broken"));
    expect(hints()).toBe("1:main");
  });

  it("карта не пересобирается на пустом рендере: мемоизация строк на этом стоит", async () => {
    setTauri(true);
    accountsAre([account(7, "main")]);
    zonesAre({ "7": [{ id: "zone-a", name: "a.com" }] });

    renderHook([domain(1, "a.com")]);
    await waitFor(() => expect(hints()).toBe("1:main"));

    const before = seen[seen.length - 1];
    fireEvent.click(screen.getByText("rerender"));

    const after = seen[seen.length - 1];
    expect(seen.length).toBeGreaterThan(1);
    // И карта, и сам объект подсказки: строка получает пропсом второе, и новый
    // объект на каждый рендер снял бы `React.memo` так же надёжно, как новая карта.
    expect(after.hints).toBe(before.hints);
    expect(after.hints.get(1)).toBe(before.hints.get(1));
  });
});
