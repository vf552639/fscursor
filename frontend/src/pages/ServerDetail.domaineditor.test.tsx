import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ServerDetail from "./ServerDetail";
import { setTauri, secretBlobLifecycle } from "../test/secretBlobKit";

/**
 * Форма правки домена с карточки сервера — та, где четыре поля идут подряд:
 * Domain Name, Purchase Date, Expiry Date, Cloudflare Zone ID.
 *
 * Правила, ради которых тут вообще есть тесты.
 *
 * 1. **Даты набираются ТЕКСТОМ.** Нативный `<input type="date">` ушёл отсюда
 *    совсем: в WKWebView десктопа он не принимал ввод с клавиатуры вовсе —
 *    цифры не вставали в сегменты, календарь не открывался, `input.value` был
 *    пуст всегда. Поле, которое молча не берёт ввод, хуже отсутствующего.
 * 2. **Форма пишет ISO, а показывает по-человечески.** Наружу уходит ровно та
 *    же форма payload, что и раньше (`date` без времени либо `null`): бэкенд
 *    ждёт `Optional[date]`, и «01.09.2026» он не примет.
 * 3. **Save выключается, пока хоть ОДНА дата не разобрана — и знает, какая.**
 *    Ответ о разборе приходит на каждое изменение и по каждому полю отдельно;
 *    общий флаг на два поля включал бы кнопку от починки второго при сломанном
 *    первом.
 * 4. **Пустое место кнопку не выключает.** У домена без дат Save обязан быть
 *    доступен с первого рендера — в том числе в `React.StrictMode`, где
 *    монтирование (а с ним и рассказ поля о себе) двойное.
 * 5. **Незнание не рисуется благополучием.** Нечитаемая дата из базы — это не
 *    «даты нет»: сохранить поверх неё `null` значило бы стереть данные молча,
 *    поэтому Save выключен, а причина названа.
 *
 * Поля ищутся ТОЛЬКО по подписи (`getByLabelText`): так тест заодно сторожит,
 * что подпись с полем связана — без пары `htmlFor`/`id` поле для скринридера
 * безымянно, а `<label>` по соседству сам по себе его не именует.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  invokeIfTauri: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPut: mocks.apiPut,
}));

vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: vi.fn(),
  syncLocalCache: vi.fn(async () => {}),
}));

// Тянет argon2/libsodium, к форме правки домена отношения не имеет.
vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));

const SERVER = {
  id: 7,
  name: "srv-7",
  ip_address: "10.0.0.7",
  ssh_port: 22,
  ssh_user: "root",
  os: "ubuntu-22.04",
  provider: "Hetzner" as string | null,
  status: "active",
  fastpanel_status: "not_installed",
  fastpanel_url: null,
  fastpanel_user: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  has_ssh: true,
  ssh_password_blob_id: null as string | null,
  fastpanel_password_blob_id: null as string | null,
  uptime_seconds: null,
  cpu_usage_pct: null,
  cpu_count: null,
  ram_used_mb: null,
  ram_total_mb: null,
  disk_used_gb: null,
  disk_total_gb: null,
  net_in_kbps: null,
  net_out_kbps: null,
  os_pretty: "Ubuntu 22.04",
  kernel: null,
  fastpanel_version: null,
  fastpanel_port: null,
  metrics_collected_at: null,
  last_check_at: null,
  last_check_ok: true,
  last_check_error: null,
};

/** Обе даты — в производственном виде: `date`, без времени и без зоны. */
const DOMAIN = {
  id: 5,
  domain_name: "example.com",
  server_id: 7,
  status: "active",
  ns_status: "ok",
  purchase_date: "2026-01-10" as string | null,
  expiry_date: "2026-09-01" as string | null,
  cloudflare_zone_id: "zone-1" as string | null,
};

/** Они же — набранные руками: поле принимает ровно то, что печатает. */
const PURCHASE_TYPED = "10.01.2026";
const EXPIRY_TYPED = "01.09.2026";

