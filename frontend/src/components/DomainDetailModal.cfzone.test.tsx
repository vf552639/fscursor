import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainDetailModal from "./DomainDetailModal";
import { cloudflareKeys } from "../api/cloudflare";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Аккаунт Cloudflare, зона и делегирование на карточке домена.
 *
 * Сюжет один: куда домен делегирован и почему не туда. Раньше он был разложен
 * по двум экранам и наполовину состоял из чисел — в поле «Cloudflare» стоял
 * сырой `cloudflare_account_id`, а домен с аккаунтом, но без
 * `cloudflare_zone_id` выглядел настроенным, хотя пушить NS ему было нечем.
 *
 * Правило, которое здесь проверяется главным: **незнание не рисуется
 * здоровьем.** Оба сведения (NS зоны и NS у регистратора) читаются вживую из
 * двух чужих API, и когда любое из них не прочиталось, бейдж обязан быть
 * серым «UNKNOWN» с названной причиной, а не зелёным и не прочерком.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  invokeSynced: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPut: mocks.apiPut,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

const CF_MAIN = 7;
const CF_SPARE = 8;
const REGISTRAR = 9;
const CF_NS = ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"];

const zone = (over: Record<string, unknown> = {}) => ({
  id: "zone-a",
  name: "example.com",
  name_servers: CF_NS,
  status: "active",
  ...over,
});

function domain(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    domain_name: "example.com",
    status: "active",
    registrar_id: REGISTRAR,
    server_id: null,
    cloudflare_account_id: CF_MAIN,
    cloudflare_zone_id: "zone-a",
    cloudflare_enabled: true,
    expiry_date: null,
    purchase_date: null,
    ns_status: "pending",
    ns_updated_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  } as any;
}

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function mockAccounts(provider: string | null = "namecheap") {
  mocks.apiGet.mockImplementation(async (path: string) => {
    if (String(path).includes("/registrars/accounts")) {
      return provider === null ? [] : [{ id: REGISTRAR, provider, name: "Reg", is_active: true }];
    }
    if (String(path).includes("/cloudflare/accounts")) {
      return [
        { id: CF_MAIN, name: "Main CF", is_active: true },
        { id: CF_SPARE, name: "Spare CF", is_active: true },
      ];
    }
    return [];
  });
}

/** Ответы двух чужих API: зоны Cloudflare и nameservers домена у регистратора. */
function mockReads(reads: { zones?: any[]; registrarNs?: string[]; registrarNsError?: Error } = {}) {
  mocks.invokeSynced.mockImplementation(async (cmd: string) => {
    if (cmd === "cf_list_zones") return reads.zones ?? [zone()];
    if (cmd === "registrar_get_nameservers") {
      if (reads.registrarNsError) throw reads.registrarNsError;
      return reads.registrarNs ?? [];
    }
    return true;
  });
}

function card(d: any) {
  return (
    <QueryClientProvider client={queryClient}>
      <DomainDetailModal domain={d} servers={[]} onClose={() => {}} />
    </QueryClientProvider>
  );
}

function show(d = domain()) {
  return render(card(d));
}

/**
 * Строка домена обновилась на странице — карточка получает её пропсом.
 *
 * Именно `rerender`, а не новый `render`: страница держит модалку под
 * `key={detailDomain.id}` (`pages/Domains.tsx`), то есть при смене аккаунта или
 * дорезолве зоны карточка НЕ пересоздаётся и весь её локальный стейт (набранные
 * NS, флаг правки) переживает обновление строки. Смонтировав её заново, тест
 * проверял бы не то, что происходит у пользователя.
 */
function pageSends(rerender: (ui: React.ReactElement) => void, d: any) {
  rerender(card(d));
}

function nsField() {
  return screen.getByLabelText(/Nameservers/i) as HTMLTextAreaElement;
}

function nsButton() {
  return screen.getByText(/Set NS at registrar/).closest("button") as HTMLButtonElement;
}

/** Тела всех `PUT /domains/42` — то, что карточка записала в строку домена. */
function domainWrites() {
  return mocks.apiPut.mock.calls.filter((c: any[]) => String(c[0]) === "/domains/42").map((c: any[]) => c[1]);
}

