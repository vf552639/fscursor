import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

import DomainBackupTab, { EMPTY_TEXT } from "./DomainBackupTab";
import { fmtDT } from "../../ui/Primitives";
import { desktopOnly } from "../../../lib/runtime";
import { DESKTOP_READS_BACKUPS, type BackupsFacts, type DomainBackup, type DomainFacts } from "../../../lib/domainFacts";
import { setTauri } from "../../../test/secretBlobKit";

/**
 * Вкладка Backup: список резервных копий панели — и четыре разных ответа на
 * вопрос «а знаем ли мы его вообще».
 *
 * Главное правило, которое здесь сторожится, одно: **утверждение об отсутствии
 * копий существует ровно в одном состоянии**. «Сервер не читали», «читать копии
 * не умеем», «прочитали и не разобрали» — это про нас, и сказать в любом из них
 * «копий нет» значило бы выдать своё незнание за измерение сервера (принцип №6
 * CLAUDE.md). Поэтому четыре фразы проверяются вместе, а не по одной: тест
 * ловит не формулировку, а совпадение двух ответов.
 *
 * Второе правило — кнопок на вкладке сегодня нет ни одной, и это проверяется
 * ролями, а не текстом. В десктопе их нет потому, что чтение списка на стороне
 * Rust не написано (`DESKTOP_READS_BACKUPS`), а создание архива приезжает
 * отдельной фазой; в вебе — потому что веб только смотрит. Появись здесь живая
 * с виду кнопка — вернулась бы ровно та болезнь, ради которой снесли заглушку
 * `Backups` с вкладки Server.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-08-19T12:00:00Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function facts(backups?: BackupsFacts): DomainFacts {
  return {
    site: { domain_name: "example.com", site_user: "example_usr", site_path: "/var/www/example.com", php_version: "8.2" },
    ssl: { has_certificate: true, expires_at: null, issuer: null, is_letsencrypt: false },
    ftp_accounts: [],
    php_version: "8.2",
    php_handler: "php-fpm",
    databases: [],
    logs: [],
    backups,
  };
}

function domain(over: Record<string, unknown> = {}) {
  return { id: 42, domain_name: "example.com", status: "active", server_id: 3, ...over } as any;
}

function show(over: Record<string, unknown> = {}) {
  return render(<DomainBackupTab domain={domain(over)} now={NOW} />);
}

/** Домен со снимком, в котором список копий такой, как просят. */
function showListed(entries: DomainBackup[], over: Record<string, unknown> = {}) {
  return show({
    fp_facts: facts({ state: "known", entries, probed: ["site_row"] }),
    fp_facts_at: ago(2 * HOUR),
    ...over,
  });
}

/** Копия со всеми полями; в тестах перекрывается по одному. */
function backup(over: Partial<DomainBackup> = {}): DomainBackup {
  return {
    id: "b1",
    name: "example.com-2026-08-19.tar",
    path: "/var/backups/example.com-2026-08-19.tar",
    created_at: ago(3 * HOUR),
    size_bytes: 2048,
    source: "site_row",
    ...over,
  };
}

/** Четыре состояния пустоты — тем же порядком, каким они стоят в `backupsOf`. */
const EMPTY_STATES: Record<string, Record<string, unknown>> = {
  "no-snapshot": {},
  "not-in-snapshot": { fp_facts: facts(), fp_facts_at: ago(2 * HOUR) },
  unreadable: {
    fp_facts: facts({ state: "unknown", entries: [], probed: ["site_row", "plan_cli"] }),
    fp_facts_at: ago(2 * HOUR),
  },
  "listed-empty": {
    fp_facts: facts({ state: "known", entries: [], probed: ["site_row"] }),
    fp_facts_at: ago(2 * HOUR),
  },
};

const rows = () => within(screen.getByRole("list", { name: "Backup copies" })).getAllByRole("listitem");

beforeEach(() => {
  setTauri(true);
});

afterEach(() => {
  cleanup();
  setTauri(false);
});

