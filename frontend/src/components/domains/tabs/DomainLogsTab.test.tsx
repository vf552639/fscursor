import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainLogsTab from "./DomainLogsTab";
import { queryClient } from "../../../api/queryClient";
import type { DomainFacts } from "../../../lib/domainFacts";
import { luminanceOfRgb } from "../../../test/colors";
import { setTauri, setBlobUser, clearBlobUser } from "../../../test/secretBlobKit";

/**
 * Вкладка Logs: перечень лог-файлов сайта из снимка сервера — и честный ответ о
 * том, чего мы про них не знаем.
 *
 * Три из проверяемых здесь правил — восстановленные. Раньше перечень логов был
 * одной строкой `FactRow` в карточке Site, и вместе с её удалением с экрана
 * ушли гарантии: что печатается КАЖДЫЙ путь снимка, что несуществующий файл
 * отличим от существующего (это не проверялось вообще никогда) и что пустой
 * список под снимком не выдаётся за измеренную пустоту. Здесь они снова под
 * тестом.
 *
 * Остальное — правила самой вкладки: подпись чипа выводится из пути (а не
 * берётся из зашитой четвёрки), в бейдже стоит РАЗМЕР (числа строк мы не
 * считали), переключение чипа меняет напечатанный путь, а тело вкладки во всех
 * трёх состояниях говорит словами, а не рисует выдуманные строки лога.
 */

const mocks = vi.hoisted(() => ({ invokeSynced: vi.fn() }));

vi.mock("../../../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Реальная раскладка путей из `ssh/fastpanel_facts.rs::log_candidates`. */
const LOGS: DomainFacts["logs"] = [
  { path: "/var/www/example_usr/data/logs/example.com-frontend.access.log", exists: true, size_bytes: 2048 },
  { path: "/var/www/example_usr/data/logs/example.com-frontend.error.log", exists: true, size_bytes: 0 },
  { path: "/var/www/example_usr/data/logs/example.com-backend.access.log", exists: true, size_bytes: null },
  { path: "/var/www/example_usr/data/logs/example.com-backend.error.log", exists: false, size_bytes: null },
];

function facts(over: Partial<DomainFacts> = {}): DomainFacts {
  return {
    site: { domain_name: "example.com", site_user: "example_usr", site_path: "/var/www/example.com", php_version: "8.2" },
    ssl: { has_certificate: true, expires_at: ahead(60 * DAY), issuer: "Let's Encrypt", is_letsencrypt: true },
    ftp_accounts: [],
    php_version: "8.2",
    php_handler: "php-fpm",
    databases: [],
    logs: LOGS,
    ...over,
  };
}

function domain(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    domain_name: "example.com",
    status: "active",
    server_id: 3,
    ...over,
  } as any;
}

function show(over: Record<string, unknown> = {}) {
  render(
    <QueryClientProvider client={queryClient}>
      <DomainLogsTab domain={domain(over)} now={Date.now()} />
    </QueryClientProvider>,
  );
}

/** Домен со свежим снимком — самое частое состояние вкладки. */
function showWithSnapshot(over: Partial<DomainFacts> = {}, domainOver: Record<string, unknown> = {}) {
  show({ fp_facts: facts(over), fp_facts_at: ago(2 * HOUR), ...domainOver });
}

const chips = () => screen.getByRole("group", { name: "Log files" });
const chip = (name: string | RegExp) => within(chips()).getByRole("button", { name });

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  setBlobUser();
});

afterEach(() => {
  cleanup();
  setTauri(false);
  clearBlobUser();
  queryClient.clear();
});