function cfSelect() {
  return screen.getByLabelText("Cloudflare account") as HTMLSelectElement;
}

function delegationBadge() {
  return screen.getByText(/^(DELEGATED|PENDING|MISMATCH|UNKNOWN)$/);
}

function invoked(cmd: string) {
  return mocks.invokeSynced.mock.calls.filter((c: any[]) => c[0] === cmd);
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
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  mockAccounts();
  mockReads();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  setTauri(false);
  useAuthStore.getState().clear();
});

describe("аккаунт Cloudflare — выбор по имени", () => {
  it("показывает имя аккаунта вместо сырого id и даёт его сменить", async () => {
    setTauri(true);
    show();

    // Число `7` читателю карточки не говорило ничего, а сменить его отсюда было
    // нельзя вовсе.
    await waitFor(() => expect(cfSelect().value).toBe(String(CF_MAIN)));
    expect(screen.getByText("Main CF")).toBeTruthy();

    fireEvent.change(cfSelect(), { target: { value: String(CF_SPARE) } });

    await waitFor(() => expect(domainWrites().length).toBeGreaterThan(0));
    // Зона обнуляется тем же запросом: она принадлежала СТАРОМУ аккаунту, и
    // оставленная указывала бы на то, чего в новом нет, — а по ней пушатся NS.
    expect(domainWrites()[0]).toEqual({
      cloudflare_account_id: CF_SPARE,
      cloudflare_zone_id: null,
    });
  });

  it("даёт снять аккаунт целиком", async () => {
    setTauri(true);
    show();

    await waitFor(() => expect(cfSelect().value).toBe(String(CF_MAIN)));
    fireEvent.change(cfSelect(), { target: { value: "" } });

    await waitFor(() => expect(domainWrites().length).toBeGreaterThan(0));
    expect(domainWrites()[0]).toEqual({ cloudflare_account_id: null, cloudflare_zone_id: null });
  });
});