describe("четыре состояния пустоты — четыре разных ответа", () => {
  it("ни одна фраза не повторяет соседнюю", () => {
    // Сравниваются сами фразы, а не текст отрендеренной панели: у состояний
    // различается ещё и строка возраста снимка («Never checked» против
    // «Checked 2h ago»), и по полному тексту две СЛИТЫЕ фразы всё равно дали бы
    // разные страницы — то есть проверка прошла бы мимо той единственной
    // поломки, ради которой написана.
    const texts = Object.values(EMPTY_TEXT);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("каждому состоянию достаётся его собственная фраза, а не соседняя", () => {
    // Вторая половина того же правила: фразы могут быть разными и при этом
    // разъехаться по состояниям. Проверяется отображение состояние → фраза,
    // поэтому текст берётся из той же карты, что и у компонента: сочинить свою
    // формулировку тест не разрешает никому.
    for (const [state, over] of Object.entries(EMPTY_STATES)) {
      show(over);
      const key = state === "listed-empty" ? "listed" : state;
      expect(screen.getByText(EMPTY_TEXT[key as keyof typeof EMPTY_TEXT])).toBeTruthy();
      cleanup();
    }
  });

  it("пока список читать нечем, оба достижимых состояния говорят это прямо", () => {
    // Достижимы сегодня два состояния из четырёх — `no-snapshot` и
    // `not-in-snapshot`, — и новый снимок не лечит ни одно. «Сервер ещё не
    // читали» само по себе правда, но без оговорки читается как «прочитай, и
    // узнаем»: та же болезнь, что кнопка-обещание, только выраженная фразой.
    //
    // Импликатуру машиной не проверить, поэтому проверяется наличие самой
    // оговорки — она и есть то, что снимает ложное обещание. Сними гейт с любой
    // из двух фраз, и тест покраснеет. При `DESKTOP_READS_BACKUPS = true`
    // правило обратное (там как раз нужно звать переснять), и тест выключается
    // вместе с константой.
    if (DESKTOP_READS_BACKUPS) return;
    expect(EMPTY_TEXT["no-snapshot"]).toMatch(/does not read/i);
    expect(EMPTY_TEXT["not-in-snapshot"]).toMatch(/does not read/i);
  });

  it("«копий нет» звучит РОВНО в одном состоянии — там, где панель ответила", () => {
    // Утверждение об отсутствии — измерение, и позволить его себе можно только
    // после ответа панели. Три остальных состояния говорят о нашем незнании, и
    // в них этой мысли не должно быть ни в какой формулировке.
    const claiming: string[] = [];
    for (const [state, over] of Object.entries(EMPTY_STATES)) {
      const { container } = show(over);
      if (/no backup copies/i.test(container.textContent ?? "")) claiming.push(state);
      cleanup();
    }
    expect(claiming).toEqual(["listed-empty"]);
  });

  it("снимка не было — фраза про непрочитанный сервер, а не про копии", () => {
    show(EMPTY_STATES["no-snapshot"]);
    expect(screen.getByText(/has not been read for this domain yet/)).toBeTruthy();
    // И возраст снимка тут же, словами: «Never checked» — это общая шапка.
    expect(screen.getByText("Never checked")).toBeTruthy();
  });

  it("поля в снимке нет — вкладка признаёт, что читать копии пока не умеет, и не зовёт переснимать", () => {
    // Пока `DESKTOP_READS_BACKUPS` = false, новый снимок поля не принесёт.
    // Фраза «пересними» отправила бы человека жать кнопку, которая ничего не
    // изменит, — потому кнопки рядом и нет (проверено ниже).
    show(EMPTY_STATES["not-in-snapshot"]);
    expect(screen.getByText(/does not read the copies FastPanel keeps yet/)).toBeTruthy();
  });

  it("список не разобрался — так и сказано, без превращения в пустоту", () => {
    show(EMPTY_STATES.unreadable);
    expect(screen.getByText(/could not read the list of copies/)).toBeTruthy();
  });

  it("панель ответила пустым списком — единственное «копий нет»", () => {
    show(EMPTY_STATES["listed-empty"]);
    expect(screen.getByText(/FastPanel shows no backup copies for this site/)).toBeTruthy();
  });
});

describe("органов управления нет ни одного", () => {
  it("в десктопе кнопки «Проверить на сервере» нет: пересъёмка списка не принесёт", () => {
    // Асимметрия с вкладкой Logs осознанная: там снимок реально приносит пути
    // логов, здесь — ничего, пока не написано чтение бэкапов в Rust.
    for (const over of Object.values(EMPTY_STATES)) {
      show(over);
      expect(screen.queryAllByRole("button")).toEqual([]);
      cleanup();
    }
  });

  it("в вебе кнопок нет и сказано почему — общей фразой продукта", () => {
    setTauri(false);
    showListed([backup()]);
    // Список при этом виден: веб смотрит те же данные, он только не выполняет.
    expect(rows()).toHaveLength(1);
    expect(screen.queryAllByRole("button")).toEqual([]);
    // Формулировка — общая `desktopOnly`, а не своя: иначе вкладка сочинила бы
    // четвёртый вариант объяснения одного и того же правила продукта.
    expect(screen.getByText(desktopOnly("Creating backups"))).toBeTruthy();
  });

  it("ни селекта, ни поля пути, ни «Save» — того, что рисует макет, здесь нет", () => {
    showListed([backup()]);
    expect(screen.queryAllByRole("combobox")).toEqual([]);
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(screen.queryAllByRole("button")).toEqual([]);
    // Меты «Last backup: … · 412 MB» из макета тоже нет: её никто не измерял.
    expect(document.body.textContent).not.toMatch(/Last backup/i);
  });
});

describe("домен без сервера", () => {
  it("своя фраза — читать копии не с чего, и ни одной кнопки", () => {
    show({ server_id: null });
    expect(screen.getByText(/not bound to a server/)).toBeTruthy();
    // И это не «копий нет»: сервера у домена нет, а не копий на сервере.
    expect(document.body.textContent).not.toMatch(/no backup copies/i);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("но приехавший список показывается и без нашей записи о сервере", () => {
    // Список пришёл из снимка, то есть с настоящего сервера. Спрятать его из-за
    // пустой колонки `server_id` значило бы поверить нашей записи больше, чем
    // факту, — карточка домена устроена ровно наоборот.
    showListed([backup()], { server_id: null });
    expect(rows()).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/not bound to a server/);
  });

  it("снимок есть, а привязки нет — отвечает снимок, а не наша колонка", () => {
    // Домен отвязали ПОСЛЕ съёмки: «not bound to a server» под строкой «Checked
    // 2h ago» спорит сам с собой и прячет настоящий ответ панели. Правило «факт
    // важнее записи» действует и на пустой список, а не только на непустой.
    show({ ...EMPTY_STATES["listed-empty"], server_id: null });
    expect(screen.getByText(EMPTY_TEXT.listed)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/not bound to a server/);
    // И то же самое для «поля нет» — это тоже ответ про снимок, а не про запись.
    cleanup();
    show({ ...EMPTY_STATES["not-in-snapshot"], server_id: null });
    expect(screen.getByText(EMPTY_TEXT["not-in-snapshot"])).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/not bound to a server/);
  });
});

describe("список копий", () => {
  it("это список из N элементов, а не ряд одинаковых блоков", () => {
    // `role="list"` с именем: скринридер объявляет «list, 2 items» — то есть
    // отвечает на «сколько их» до чтения строк.
    showListed([backup({ id: "a" }), backup({ id: "b", created_at: ago(DAY) })]);
    expect(rows()).toHaveLength(2);
  });

  it("новые сверху, копия без даты — в конце", () => {
    showListed([
      backup({ id: "undated", name: "no-date.tar", created_at: undefined }),
      backup({ id: "old", name: "old.tar", created_at: ago(3 * DAY) }),
      backup({ id: "new", name: "new.tar", created_at: ago(HOUR) }),
    ]);
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining("new.tar"),
      expect.stringContaining("old.tar"),
      expect.stringContaining("no-date.tar"),
    ]);
  });

  it("дата печатается общим форматом карточки", () => {
    const created = ago(3 * HOUR);
    showListed([backup({ created_at: created })]);
    expect(rows()[0].textContent).toContain(fmtDT(created));
  });

  it("даты нет — слово «date unknown», а не прочерк", () => {
    // Прочерк читался бы как «спросили, там пусто»; про дату этой копии мы не
    // спрашивали — её просто нет в ответе панели.
    showListed([backup({ created_at: undefined })]);
    expect(rows()[0].textContent).toContain("date unknown");
    expect(rows()[0].textContent).not.toContain("Invalid Date");
  });

  it("мусор вместо даты — то же «date unknown», а не «Invalid Date»", () => {
    showListed([backup({ created_at: "вчера вечером" })]);
    expect(rows()[0].textContent).toContain("date unknown");
    expect(rows()[0].textContent).not.toContain("Invalid Date");
  });

  it("размер не прочитан — прочерк, и он назван словом для слуха", () => {
    // Глиф «—» скринридеры не читают вовсе, поэтому у прочерка есть `aria-label`:
    // иначе «размер не прочитан» пришлось бы выводить из тишины.
    showListed([backup({ size_bytes: undefined })]);
    const dash = within(rows()[0]).getByLabelText("size not read");
    expect(dash.textContent).toBe("—");
  });

  it("непонятный размер с провода — тот же прочерк, и он тоже назван словом", () => {
    // `formatBytes` отвечает прочерком не только на отсутствие: отрицательное и
    // нефинитное — тоже «не размер». Спроси мы про ТИП поля, такой прочерк
    // остался бы немым, и различие ушло бы в канал, которого у скринридера нет.
    for (const bytes of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      showListed([backup({ size_bytes: bytes })]);
      const dash = within(rows()[0]).getByLabelText("size not read");
      expect(dash.textContent).toBe("—");
      cleanup();
    }
  });

  it("настоящий ноль — «0 B», а не прочерк и не «не прочитали»", () => {
    showListed([backup({ size_bytes: 0 })]);
    expect(rows()[0].textContent).toContain("0 B");
    expect(within(rows()[0]).queryByLabelText("size not read")).toBeNull();
  });

  it("размер известен — человеческий формат, и метки «не прочитали» рядом нет", () => {
    showListed([backup({ size_bytes: 2048 })]);
    expect(rows()[0].textContent).toContain("2 KB");
    expect(within(rows()[0]).queryByLabelText("size not read")).toBeNull();
  });

  it("полный путь — в `title` строки: на экране он вытеснил бы всё остальное", () => {
    showListed([backup({ path: "/var/backups/example.com-2026-08-19.tar" })]);
    expect(rows()[0].getAttribute("title")).toBe("/var/backups/example.com-2026-08-19.tar");
  });

  it("имени нет — подписью становится имя файла, а не пустое место", () => {
    showListed([backup({ name: undefined, path: "/var/backups/site-2026.tar" })]);
    expect(rows()[0].textContent).toContain("site-2026.tar");
  });
});

