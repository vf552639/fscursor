import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainDetailModal from "./DomainDetailModal";
import { cloudflareKeys } from "../api/cloudflare";
import { queryClient } from "../api/queryClient";
import type { RegistryNameservers } from "../api/rdap";
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
 * здоровьем.** Оба сведения (NS зоны у Cloudflare и NS домена В РЕЕСТРЕ)
 * читаются вживую из двух чужих сервисов, и когда любое из них не прочиталось,
 * бейдж обязан быть серым «UNKNOWN» с названной причиной, а не зелёным и не
 * прочерком.
 *
 * «Как есть» приезжает из реестра (RDAP), а не от API регистратора, и это видно
 * по мокам: у команды реестра нет ни `userId`, ни аккаунта — поэтому бейдж
 * работает и у провайдера без API вовсе.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  invokeSynced: vi.fn(),
  invokeIfTauri: vi.fn(),
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

// Чтение реестра идёт мимо локального кэша (`invokeIfTauri`, а не
// `invokeSynced`): синк перед вопросом о чужом домене был бы платой ни за что.
vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
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

/**
 * Ответы двух чужих сервисов: зоны Cloudflare и делегирование из реестра.
 *
 * `registry` — весь ответ реестра, а не список строк: три его состояния
 * («вот NS», «домена нет», «спросить не удалось») значат разное, и мок обязан
 * уметь выдать каждое. `registryError` — отдельно: это провал самого запроса, а
 * не ответ реестра.
 */