describe("дорезолв зоны", () => {
  it("сохраняет зону домену, у которого аккаунт есть, а зоны нет", async () => {
    setTauri(true);
    show(domain({ cloudflare_zone_id: null }));

    // Это и есть починка `skipped`-доменов: прогон синхрона такие не трогает
    // (аккаунт уже стоит), а без `cloudflare_zone_id` карточке нечего пушить.
    await waitFor(() => expect(domainWrites()).toEqual([{ cloudflare_zone_id: "zone-a" }]));
  });

  it("перечитанный список зон не приводит ко второй записи той же зоны", async () => {
    setTauri(true);
    show(domain({ cloudflare_zone_id: null }));
    await waitFor(() => expect(domainWrites().length).toBe(1));

    // Зоны перечитываются сами: истёк `staleTime`, прошла инвалидация после
    // создания зоны на странице Cloudflare. Список при этом ИЗМЕНИЛСЯ (иначе
    // react-query отдаёт прежнюю ссылку — `structuralSharing`, — и пересчитывать
    // нечего), а наша зона в нём осталась той же: матч пересчитывается, эффект
    // дорезолва срабатывает второй раз, и без ключа уже сделанной попытки в
    // бэкенд уходит второй, идентичный `PUT` по домену, зона которого записана.
    await act(async () => {
      queryClient.setQueryData(cloudflareKeys.zones(CF_MAIN), [
        zone(),
        zone({ id: "zone-new", name: "just-created.com" }),
      ]);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(domainWrites().length).toBe(1);
  });

  it("выбор аккаунта дорезолвит зону сам, без второго действия", async () => {
    setTauri(true);
    const { rerender } = show(domain({ cloudflare_account_id: null, cloudflare_zone_id: null }));

    // Ждём сам список аккаунтов: выбрать пункт, которого ещё нет в разметке,
    // нельзя — селект молча остался бы пустым.
    await screen.findByText("Main CF");
    fireEvent.change(cfSelect(), { target: { value: String(CF_MAIN) } });
    await waitFor(() =>
      expect(domainWrites()).toEqual([{ cloudflare_account_id: CF_MAIN, cloudflare_zone_id: null }]),
    );

    // Дальше цепочка идёт через страницу: `PUT` гасит `/domains`, страница
    // отдаёт карточке свежую строку — и уже на ней дорезолв находит зону.
    pageSends(rerender, domain({ cloudflare_account_id: CF_MAIN, cloudflare_zone_id: null }));
    await waitFor(() => expect(domainWrites()[1]).toEqual({ cloudflare_zone_id: "zone-a" }));

    // И на строке с уже проставленной зоной третьей записи не случается.
    pageSends(rerender, domain({ cloudflare_account_id: CF_MAIN, cloudflare_zone_id: "zone-a" }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(domainWrites().length).toBe(2);
  });

  it("две одноимённые зоны в аккаунте не сохраняются, но и не замалчиваются", async () => {
    setTauri(true);
    mockReads({ zones: [zone(), zone({ id: "zone-dup", name: "Example.com." })] });
    show(domain({ cloudflare_zone_id: null }));

    // Угадать — значит записать домену чужую зону, по которой потом уедут NS
    // регистратору. Но пользователь только что выбрал аккаунт и вправе узнать,
    // почему зона так и не появилась.
    expect(await screen.findByText(/Zone not saved: Main CF has 2 zones named example.com/)).toBeTruthy();
    await act(async () => {});
    expect(domainWrites()).toEqual([]);
  });

  it("называет отсутствие зоны, а не молчит", async () => {
    setTauri(true);
    mockReads({ zones: [zone({ id: "zone-other", name: "other.com" })] });
    show(domain({ cloudflare_zone_id: null }));

    expect(await screen.findByText(/No zone named example.com in Main CF/)).toBeTruthy();
    await act(async () => {});
    expect(domainWrites()).toEqual([]);
  });

  it("привязку, указывающую в пустоту, называет прямо", async () => {
    setTauri(true);
    mockReads({ zones: [zone({ id: "zone-other", name: "other.com" })] });
    show();

    // `cloudflare_zone_id` стоит, а такой зоны в аккаунте нет: перерешать за
    // пользователя нечего, но выдавать это за настроенный домен нельзя.
    expect(await screen.findByText(/Saved zone zone-a is not in this account/)).toBeTruthy();
  });

  it("в вебе аккаунт меняется, а про зону сказано, что её здесь не резолвят", async () => {
    setTauri(false);
    show(domain({ cloudflare_zone_id: null }));

    expect(await screen.findByText(/Zones are read by the desktop app/)).toBeTruthy();
    // Зоны в базе не лежат вовсе — читать их нечем, и молчаливый прочерк
    // выдавал бы правило продукта за поломку.
    expect(invoked("cf_list_zones")).toEqual([]);

    fireEvent.change(cfSelect(), { target: { value: String(CF_SPARE) } });
    // Аккаунт — это метаданные, `PUT /domains/{id}` работает и в вебе.
    await waitFor(() => expect(domainWrites().length).toBe(1));
  });
});

describe("поле NS не переживает смену зоны втихую", () => {
  /** Зоны есть только у аккаунта A: у B домен не найдётся, зоне взяться неоткуда. */
  function zonesOnlyInMain() {
    mocks.invokeSynced.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "cf_list_zones") return String(args.accountId) === String(CF_MAIN) ? [zone()] : [];
      if (cmd === "registrar_get_nameservers") return [];
      return true;
    });
  }

  it("после смены аккаунта в поле не остаются nameservers чужой зоны", async () => {
    setTauri(true);
    zonesOnlyInMain();
    const { rerender } = show();

    // 1. Поле подставлено NS зоны аккаунта A.
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));

    // 2. Пользователь выбирает аккаунт B: зона обнуляется тем же запросом.
    fireEvent.change(cfSelect(), { target: { value: String(CF_SPARE) } });
    await waitFor(() => expect(domainWrites().length).toBe(1));

    // 3. Страница отдаёт свежую строку. Карточка не пересоздаётся.
    pageSends(rerender, domain({ cloudflare_account_id: CF_SPARE, cloudflare_zone_id: null }));

    // 4. Кнопка при живом поле отправила бы регистратору nameservers аккаунта,
    // от которого пользователь только что отказался, — и ссылки «Restore from
    // Cloudflare» рядом уже нет, то есть о протухании не сказал бы никто.
    await waitFor(() => expect(nsField().value).toBe(""));
    expect(nsButton().disabled).toBe(true);
    fireEvent.click(nsButton());
    await act(async () => {});
    expect(invoked("registrar_set_nameservers")).toEqual([]);
    // Причина погасшей кнопки названа, а не оставлена загадкой.
    expect(screen.getByText(/Nothing to push/)).toBeTruthy();
  });

  it("правленое подставленное после смены аккаунта помечено, а не оставлено молча", async () => {
    setTauri(true);
    zonesOnlyInMain();
    const { rerender } = show();
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));

    // Правка подставленного (опечатка, третий сервер) отключает зеркало зоны —
    // значит, после смены аккаунта в поле остаются NS ЧУЖОГО аккаунта, а
    // ссылки «Restore from Cloudflare» рядом уже нет: сравнивать не с чем.
    fireEvent.change(nsField(), {
      target: { value: "ada.ns.cloudflare.com\nbob.ns.cloudflare.com\nns3.hoster.net" },
    });
    fireEvent.change(cfSelect(), { target: { value: String(CF_SPARE) } });
    pageSends(rerender, domain({ cloudflare_account_id: CF_SPARE, cloudflare_zone_id: null }));

    // Стирать чужой рукой набранное нельзя, а молчать — тем более: кнопка
    // живая, и клик отправит эти NS регистратору.
    expect(await screen.findByText(/no longer bound to/)).toBeTruthy();
    expect(nsButton().disabled).toBe(false);
  });

  it("набранное руками смену аккаунта переживает", async () => {
    setTauri(true);
    zonesOnlyInMain();
    const { rerender } = show();
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));

    // Домен, уезжающий на чужой хостинг, заполняется руками — и зеркало зоны
    // не вправе стереть это ни при смене аккаунта, ни при позднем ответе
    // Cloudflare (та же задокументированная возможность, что у домена вовсе
    // без зоны CF).
    fireEvent.change(nsField(), { target: { value: "ns1.hoster.net\nns2.hoster.net" } });
    fireEvent.change(cfSelect(), { target: { value: String(CF_SPARE) } });
    pageSends(rerender, domain({ cloudflare_account_id: CF_SPARE, cloudflare_zone_id: null }));

    await act(async () => {});
    expect(nsField().value).toBe("ns1.hoster.net\nns2.hoster.net");
    expect(nsButton().disabled).toBe(false);
    // И предупреждения про чужую зону тут нет: этот текст пришёл не из зоны, а
    // из головы пользователя — «эти NS от зоны, к которой домен не привязан»
    // было бы про них неправдой.
    expect(screen.queryByText(/no longer bound to/)).toBeNull();
  });
});

