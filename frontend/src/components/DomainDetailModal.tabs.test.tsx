import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainDetailModal from "./DomainDetailModal";
import { queryClient } from "../api/queryClient";
import { openTab } from "../test/tabs";

/**
 * Вкладки карточки домена: что на них лежит и что переживает переключение.
 *
 * Три правила, и каждое — про цену ленивой отрисовки (`ui/Tabs` рисует ровно
 * активную панель, поэтому переключение РАЗМОНТИРУЕТ прежнюю):
 *
 * 1. Вкладок ровно столько, сколько есть содержимого. Logs / Template / Custom
 *    из макета появятся своими фазами: вкладка, открывающаяся в пустоту, — то
 *    же обещание функции, которой нет, что и мёртвая кнопка.
 * 2. Cloudflare и nameservers вкладки НЕ разводят — ровно то свойство, ради
 *    которого прежние вкладки карточки и были сняты.
 * 3. Набранный, но не отправленный список NS переключение переживает. Живёт он
 *    поэтому в модалке (`useNsDraft`), а не в панели, которую размонтируют.
 */

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), invokeSynced: vi.fn() }));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

const SERVERS = [{ id: 3, name: "web-01", ip_address: "10.0.0.3" }] as any[];

function domain(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    domain_name: "example.com",
    status: "active",
    registrar_id: null,
    server_id: 3,
    cloudflare_account_id: null,
    cloudflare_zone_id: null,
    ns_status: "pending",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  } as any;
}

function show(over: Record<string, unknown> = {}) {
  render(
    <QueryClientProvider client={queryClient}>
      <DomainDetailModal domain={domain(over)} servers={SERVERS} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

const nsField = () => screen.getByLabelText(/one per line/i) as HTMLTextAreaElement;

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  mocks.apiGet.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("строка вкладок", () => {
  it("вкладок ровно две, и открыта Overview", () => {
    show();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Server"]);
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    // Ряд связей и панель NS — на Overview, секция сервера — нет.
    expect(screen.getByRole("group", { name: "Registrar" })).toBeTruthy();
    expect(screen.queryByText("Server state")).toBeNull();
  });

  it("Server показывает живое чтение, Overview — карточки связей", () => {
    show();
    openTab("Server");
    expect(screen.getByText("Server state")).toBeTruthy();
    // Панель не просто добавилась рядом: прежняя размонтирована, иначе на
    // экране оказались бы два ответа про один домен сразу.
    expect(screen.queryByRole("group", { name: "Registrar" })).toBeNull();

    openTab("Overview");
    expect(screen.getByRole("group", { name: "Registrar" })).toBeTruthy();
    expect(screen.queryByText("Server state")).toBeNull();
  });

  it("Cloudflare и nameservers стоят на ОДНОЙ вкладке", () => {
    // Пустое поле NS с погасшей кнопкой почти всегда следствие нерезолвнутой
    // зоны: разведённые по вкладкам причина и следствие читаются как две
    // независимые поломки — ровно тот дефект, ради снятия которого прежние
    // вкладки карточки и были удалены.
    show();
    expect(screen.getByLabelText("Cloudflare account")).toBeTruthy();
    expect(nsField()).toBeTruthy();
  });
});

describe("набранное на Overview переживает уход на соседнюю вкладку", () => {
  it("список NS, набранный руками, не пропадает после Server и обратно", () => {
    // Регрессия, которую этот тест сторожит: состояние поля жило внутри панели,
    // а `Tabs` рисует ровно активную панель — то есть дорога Overview → Server →
    // Overview стирала бы набранное руками молча, без единого слова на экране.
    show();
    fireEvent.change(nsField(), { target: { value: "ns1.example.com\nns2.example.com" } });
    expect(nsField().value).toContain("ns1.example.com");

    openTab("Server");
    openTab("Overview");

    expect(nsField().value).toBe("ns1.example.com\nns2.example.com");
  });
});

describe("карточка Nameservers", () => {
  it("состояние делегирования — пилюлей в шапке карточки, причина — в теле", () => {
    // Пилюля уехала в правый слот `SectionCard`, но осталась ОДНИМ ответом с
    // фразой под ней: серый бейдж без причины сообщает только то, что мы
    // чего-то не сделали.
    show();
    const card = screen.getByRole("group", { name: "Nameservers" });
    expect(within(card).getByText("UNKNOWN")).toBeTruthy();
    expect(
      within(card).getByText(/not bound to a live Cloudflare zone/),
    ).toBeTruthy();
  });
});

describe("DMCA — честная заглушка, а не обещание", () => {
  it("названа как «скоро» и не предлагает ни одного действия", () => {
    show();
    const card = screen.getByRole("group", { name: "DMCA" });
    expect(within(card).getByText("COMING SOON")).toBeTruthy();
    expect(within(card).getByText(/will appear here in a future update/)).toBeTruthy();
    // Ни кнопок, ни полей: мёртвый элемент управления обещал бы функцию,
    // которой в продукте нет вовсе (принцип №6 CLAUDE.md).
    expect(within(card).queryAllByRole("button")).toEqual([]);
    expect(within(card).queryAllByRole("textbox")).toEqual([]);
  });
});