function mockReads(
  reads: { zones?: any[]; registry?: RegistryNameservers; registryError?: Error } = {},
) {
  mocks.invokeSynced.mockImplementation(async (cmd: string) => {
    if (cmd === "cf_list_zones") return reads.zones ?? [zone()];
    return true;
  });
  mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
    if (cmd === "domain_registry_nameservers") {
      if (reads.registryError) throw reads.registryError;
      return reads.registry ?? { state: "registered", nameservers: [] };
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

/** Вопросы, заданные реестру: они идут другим путём, чем команды с ключами. */
function askedRegistry() {
  return mocks.invokeIfTauri.mock.calls.filter(
    (c: any[]) => c[0] === "domain_registry_nameservers",
  );
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
  it("делегировано — по ответу РЕЕСТРА, и вопрос задан только про имя домена", async () => {
    setTauri(true);
    mockReads({ registry: { state: "registered", nameservers: [...CF_NS].reverse() } });
    show();

    // Регистр, точка на конце и порядок серверов — не расхождение.
    await waitFor(() => expect(delegationBadge().textContent).toBe("DELEGATED"));
    // Ни `userId`, ни аккаунта регистратора: реестр отвечает про домен, а не про
    // нашу учётку, — на этом и держится бейдж у провайдеров без API.
    expect(askedRegistry()[0][1]).toEqual({ domain: "example.com" });
    // И ни одной команды с ключами регистратора: чтения NS через его API больше
    // не существует. Утверждение НЕ про конкретное имя `registrar_get_nameservers`
    // (такое ловило бы только буквальный возврат удалённой команды и проспало бы
    // новый путь чтения под другим именем), а про весь канал: карточка ходит с
    // ключами ровно за зонами Cloudflare и больше ни за чем.
    expect(new Set(mocks.invokeSynced.mock.calls.map((c: any[]) => c[0]))).toEqual(
      new Set(["cf_list_zones"]),
    );
    // Выкачки аккаунта регистратора — тем более: команда жива, но карточке не
    // нужна, и вернуть её сюда значило бы платить листингом за один домен.
    expect(invoked("registrar_get_domains")).toEqual([]);
  });

  it("зона с другим именем не считается делегированием", async () => {
    setTauri(true);
    // Наследие ручной правки: `zone_id` указывает на зону соседнего домена.
    // NS у Cloudflare одни на весь аккаунт, а статус зоны `active`, — то есть
    // всё «сходится», и без сверки имени бейдж был бы зелёным про домен,
    // зоны которого в Cloudflare нет.
    mockReads({
      zones: [zone({ name: "other.com" })],
      registry: { state: "registered", nameservers: CF_NS },
    });
    show();

    expect(await screen.findByText(/different name than this domain/)).toBeTruthy();
    expect(delegationBadge().textContent).toBe("UNKNOWN");
    // И там, где это чинится, сказано тоже.
    expect(screen.getByText(/Zone other.com is not this domain's zone/)).toBeTruthy();
    // Реестр при этом не спрашивают: сверять всё равно не с чем, а имя нашего
    // домена ушло бы в сторонний RDAP-редиректор на каждое открытие карточки.
    await act(async () => {});
    expect(askedRegistry()).toEqual([]);
  });

  it("pending, пока Cloudflare не подтвердил зону", async () => {
    setTauri(true);
    mockReads({
      zones: [zone({ status: "pending" })],
      registry: { state: "registered", nameservers: CF_NS },
    });
    show();

    await waitFor(() => expect(delegationBadge().textContent).toBe("PENDING"));
    expect(screen.getByText(/has not confirmed the delegation yet/)).toBeTruthy();
  });

  it("расходится — и показывает, что на что менять", async () => {
    setTauri(true);
    mockReads({ registry: { state: "registered", nameservers: ["ns1.hoster.net", "ns2.hoster.net"] } });
    show();

    await waitFor(() => expect(delegationBadge().textContent).toBe("MISMATCH"));
    expect(screen.getByText(/in registry: ns1.hoster.net, ns2.hoster.net/)).toBeTruthy();
    expect(screen.getByText(/zone: ada.ns.cloudflare.com, bob.ns.cloudflare.com/)).toBeTruthy();
  });

  it("после удавшегося пуша не велит пушить снова", async () => {
    setTauri(true);
    // Домен на дефолтных NS регистратора — состояние ДО пуша.
    mockReads({ registry: { state: "registered", nameservers: ["dns1.registrar-servers.com", "dns2.registrar-servers.com"] } });
    show();

    await waitFor(() => expect(delegationBadge().textContent).toBe("MISMATCH"));
    expect(screen.getByText(/Push the zone's nameservers below/)).toBeTruthy();

    // Пуш удался (мок `registrar_set_nameservers` отвечает `true`), но реестр
    // отдаёт ВСЁ ЕЩЁ старые NS: распространение занимает минуты-часы.
    fireEvent.click(nsButton());

    // Бейдж остаётся красным — и это правда, делегирование ещё не сменилось.
    // Меняться обязан СОВЕТ: единственное, что подпись предлагала, пользователь
    // только что сделал.
    expect(await screen.findByText(/has just sent this zone's nameservers to the registrar/)).toBeTruthy();
    expect(delegationBadge().textContent).toBe("MISMATCH");
    expect(screen.queryByText(/Push the zone's nameservers below/)).toBeNull();
  });

  it("удавшийся пуш гасит кэш реестра, а не оставляет бейдж на ответе ДО пуша", async () => {
    setTauri(true);
    mockReads({ registry: { state: "registered", nameservers: ["ns1.hoster.net", "ns2.hoster.net"] } });
    show();

    await waitFor(() => expect(askedRegistry().length).toBe(1));
    fireEvent.click(nsButton());

    // Без инвалидации `rdapKeys` ответ реестра лежал бы в кэше ещё пять минут
    // (`staleTime`), и бейдж всё это время показывал бы состояние ДО пуша.
    await waitFor(() => expect(askedRegistry().length).toBe(2));
  });

  it("домен есть в реестре, а NS у него нет — красное «не делегирован никуда», а не серое", async () => {
    setTauri(true);
    // Пустой список — УТВЕРЖДЕНИЕ реестра, а не отсутствие ответа. Серый бейдж
    // прятал бы за «мы не выяснили» домен, который не работает вообще, — при том
    // что чинится он той же кнопкой, что любое расхождение.
    mockReads({ registry: { state: "registered", nameservers: [] } });
    show();

    await waitFor(() => expect(delegationBadge().textContent).toBe("MISMATCH"));
    expect(screen.getByText(/not delegated anywhere/)).toBeTruthy();
    // Пустое «как есть» напечатано словом, а не пустотой: обрезанная строка
    // читалась бы как сломанная вёрстка, а не как самый плохой случай.
    expect(screen.getByText(/in registry: \(none\)/)).toBeTruthy();
  });

  it("домена нет в реестре — своя причина и своё действие", async () => {
    setTauri(true);
    mockReads({ registry: { state: "not_registered" } });
    show();

    // Не «расходится» и не «не смогли спросить»: прописывать NS домену, которого
    // в реестре нет, некуда — разбираться надо с самим доменом.
    expect(await screen.findByText(/no record of this domain/)).toBeTruthy();
    expect(delegationBadge().textContent).toBe("UNKNOWN");
  });

  it("реестр не смог ответить — это «не знаем», и причина названа его же словами", async () => {
    setTauri(true);
    mockReads({ registry: { state: "unavailable", reason: "no RDAP server for .test" } });
    show();

    // Самая опасная ошибка этой карточки: сверка не состоялась, расхождений «не
    // нашлось», и зелёный бейдж объявил бы домен рабочим. Причина при этом
    // берётся у реестра, а не выдумывается: по ней видно, ждать ли ответа вообще.
    expect(await screen.findByText(/could not be asked/)).toBeTruthy();
    expect(await screen.findByText(/no RDAP server for .test/)).toBeTruthy();
    expect(delegationBadge().textContent).toBe("UNKNOWN");
  });

  it("упавший запрос в реестр не выдаётся за «ответ ещё летит»", async () => {
    setTauri(true);
    mockReads({ registryError: new Error("invoke failed: window is gone") });
    show();

    // «Подождите» про ответ, которого не будет, — это обещание. Провал запроса
    // приезжает тем же состоянием, что отказ реестра.
    expect(await screen.findByText(/could not be asked/)).toBeTruthy();
    expect(screen.getByText(/window is gone/)).toBeTruthy();
    expect(delegationBadge().textContent).toBe("UNKNOWN");
  });

  it("домен у РУЧНОГО провайдера получает живой бейдж, а кнопка остаётся выключенной", async () => {
    setTauri(true);
    // Dynadot заведён ярлыком: API у него нет вовсе (`lib/registrarCaps`), и
    // раньше это глушило ЧТЕНИЕ — бейдж был серым «нет API» у всех таких
    // доменов. Реестру же аккаунт не нужен: он отвечает и здесь.
    mockAccounts("dynadot");
    mockReads({ registry: { state: "registered", nameservers: CF_NS } });
    show();

    await waitFor(() => expect(delegationBadge().textContent).toBe("DELEGATED"));
    expect(askedRegistry()[0][1]).toEqual({ domain: "example.com" });

    // А вот ЗАПИСЬ по-прежнему невозможна, и сказано об этом там, где кнопка:
    // `make_service` в десктопе знает двух провайдеров и на третьем отказывает
    // ещё до сети — живая кнопка обещала бы работу, которой не будет.
    expect(
      screen.getByText(/SDMP has no nameserver API for «dynadot» — set the nameservers in the registrar's own panel/),
    ).toBeTruthy();
    expect((screen.getByText(/Set NS at registrar/).closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("домен без аккаунта регистратора тоже получает живой бейдж", async () => {
    setTauri(true);
    // Строка домена без `registrar_id` — обычное дело у только что заведённых
    // доменов. Реестру всё равно: раньше это была причина `no-registrar`, то
    // есть серый бейдж вместо ответа, который у нас был.
    mockReads({ registry: { state: "registered", nameservers: CF_NS } });
    show(domain({ registrar_id: null }));

    await waitFor(() => expect(delegationBadge().textContent).toBe("DELEGATED"));
    // Причина у выключенной кнопки при этом своя и на своём месте.
    expect(screen.getByText(/Assign a registrar account to this domain first/)).toBeTruthy();
  });

  it("без зоны реестр не спрашивают вовсе", async () => {
    setTauri(true);
    show(domain({ cloudflare_account_id: null, cloudflare_zone_id: null }));

    await waitFor(() => expect(delegationBadge().textContent).toBe("UNKNOWN"));
    expect(screen.getByText(/not bound to a live Cloudflare zone/)).toBeTruthy();
    // Сверять не с чем, а поход в чужой публичный сервис стоил бы запроса на
    // каждое открытие карточки.
    await act(async () => {});
    expect(askedRegistry()).toEqual([]);
    expect(invoked("cf_list_zones")).toEqual([]);
  });
});