describe("делегирование — три состояния и «не знаем»", () => {
  it("делегировано у Namecheap — по ответу про ЭТОТ домен, а не по листингу", async () => {
    setTauri(true);
    // Аккаунт по умолчанию — namecheap, и это здесь главное: его листинг
    // (`namecheap.domains.getList`) nameservers не отдаёт вовсе, поэтому
    // сверка по листингу у Namecheap не могла дать ничего, кроме серого
    // «не знаем». Спрашиваем поимённо — и зелёное состояние достижимо.
    mockReads({ registrarNs: [...CF_NS].reverse() });
    show();

    // Регистр, точка на конце и порядок серверов — не расхождение.
    await waitFor(() => expect(delegationBadge().textContent).toBe("DELEGATED"));
    expect(invoked("registrar_get_nameservers")[0][1]).toEqual({
      userId: "user-1",
      // Аккаунт РЕГИСТРАТОРА и ИМЯ домена — то, что ждёт команда.
      accountId: String(REGISTRAR),
      domain: "example.com",
    });
    // Выкачки аккаунта при этом не происходит.
    expect(invoked("registrar_get_domains")).toEqual([]);
  });

  it("зона с другим именем не считается делегированием", async () => {
    setTauri(true);
    // Наследие ручной правки: `zone_id` указывает на зону соседнего домена.
    // NS у Cloudflare одни на весь аккаунт, а статус зоны `active`, — то есть
    // всё «сходится», и без сверки имени бейдж был бы зелёным про домен,
    // зоны которого в Cloudflare нет.
    mockReads({ zones: [zone({ name: "other.com" })], registrarNs: CF_NS });
    show();

    expect(await screen.findByText(/different name than this domain/)).toBeTruthy();
    expect(delegationBadge().textContent).toBe("UNKNOWN");
    // И там, где это чинится, сказано тоже.
    expect(screen.getByText(/Zone other.com is not this domain's zone/)).toBeTruthy();
  });

  it("pending, пока Cloudflare не подтвердил зону", async () => {
    setTauri(true);
    mockReads({ zones: [zone({ status: "pending" })], registrarNs: CF_NS });
    show();

    await waitFor(() => expect(delegationBadge().textContent).toBe("PENDING"));
    expect(screen.getByText(/has not confirmed the delegation yet/)).toBeTruthy();
  });

  it("расходится — и показывает, что на что менять", async () => {
    setTauri(true);
    mockReads({ registrarNs: ["ns1.hoster.net", "ns2.hoster.net"] });
    show();

    await waitFor(() => expect(delegationBadge().textContent).toBe("MISMATCH"));
    expect(screen.getByText(/at registrar: ns1.hoster.net, ns2.hoster.net/)).toBeTruthy();
    expect(screen.getByText(/zone: ada.ns.cloudflare.com, bob.ns.cloudflare.com/)).toBeTruthy();
  });

  it("отказ регистратора — это «не знаем», и причина названа его же словами", async () => {
    setTauri(true);
    mockReads({ registrarNsError: new Error("Namecheap error: Domain not found") });
    show();

    // Самая опасная ошибка этой карточки: сверка не состоялась, расхождений «не
    // нашлось», и зелёный бейдж объявил бы домен рабочим. Причина при этом
    // берётся у регистратора, а не выдумывается: раньше на этом месте стояло
    // «домена нет в аккаунте», хотя знать этого было неоткуда.
    expect(await screen.findByText(/Domain not found/)).toBeTruthy();
    expect(delegationBadge().textContent).toBe("UNKNOWN");
  });

  it("провайдер без NS-API: сверять нечем и кнопка выключена", async () => {
    setTauri(true);
    mockAccounts("godaddy");
    show();

    // `make_service` в десктопе знает двух провайдеров и на третьем отказывает
    // ещё до сети (`lib/registrarCaps`) — живая кнопка обещала бы работу,
    // которой не будет.
    // Незнание названо причиной: сверки нет не потому, что «всё сошлось».
    expect(await screen.findByText(/«godaddy» has no nameserver API in SDMP/)).toBeTruthy();
    expect(delegationBadge().textContent).toBe("UNKNOWN");
    // А у кнопки — что с этим делать.
    expect(screen.getByText(/set the nameservers in the registrar's own panel/)).toBeTruthy();
    expect((screen.getByText(/Set NS at registrar/).closest("button") as HTMLButtonElement).disabled).toBe(true);
    // И в чужой API не ходим: ответа там всё равно нет.
    await act(async () => {});
    expect(invoked("registrar_get_nameservers")).toEqual([]);
  });

  it("без зоны регистратора не спрашивает вовсе", async () => {
    setTauri(true);
    show(domain({ cloudflare_account_id: null, cloudflare_zone_id: null }));

    await waitFor(() => expect(delegationBadge().textContent).toBe("UNKNOWN"));
    expect(screen.getByText(/not bound to a live Cloudflare zone/)).toBeTruthy();
    // Сверять не с чем, а поход в API регистратора стоил бы запроса на каждое
    // открытие карточки.
    await act(async () => {});
    expect(invoked("registrar_get_nameservers")).toEqual([]);
    expect(invoked("cf_list_zones")).toEqual([]);
  });
});