describe("перечень файлов", () => {
  it("на экран попадает КАЖДЫЙ путь снимка", () => {
    // Гарантия, потерянная вместе со строкой `Logs` карточки Site: перечень
    // может молча укоротиться (взяли `logs[0]`, отфильтровали несуществующие),
    // и человек будет искать файл, который на сервере есть.
    showWithSnapshot();
    const buttons = within(chips()).getAllByRole("button");
    expect(buttons).toHaveLength(LOGS.length);
    for (const f of LOGS) {
      // Чип находим по его `title` (это полный путь файла), а выбрав —
      // проверяем, что путь напечатан строкой под чипами.
      const b = buttons.find((x) => x.getAttribute("title") === f.path);
      expect(b).toBeTruthy();
      fireEvent.click(b!);
      expect(screen.getByText(f.path)).toBeTruthy();
    }
  });

  it("подпись чипа выведена из пути, а не из зашитой четвёрки", () => {
    showWithSnapshot();
    expect(chip(/^Frontend access/)).toBeTruthy();
    expect(chip(/^Frontend error/)).toBeTruthy();
    expect(chip(/^Backend access/)).toBeTruthy();
    expect(chip(/^Backend error/)).toBeTruthy();
  });

  it("путь незнакомой формы подписан именем файла и ничего не ломает", () => {
    // Раскладка путей принадлежит FastPanel и десктопу; поменяйся она — вкладка
    // обязана показать файл, а не упасть и не подписать его чужим именем.
    showWithSnapshot({
      logs: [{ path: "/var/log/nginx/example.com.error.log", exists: true, size_bytes: 10 }],
    });
    expect(chip(/^example\.com\.error\.log/)).toBeTruthy();
  });

  it("несуществующий файл назван словом, а не одним лишь цветом", () => {
    // Правило, которого не было в тестах никогда: `exists: false` виден. Слово
    // в бейдже — главный канал: цвет не доезжает ни до скринридера, ни до
    // чёрно-белой печати, а `title` — ни до тача, ни до клавиатуры.
    showWithSnapshot();
    const missing = chip(/^Backend error/);
    expect(missing.textContent).toContain("missing");
    expect(chip(/^Frontend error/).textContent).not.toContain("missing");
  });

  it("«размер не прочитан» тоже назван словом: прочерк на слух не звучит", () => {
    // Близнец теста выше. Глиф «—» скринридер по умолчанию не произносит, и без
    // метки чип объявлялся бы просто «Backend access» — то есть состояние
    // пришлось бы выводить из отсутствия размера, из тишины.
    showWithSnapshot();
    expect(chip(/^Backend access/).textContent).toContain("—");
    expect(within(chips()).getByRole("button", { name: /Backend access\s*size not read/ })).toBeTruthy();
    // У измеренного файла метки нет: его содержимое читается как есть.
    expect(within(chips()).queryByRole("button", { name: /Frontend access\s*size not read/ })).toBeNull();
  });

  it("и приглушён цветом — вторым каналом, дублирующим слово", () => {
    // Сравниваем светлоту двух цветов, а не конкретный hex: цвет уедет в токены
    // вместе с редизайном, а различимость должна остаться.
    showWithSnapshot();
    const missing = chip(/^Backend error/);
    const present = chip(/^Frontend error/);
    expect(missing.style.color).not.toBe(present.style.color);
    expect(luminanceOfRgb(missing.style.color)).toBeGreaterThan(luminanceOfRgb(present.style.color));
  });
});

describe("бейдж чипа — размер, а не число строк", () => {
  it("существующий файл показывает свой размер", () => {
    showWithSnapshot();
    expect(chip(/^Frontend access/).textContent).toContain("2 KB");
  });

  it("пустой файл — это ноль, а не прочерк", () => {
    // Пустой лог на сервере ЕСТЬ, и его пустота измерена: прочерк тут читался
    // бы как «не знаем».
    showWithSnapshot();
    expect(chip(/^Frontend error/).textContent).toContain("0 B");
  });

  it("размер не прочитан — прочерк, и файл при этом не назван пустым", () => {
    showWithSnapshot();
    const c = chip(/^Backend access/);
    expect(c.textContent).toContain("—");
    expect(c.textContent).not.toContain("0 B");
  });

  it("прочерк значит РОВНО «размер не прочитан»: у несуществующего файла его нет", () => {
    // Пока прочерк стоял в обоих состояниях, различал их один лишь цвет.
    showWithSnapshot();
    const missing = chip(/^Backend error/);
    expect(missing.textContent).not.toContain("—");
    expect(missing.textContent).not.toContain("0 B");
  });
});

