import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainDetailModal from "./DomainDetailModal";
import { queryClient } from "../api/queryClient";
import { openTab } from "../test/tabs";
import { useAuthStore } from "../store/auth";

/**
 * Вкладки карточки домена: что на них лежит и что переживает переключение.
 *
 * Три правила, и каждое — про цену ленивой отрисовки (`ui/Tabs` рисует ровно
 * активную панель, поэтому переключение РАЗМОНТИРУЕТ прежнюю):
 *
 * 1. Ни одна вкладка не открывается в пустоту. Overview, Server и Logs приехали
 *    с данными — их содержимое проверяется у самих вкладок
 *    (`domains/tabs/*.test.tsx`), здесь только то, что вкладка в строке есть и
 *    монтируется. Template и Custom содержимого не имеют вовсе, и потому
 *    проверяются ЗДЕСЬ целиком: пилюля `COMING SOON`, фраза о том, чем вкладка
 *    станет, и — главное — ни одного органа управления в панели. Мёртвый
 *    селект или кнопка «Run» обещали бы функцию ровно так же, как пустая
 *    панель.
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

/** Зона Cloudflare со своими NS — то, чем зеркало наполняет нетронутое поле. */
const ZONE = {
  id: "zone-a",
  name: "example.com",
  name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
  status: "active",
};

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

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
  // Чтение зон требует пользователя (`requireUserId` в `zonesQuery`); без него
  // запрос падает, и поле NS остаётся пустым по совсем другой причине.
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  mocks.apiGet.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  setTauri(false);
  useAuthStore.getState().clear();
  queryClient.clear();
});

describe("строка вкладок", () => {
  it("вкладок ровно пять, и открыта Overview", () => {
    show();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Overview",
      "Server",
      "Logs",
      "Template",
      "Custom",
    ]);
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    // Ряд связей и панель NS — на Overview, карточки сервера — нет.
    // Спрашиваем именно карточку `FTP Access` (`role="group"` с её именем):
    // заголовка «Server state» у вкладки больше нет — его место заняли шапки
    // карточек, — а по группе видно ровно то же самое: смонтирована вкладка
    // Server или нет.
    expect(screen.getByRole("group", { name: "Registrar" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "FTP Access" })).toBeNull();
  });

  it("Server показывает живое чтение, Overview — карточки связей", () => {
    show();
    openTab("Server");
    expect(screen.getByRole("group", { name: "FTP Access" })).toBeTruthy();
    // Панель не просто добавилась рядом: прежняя размонтирована, иначе на
    // экране оказались бы два ответа про один домен сразу.
    expect(screen.queryByRole("group", { name: "Registrar" })).toBeNull();

    openTab("Overview");
    expect(screen.getByRole("group", { name: "Registrar" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "FTP Access" })).toBeNull();
  });

  it("Logs открывается своим содержимым, а не пустой панелью", () => {
    // Вкладка в строке и панель под ней — разные вещи: забыть отрисовать
    // панель значит вернуть ровно то, что план запрещает, — вкладку,
    // открывающуюся в пустоту. У домена фикстуры снимка нет, поэтому Logs
    // обязана сказать это словами.
    show();
    openTab("Logs");
    expect(screen.getByText(/none has been taken yet/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "FTP Access" })).toBeNull();
  });

  /**
   * Template и Custom — заглушки, и заглушка обязана ровно двум вещам: сказать
   * словами, чем вкладка станет, и не притворяться работающей.
   *
   * Второе проверяется по РОЛЯМ, а не по тексту: совпадение с фразой пережило
   * бы добавление селекта из макета рядом с ней, а пустой список кнопок,
   * комбобоксов и полей — нет. Тот же приём, что у заглушки Backups
   * (`domains/tabs/DomainServerTab.test.tsx`).
   *
   * Спрашиваем панель (`role="tabpanel"`), а не карточку: карточка ответила бы
   * только за себя, а обещанием функции была бы и кнопка, положенная в панель
   * мимо неё.
   */
  it("Template — заглушка со словами и без единого органа управления", () => {
    // Макет рисует здесь селект из пяти шаблонов, «Save» с правилом «выбрать
    // можно один раз», превью в фальшивом окне браузера и поле заметки. О
    // шаблонах сайта продукт не знает ничего — ни колонки у домена, ни поля в
    // снимке, ни команды, — так что сохранять выбор было бы некуда.
    show();
    openTab("Template");
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("group", { name: "Site template" })).toBeTruthy();
    expect(panel.textContent).toContain("COMING SOON");
    // Фраза, а не заголовок: «Site template» стоит и в шапке карточки, так что
    // совпадение с одним этим словосочетанием пережило бы удаление всего
    // объяснения. Спрашиваем кусок, которого в шапке быть не может.
    expect(panel.textContent).toMatch(/site template this domain is built from will be chosen/i);
    expect(within(panel).queryAllByRole("button")).toEqual([]);
    expect(within(panel).queryAllByRole("combobox")).toEqual([]);
    expect(within(panel).queryAllByRole("textbox")).toEqual([]);
  });

  it("Custom — заглушка говорит, чем станет, и ни одного «Run»", () => {
    // Макет рисует девять пресетов с кнопками «Run» и вложенную модалку «+ New
    // preset». Сохранять пресеты негде (ни модели, ни роутов), а исполнять
    // составленную человеком цепочку шагов нечем — девять кнопок «Run» были бы
    // девятью обещаниями. Фраза же обязана сказать, чем вкладка станет: без неё
    // «Presets» и `COMING SOON` не объясняют, чего именно ждать.
    show();
    openTab("Custom");
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("group", { name: "Presets" })).toBeTruthy();
    expect(panel.textContent).toContain("COMING SOON");
    expect(panel.textContent).toMatch(/saved multi-step actions you can run on this domain/i);
    expect(within(panel).queryAllByRole("button")).toEqual([]);
    expect(within(panel).queryAllByRole("combobox")).toEqual([]);
    expect(within(panel).queryAllByRole("textbox")).toEqual([]);
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

  it("правка ПОВЕРХ списка зоны не воскресает обратно в список зоны", async () => {
    // Зеркальный случай к предыдущему, и куда коварнее: у домена с
    // резолвнутой зоной поле наполняется её nameservers само, пока его не
    // трогали. Потеряй переключение вкладок не `text`, а `edited` — эффект
    // зеркала включился бы снова и подставил список зоны ПОВЕРХ правки, прямо
    // под курсором. Пустое поле человек заметит; воскресший правдоподобный
    // список — нет.
    setTauri(true);
    mocks.invokeSynced.mockImplementation(async (cmd: string) =>
      cmd === "cf_list_zones" ? [ZONE] : [],
    );
    show({ cloudflare_account_id: 7, cloudflare_zone_id: "zone-a" });

    // Дожидаемся именно подстановки из зоны — иначе правка легла бы в поле,
    // которое зеркало ещё не успело наполнить, и тест проверял бы не то.
    await waitFor(() => expect(nsField().value).toContain("ada.ns.cloudflare.com"));
    fireEvent.change(nsField(), { target: { value: "ns1.mine.com\nns2.mine.com" } });

    openTab("Server");
    openTab("Overview");

    expect(nsField().value).toBe("ns1.mine.com\nns2.mine.com");
    expect(nsField().value).not.toContain("cloudflare.com");
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
