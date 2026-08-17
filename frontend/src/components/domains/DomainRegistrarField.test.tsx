import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainRegistrarField from "./DomainRegistrarField";
import { queryClient } from "../../api/queryClient";

/**
 * Связь домена с регистратором на карточке домена.
 *
 * Раньше в поле стояло сырое `registrar_id`, а назначить аккаунт из карточки
 * было негде — при том что панель NS внизу того же экрана печатает «Assign a
 * registrar account to this domain first». Диагноз был, лекарства не было.
 *
 * Правило, которое проверяется главным (CLAUDE.md §6): **незнание не рисуется
 * здоровьем**, и «не назначен» — это утверждение, а не заглушка. Пока список
 * аккаунтов не прочитан и когда сохранённый аккаунт из него исчез, селект
 * обязан говорить об этом, а не вставать в положение «связи нет».
 */

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPut: mocks.apiPut,
}));

const HOSTIQ = 5;
const MANUAL = 6;
const GONE = 9;

function domain(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    domain_name: "example.com",
    status: "active",
    registrar_id: HOSTIQ,
    server_id: null,
    cloudflare_account_id: null,
    cloudflare_zone_id: null,
    ...over,
  } as any;
}

const ACCOUNTS = [
  { id: HOSTIQ, provider: "hostiq", name: "Hostiq main", is_active: true },
  { id: MANUAL, provider: "dynadot", name: "Dynadot label", is_active: true },
];

function mockAccounts(accounts: any[] = ACCOUNTS) {
  mocks.apiGet.mockImplementation(async (path: string) =>
    String(path).includes("/registrars/accounts") ? accounts : [],
  );
}

function show(over: Record<string, unknown> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <DomainRegistrarField domain={domain(over)} />
    </QueryClientProvider>,
  );
}

function sel() {
  return screen.getByLabelText("Registrar account") as HTMLSelectElement;
}

/** Тела всех `PUT /domains/42` — то, что поле записало в строку домена. */
function domainWrites() {
  return mocks.apiPut.mock.calls
    .filter((c: any[]) => String(c[0]) === "/domains/42")
    .map((c: any[]) => c[1]);
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...base,
    queries: { ...base.queries, retry: false },
    mutations: { ...base.mutations, retry: false },
  });
  mockAccounts();
  mocks.apiPut.mockResolvedValue(domain());
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("аккаунт регистратора — выбор по имени", () => {
  it("показывает имя аккаунта вместо сырого id и даёт его сменить", async () => {
    show();

    // Ждём сам список: выбрать пункт, которого ещё нет в разметке, нельзя —
    // селект молча остался бы в прежнем положении.
    expect(await screen.findByText("Hostiq main")).toBeTruthy();
    expect(sel().value).toBe(String(HOSTIQ));

    fireEvent.change(sel(), { target: { value: String(MANUAL) } });

    await waitFor(() => expect(domainWrites().length).toBe(1));
    // Никаких побочных сбросов: зависимых от регистратора полей у домена нет.
    expect(domainWrites()[0]).toEqual({ registrar_id: MANUAL });
  });

  it("даёт снять аккаунт целиком", async () => {
    show();

    await screen.findByText("Hostiq main");
    fireEvent.change(sel(), { target: { value: "" } });

    await waitFor(() => expect(domainWrites()).toEqual([{ registrar_id: null }]));
  });

  it("выбор того же аккаунта запроса не шлёт", async () => {
    show();

    await screen.findByText("Hostiq main");
    fireEvent.change(sel(), { target: { value: String(HOSTIQ) } });

    await act(async () => {});
    expect(domainWrites()).toEqual([]);
  });

  it("отказ записи показан, а не проглочен", async () => {
    mocks.apiPut.mockRejectedValue(new Error("registrar_id does not exist"));
    show();

    await screen.findByText("Dynadot label");
    fireEvent.change(sel(), { target: { value: String(MANUAL) } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("registrar_id does not exist");
  });
});

describe("незнание не рисуется «связи нет»", () => {
  it("домен без регистратора: сказано и что не назначен, и чем это грозит", async () => {
    show({ registrar_id: null });

    await waitFor(() => expect(sel().value).toBe(""));
    // Тот же диагноз, что печатает панель NS внизу, но здесь у него есть
    // лекарство — селект в двух сантиметрах.
    expect(screen.getByText(/nowhere to push nameservers/i)).toBeTruthy();
  });

  it("аккаунт удалён, а id в домене остался — селект не встаёт в «не назначен»", async () => {
    // В БД связь есть, аккаунта нет. Пустой селект обещал бы, что связи нет
    // вовсе, — и человек «назначил» бы регистратора, ничего не изменив.
    mockAccounts([]);
    show({ registrar_id: GONE });

    await waitFor(() => expect(screen.getByText(/account not found/i)).toBeTruthy());
    expect(sel().value).toBe(String(GONE));
    await act(async () => {});
    expect(domainWrites()).toEqual([]);
  });

  it("список ещё грузится — «загрузка», а не «не назначен»", async () => {
    // Ответ не приходит вовсе: ровно то окно, в котором список пуст, а
    // `registrar_id` у домена стоит.
    mocks.apiGet.mockImplementation(() => new Promise(() => {}));
    show({ registrar_id: HOSTIQ });

    expect(screen.getByText(/Loading accounts/i)).toBeTruthy();
    expect(sel().value).toBe(String(HOSTIQ));
    expect(sel().disabled).toBe(true);
    // И «аккаунт не найден» тоже рано: мы его ещё не искали.
    expect(screen.queryByText(/account not found/i)).toBeNull();
  });

  it("список не прочитался — названа причина, а не выдуман ответ", async () => {
    mocks.apiGet.mockRejectedValue(new Error("401 Unauthorized"));
    show({ registrar_id: HOSTIQ });

    expect(await screen.findByText(/401 Unauthorized/)).toBeTruthy();
    expect(sel().value).toBe(String(HOSTIQ));
    expect(sel().disabled).toBe(true);
  });
});

describe("провайдер аккаунта", () => {
  it("у аккаунта из каталога — его метка", async () => {
    show();
    expect(await screen.findByText("Hostiq")).toBeTruthy();
  });

  it("незнакомый провайдер показан своей строкой, как есть", async () => {
    show({ registrar_id: MANUAL });
    expect(await screen.findByText("dynadot")).toBeTruthy();
  });

  it("ни бейджа «API/manual», ни кнопки проверки связи здесь нет", async () => {
    // Ответ «умеет ли этот регистратор писать NS» даёт панель NS внизу того же
    // экрана (`registrarSupportsNsApi`). Второй такой ответ здесь означал бы два
    // источника правды на одном экране.
    show();
    await screen.findByText("Hostiq");
    expect(screen.queryByText("API")).toBeNull();
    expect(screen.queryByText("manual")).toBeNull();
    expect(screen.queryByText(/Test connection/i)).toBeNull();
  });
});