describe("провалившаяся проверка", () => {
  it("ошибка последней попытки видна рядом с ПРЕЖНИМ возрастом, а список остаётся", () => {
    // Снимок при провале не меняется: сервер не трогает `fp_facts`. Значит и
    // список обязан остаться прежним, и возраст — не помолодеть.
    showListed([backup()], { fp_check_error: "ssh: handshake failed" });
    expect(screen.getByRole("alert").textContent).toContain("ssh: handshake failed");
    expect(screen.getByText(/Checked 2h ago/)).toBeTruthy();
    expect(rows()).toHaveLength(1);
  });
});

describe("отложенное названо словами", () => {
  it("внешнее хранилище с расписанием и восстановление — обе строки на месте", () => {
    // Строка про restore обязательна: список копий без единого слова о
    // восстановлении читается как обещание «отсюда можно откатиться».
    showListed([backup()]);
    expect(screen.getByText(/External storage \(S3\/FTP\) and a backup schedule/)).toBeTruthy();
    expect(screen.getByText(/Restoring a site from an archive is not part of SDMP/)).toBeTruthy();
  });

  it("сказано и то, почему нельзя создать копию отсюда", () => {
    // Вкладка про резервные копии, на которой нельзя сделать копию и не сказано
    // почему, читается как поломка. Строку снимает фаза 7 вместе с кнопкой.
    showListed([backup()]);
    expect(screen.getByText(/Making a backup from here is not available yet/)).toBeTruthy();
  });
});