describe("выбор файла", () => {
  it("под чипами стоит полный путь ВЫБРАННОГО файла, и он меняется по клику", () => {
    showWithSnapshot();
    expect(screen.getByText(LOGS[0].path)).toBeTruthy();
    expect(screen.queryByText(LOGS[3].path)).toBeNull();

    fireEvent.click(chip(/^Backend error/));

    expect(screen.getByText(LOGS[3].path)).toBeTruthy();
    expect(screen.queryByText(LOGS[0].path)).toBeNull();
  });

  it("выбранный чип связан со строкой пути, а невыбранные — нет", () => {
    // Глазами путь стоит под чипами и потому к ним относится; на слух это
    // реплика ниоткуда, пока связь не названа. Та же болезнь, которую на
    // вкладке Server лечит `TabGroup`.
    showWithSnapshot();
    const active = chip(/^Frontend access/);
    const described = active.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toBe(LOGS[0].path);
    expect(chip(/^Backend error/).getAttribute("aria-describedby")).toBeNull();
  });

  it("выбранный чип объявлен нажатым, и нажат ровно один", () => {
    showWithSnapshot();
    expect(chip(/^Frontend access/).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip(/^Backend access/));
    expect(chip(/^Backend access/).getAttribute("aria-pressed")).toBe("true");
    expect(
      within(chips())
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true"),
    ).toHaveLength(1);
  });
});

describe("выбор пережил перечитывание снимка", () => {
  it("исчезнувший из снимка файл не остаётся напечатанным путём", () => {
    // Список приезжает из снимка и переснимается кнопкой: сайт мог переехать,
    // владелец — смениться. Прежний путь под чипами, которого в перечне уже
    // нет, — это ответ про файл, о котором мы больше ничего не знаем.
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <DomainLogsTab domain={domain({ fp_facts: facts(), fp_facts_at: ago(2 * HOUR) })} now={Date.now()} />
      </QueryClientProvider>,
    );
    fireEvent.click(chip(/^Backend error/));
    expect(screen.getByText(LOGS[3].path)).toBeTruthy();

    const moved = facts({ logs: [{ path: "/var/www/other/data/logs/example.com-frontend.access.log", exists: true, size_bytes: 12 }] });
    rerender(
      <QueryClientProvider client={queryClient}>
        <DomainLogsTab domain={domain({ fp_facts: moved, fp_facts_at: ago(1 * HOUR) })} now={Date.now()} />
      </QueryClientProvider>,
    );

    expect(screen.queryByText(LOGS[3].path)).toBeNull();
    expect(screen.getByText(moved.logs[0].path)).toBeTruthy();
  });
});

describe("тело вкладки — честное состояние", () => {
  it("файлы есть, но их содержимое мы читать не умеем — и говорим это", () => {
    showWithSnapshot();
    expect(screen.getByText(/Reading log contents is not wired up yet/)).toBeTruthy();
    // Ни таблицы access, ни тёмной консоли, ни единой выдуманной строки лога.
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/\[error\]/)).toBeNull();
  });

  it("ни «Refresh», ни «Download»: кнопка, которая ничего не делает, обещает функцию", () => {
    setTauri(true);
    showWithSnapshot();
    expect(screen.queryByText("Refresh")).toBeNull();
    expect(screen.queryByText("Download")).toBeNull();
    // Кнопок на вкладке со снимком нет вовсе — только чипы выбора файла.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(LOGS.length);
  });

  it("снимок есть, а список пуст — это «не знаем, где они лежат», а не «логов нет»", () => {
    // Фраза «no log files» соврала бы измерение, которого не было: пустой
    // список приезжает и от ненайденного владельца, и от упавшей на сервере
    // команды (её код возврата десктоп выбрасывает), и от снимка, снятого до
    // появления поля. Поэтому причина на экране не называется вовсе — только
    // наше незнание.
    showWithSnapshot({ logs: [] });
    expect(screen.queryByRole("group", { name: "Log files" })).toBeNull();
    expect(screen.getByText(/no log paths for this site/)).toBeTruthy();
    expect(screen.queryByText(/Reading log contents is not wired up yet/)).toBeNull();
    // Диагноза, которого мы поставить не можем, на экране нет.
    expect(screen.queryByText(/owner/i)).toBeNull();
  });

  it("снимок старее самого поля `logs` — то же состояние, а не падение", () => {
    // `fp_facts` без `logs` приезжает от снимков, снятых до появления поля в
    // контракте; `?? []` сводит их к той же честной пустоте.
    showWithSnapshot({ logs: undefined as unknown as DomainFacts["logs"] });
    expect(screen.getByText(/no log paths for this site/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Log files" })).toBeNull();
  });
});