function renderDetail(domain: typeof DOMAIN | null = DOMAIN, strict = false) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === `/servers/${SERVER.id}`) return SERVER;
    if (url === "/servers") return { items: [SERVER], total: 1 };
    if (url === "/domains") return domain ? [domain] : [];
    throw new Error(`unexpected GET ${url}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (
    <QueryClientProvider client={client}>
      <ServerDetail server={{ id: SERVER.id }} onBack={() => {}} onFastpanelCreds={() => {}} />
    </QueryClientProvider>
  );
  return render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
}

type Fields = {
  name: HTMLInputElement;
  purchase: HTMLInputElement;
  expiry: HTMLInputElement;
  zone: HTMLInputElement;
};

async function openEditor(
  domain: typeof DOMAIN | null = DOMAIN,
  strict = false,
): Promise<Fields> {
  renderDetail(domain, strict);
  fireEvent.click(await screen.findByRole("button", { name: "Edit domain" }));
  return {
    name: screen.getByLabelText("Domain Name") as HTMLInputElement,
    purchase: screen.getByLabelText("Purchase Date") as HTMLInputElement,
    expiry: screen.getByLabelText("Expiry Date") as HTMLInputElement,
    zone: screen.getByLabelText("Cloudflare Zone ID") as HTMLInputElement,
  };
}

function saveBtn(): HTMLButtonElement {
  // По роли и имени, как всё остальное в этом файле: поиск по тексту сломался
  // бы, окажись подпись однажды внутри вложенного span.
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

/**
 * Причина мёртвой кнопки, названная словами. Живёт в форме строкой над кнопкой,
 * а не только в `title`: выключенная кнопка из tab-порядка выпадает, и
 * всплывающей подсказки по фокусу не покажет ни один браузер — то есть человек
 * без мыши не узнал бы о причине НИЧЕГО, при том что форма заблокирована
 * целиком, включая правку имени.
 */
const BLOCKED = "A date could not be read. Clear the field and enter it again as DD.MM.YYYY.";

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

describe("ServerDetail — правка домена, поля дат", () => {
  secretBlobLifecycle();

  it("даты открываются набранными по-человечески, и полей `type=date` нет ни одного", async () => {
    setTauri(true);
    const f = await openEditor();

    // Ради этих трёх строк всё и затевалось: нативного `type="date"` в проекте
    // не осталось, и последними ушли ровно эти два поля.
    expect(f.purchase.type).toBe("text");
    expect(f.expiry.type).toBe("text");
    expect(document.querySelectorAll('input[type="date"]').length).toBe(0);

    // Дата показана в том же написании, в каком её печатают колонка списка и
    // шапка карточки домена, — и в нём же принимается обратно.
    expect(f.purchase.value).toBe(PURCHASE_TYPED);
    expect(f.expiry.value).toBe(EXPIRY_TYPED);
    // Форма открылась готовой к записи: выключать Save на пустом месте нечем.
    expect(saveBtn().disabled).toBe(false);
  });

  it("набранные даты уходят ISO-строками, а payload остаётся прежней формы", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...DOMAIN });

    const f = await openEditor();
    type(f.purchase, "02.03.2027");
    type(f.expiry, "04.05.2028");
    fireEvent.click(saveBtn());

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    const [url, body] = mocks.apiPut.mock.calls[0];
    expect(url).toBe("/domains/5");
    // Целиком, а не по полю: форма payload — договор с бэкендом (`Optional[date]`
    // и `null`), и менять его переезд поля на текст не имел права.
    expect(body).toEqual({
      domain_name: "example.com",
      purchase_date: "2027-03-02",
      expiry_date: "2028-05-04",
      cloudflare_zone_id: "zone-1",
    });

    // Удачная запись закрывает форму — иначе она читалась бы как «не сохранено».
    await waitFor(() => expect(screen.queryByLabelText("Purchase Date")).toBeNull());
  });

  it("пустое поле снимает дату, а не оставляет прежнюю", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...DOMAIN });

    const f = await openEditor();
    type(f.purchase, "");
    type(f.expiry, "   ");
    fireEvent.click(saveBtn());

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    const body = mocks.apiPut.mock.calls[0][1];
    // Пустая строка — единственный способ стереть однажды записанную дату;
    // строка из одних пробелов — та же пустота (тримминг делает разбор).
    expect(body.purchase_date).toBeNull();
    expect(body.expiry_date).toBeNull();
  });

  it("Save выключен, пока хоть одна дата не разобрана — починка ВТОРОЙ его не включает", async () => {
    setTauri(true);
    const f = await openEditor();

    // 31 февраля в календаре нет. Разбор такое не пропускает: без сверки
    // `Date` молча переносит его на 3 марта.
    type(f.purchase, "31.02.2026");
    expect(saveBtn().disabled).toBe(true);

    // Ключевая строка теста: флаг на два поля ОДИН включил бы кнопку прямо
    // здесь — при том что в первом поле по-прежнему стоит несуществующая дата.
    type(f.expiry, "01.12.2027");
    expect(saveBtn().disabled).toBe(true);

    type(f.purchase, "28.02.2026");
    expect(saveBtn().disabled).toBe(false);

    // И наоборот: сломанное ВТОРОЕ поле выключает кнопку так же, как первое.
    type(f.expiry, "01.09.26");
    expect(saveBtn().disabled).toBe(true);
  });

  it("непрочитанную дату не отправить: Save мёртв, и клик по нему ничего не шлёт", async () => {
    setTauri(true);
    const f = await openEditor();

    // Американский порядок — 25-й месяц: продукт печатает день первым и
    // принимает обратно ровно то, что печатает. Отправить такое значило бы
    // записать домену дату, которой никто не называл.
    type(f.purchase, "12/25/2026");
    // Отправить нечем ровно потому, что кнопка мертва: клик по выключенной
    // кнопке обработчик не зовёт вовсе. Гард внутри `save()` — вторая линия и
    // сужение типа, до него эта дорога не доходит.
    expect(saveBtn().disabled).toBe(true);
    fireEvent.click(saveBtn());

    await waitFor(() => expect(mocks.apiPut).not.toHaveBeenCalled());
    // Форма при этом на месте: чинить строку человеку негде, кроме неё.
    expect(screen.getByLabelText("Purchase Date")).toBeTruthy();
  });

  it("непрочитанная строка объясняется ПОД полем и связана с ним", async () => {
    setTauri(true);
    const f = await openEditor();

    type(f.purchase, "31.02.2026");

    // Объяснение — от самого поля (`DateField`), не наше: оно про набранный
    // текст, а не про запись. Появляется, когда набирать больше нечего.
    const describedBy = f.purchase.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const note = document.getElementById(describedBy!.split(" ")[0]);
    expect(note?.textContent).toBe("Expected a real date in DD.MM.YYYY — day first, then month.");

    // Оно обязано встать ПОД полем, а не рядом с ним: `DateField` отдаёт
    // фрагмент, и в обычном ряду его красная строка распёрла бы ряд формы.
    // Ради этого ряд и стал колонкой (`EDITOR_ROW`) — без проверки он молча
    // вернулся бы в строку.
    const row = f.purchase.parentElement!;
    expect(row.contains(note)).toBe(true);
    expect(getComputedStyle(row).flexDirection).toBe("column");
  });

  it("домену без дат Save доступен сразу — и в StrictMode тоже", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...DOMAIN });

    // Приложение обёрнуто в `React.StrictMode` (`src/main.tsx`), и в dev
    // монтирование двойное: поле рассказывает о себе дважды подряд. Тест
    // сторожит не выбор начального состояния (ответ поля приезжает тем же
    // тиком, так что до экрана разница не доживает), а то, что форма приняла
    // этот рассказ как «вот моё состояние», а не как «значение изменилось»:
    // взведи она на нём хоть флаг правки, хоть ошибку — человека у домена без
    // дат встречала бы мёртвая кнопка на пустом месте.
    const f = await openEditor(
      { ...DOMAIN, purchase_date: null, expiry_date: null, cloudflare_zone_id: null },
      true,
    );
    expect(f.purchase.value).toBe("");
    expect(f.expiry.value).toBe("");
    expect(saveBtn().disabled).toBe(false);

    fireEvent.click(saveBtn());
    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    const body = mocks.apiPut.mock.calls[0][1];
    expect(body.purchase_date).toBeNull();
    expect(body.expiry_date).toBeNull();
  });

  it("нечитаемая дата из базы выключает Save, называет причину и выпускает по перенабору", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...DOMAIN });
    // Перестановка цифр в годе (`0226` вместо `2026`) — запись, которая до
    // появления границ правдоподобия доезжала на сервер и оседала в базе.
    // Печатается она тремя цифрами, и разбор её обратно уже не принимает.
    const f = await openEditor({ ...DOMAIN, purchase_date: "0226-09-01" });

    expect(f.purchase.value).toBe("01.09.226");
    // Сохранить поверх такой даты `null` значило бы стереть её молча, а
    // отправить как есть — нечего: строка не прочиталась.
    expect(saveBtn().disabled).toBe(true);
    // Красная строка разбора молчит, пока поля не коснулись (незаконченный
    // набор — не ошибка), а форма заблокирована ЦЕЛИКОМ, включая правку имени.
    // Поэтому причина названа в самой форме, а не только в `title`: у
    // выключенной кнопки подсказку по фокусу не показывает ни один браузер.
    expect(screen.getByText(BLOCKED)).toBeTruthy();
    expect(saveBtn().title).toBe(BLOCKED);

    // Единственная дорога из состояния, которое блокирует форму, — набрать
    // дату заново. Её и сторожим в первую очередь.
    type(f.purchase, "01.09.2026");
    expect(saveBtn().disabled).toBe(false);
    expect(screen.queryByText(BLOCKED)).toBeNull();

    fireEvent.click(saveBtn());
    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    expect(mocks.apiPut.mock.calls[0][1].purchase_date).toBe("2026-09-01");
  });

  it("причина названа и тогда, когда показать нечитаемую дату нечем", async () => {
    setTauri(true);
    // `31.02.2026` в базе `Date` не разбирает вовсе, поэтому печатать полю
    // нечего и оно пустое. Из API такое недостижимо (`Optional[date]`), но
    // состояние выражается типами, и подсказка в нём обязана говорить правду:
    // совет «оставьте поле пустым» здесь был бы издевательством — поле УЖЕ
    // пусто, а Save мёртв.
    const f = await openEditor({ ...DOMAIN, expiry_date: "31.02.2026" });

    expect(f.expiry.value).toBe("");
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByText(BLOCKED)).toBeTruthy();

    type(f.expiry, "01.03.2026");
    expect(saveBtn().disabled).toBe(false);
  });

  it("пустое имя по-прежнему выключает Save — и подсказка про даты молчит", async () => {
    setTauri(true);
    const f = await openEditor();

    // Пробелы, а не пустая строка: `trim()` делает из них ту же пустоту.
    type(f.name, "   ");
    expect(saveBtn().disabled).toBe(true);
    // Причина у мёртвой кнопки тут другая, и строка про даты соврала бы.
    expect(screen.queryByText(BLOCKED)).toBeNull();
    expect(saveBtn().title ?? "").toBe("");
  });
});