describe("снимка не было ни разу", () => {
  it("вместо чипов — «Never checked» и слова, почему пусто", () => {
    show();
    expect(screen.getByText("Never checked")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Log files" })).toBeNull();
    expect(screen.getByText(/none has been taken yet/)).toBeTruthy();
  });

  it("в десктопе есть кнопка снятия снимка, и она зовёт то же чтение, что Server", async () => {
    // Та же команда и тот же прогон (`useReadDomainFacts`), что у кнопки
    // вкладки Server: разойтись двум кнопкам нельзя — снимок один.
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue(facts());
    show();
    fireEvent.click(screen.getByText("Проверить на сервере"));
    await waitFor(() =>
      expect(mocks.invokeSynced).toHaveBeenCalledWith("domain_read_facts", {
        userId: "user-1",
        domainId: "42",
      }),
    );
  });

  it("в вебе кнопки нет: чтение идёт по SSH", () => {
    setTauri(false);
    show();
    expect(screen.queryByText("Проверить на сервере")).toBeNull();
  });

  it("под снимком кнопки чтения нет: за перечитывание отвечает вкладка Server", async () => {
    setTauri(true);
    showWithSnapshot();
    expect(screen.queryByText("Проверить на сервере")).toBeNull();
    // `mutate` зовёт `mutationFn` асинхронно, поэтому «ничего не запускалось»
    // проверяем ПОСЛЕ микрозадач: синхронная проверка была бы пустой.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
  });
});

describe("провал последней попытки", () => {
  it("виден на Logs, а не только на Server", () => {
    // Кнопка чтения здесь единственная, а `runReadDomainFacts` наружу ничего не
    // возвращает намеренно: провал он кладёт в `fp_check_error` и инвалидирует
    // список — ровно затем, чтобы экран его показал. Без этой строки упавшее по
    // SSH чтение оставляло бы вкладку в точности такой же, какой она была до
    // клика.
    show({ fp_check_error: "ssh: handshake failed" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("ssh: handshake failed");
  });

  it("снимок при этом остаётся: «проверка упала» и «данные устарели» — разные новости", () => {
    showWithSnapshot({}, { fp_check_error: "ssh: handshake failed" });
    expect(screen.getByRole("alert").textContent).toContain("ssh: handshake failed");
    expect(chip(/^Frontend access/)).toBeTruthy();
    expect(screen.getByText(/Checked/)).toBeTruthy();
  });

  it("ошибки нет — нет и алерта: пустая строка обещала бы поломку", () => {
    showWithSnapshot();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("свежесть снимка", () => {
  it("возраст снимка напечатан, старый помечен протухшим", () => {
    showWithSnapshot({}, { fp_facts_at: ago(8 * DAY) });
    // Размеры файлов — измерение: без возраста они читаются как сегодняшние.
    expect(screen.getByText(/Checked/).textContent).toContain("stale");
  });

  it("протухший возраст отличается от свежего не только словом «stale»", () => {
    // Тот же приём, что у показаний сервера (`STALE_TEXT` против обычного
    // серого): подпись «· stale» — второй канал, а не единственный.
    showWithSnapshot({}, { fp_facts_at: ago(8 * DAY) });
    const staleColor = screen.getByText(/Checked/).style.color;
    cleanup();
    showWithSnapshot({}, { fp_facts_at: ago(2 * HOUR) });
    expect(screen.getByText(/Checked/).style.color).not.toBe(staleColor);
  });

  it("свежесть считается от снимка, а не от последней ПОПЫТКИ", () => {
    // Провалившаяся проверка не должна молодить перечень логов: `fp_checked_at`
    // свежий, снимок — недельной давности.
    showWithSnapshot({}, { fp_facts_at: ago(8 * DAY), fp_checked_at: ago(60 * 1000) });
    expect(screen.getByText(/Checked/).textContent).toContain("stale");
    expect(screen.getByText(/Checked/).textContent).not.toContain("1m ago");
  });
});

