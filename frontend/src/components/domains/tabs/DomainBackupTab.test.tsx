import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  invokeSynced: vi.fn(),
  invokeIfTauri: vi.fn(),
  chooseSavePath: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../../../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

/** Отмена идёт мимо `invokeSynced`: ей нечего резолвить и некогда ждать. */
vi.mock("../../../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

vi.mock("../../../lib/chooseSavePath", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  chooseSavePath: mocks.chooseSavePath,
}));

/**
 * Подписка на `backup:progress` живёт в сторе и ставится настоящим `listen`.
 * Мок нужен ради двух вещей сразу: в jsdom плагина событий нет (настоящая
 * подписка упала бы), а события прогресса надо уметь ПРИСЛАТЬ — полоса и её
 * отсутствие проверяются именно ими.
 */
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import DomainBackupTab, { EMPTY_TEXT } from "./DomainBackupTab";
import { fmtDT } from "../../ui/Primitives";
import { queryClient } from "../../../api/queryClient";
import { desktopOnly } from "../../../lib/runtime";
import { DESKTOP_READS_BACKUPS, type BackupsFacts, type DomainBackup, type DomainFacts } from "../../../lib/domainFacts";
import { useBackupRunsStore, type BackupProgressPayload } from "../../../store/backupRuns";
import { setTauri, setBlobUser, clearBlobUser } from "../../../test/secretBlobKit";

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
 * Второе правило — про органы управления, и оно проверяется РОЛЯМИ, а не
 * текстом: **в вебе кнопок нет ни одной, в десктопе есть ровно одна**. В вебе —
 * потому что веб только смотрит (принцип №3). В десктопе одна: «Create backup».
 * Второй, «Check on server», здесь нет намеренно — новый снимок списка не
 * принесёт (`DESKTOP_READS_BACKUPS`), — и «ровно одна» сторожит именно это:
 * появись рядом кнопка, обещающая починить пустой список, вернулась бы та самая
 * болезнь, ради которой снесли заглушку `Backups` с вкладки Server.
 *
 * Третье — правила «не соврать» про сам прогон: «Saved» рисует только ответ
 * команды, отмена панели сохранения не оставляет следа, путь печатается
 * возвращённый, а полоса прогресса — только при известном знаменателе.
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
  // Провайдер нужен с тех пор, как на вкладке появилась кнопка: признак «идёт
  // прогон» читается из `MutationCache` (гейт `api/runGate.ts`), а не из стейта
  // компонента, — именно поэтому он и переживает закрытие карточки.
  return render(
    <QueryClientProvider client={queryClient}>
      <DomainBackupTab domain={domain(over)} now={NOW} />
    </QueryClientProvider>,
  );
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

/** Кнопка покоя и кнопка прогона: на экране всегда ровно одна из них. */
const createBtn = () => screen.getByRole("button", { name: "Create backup" });
const cancelBtn = () => screen.getByRole("button", { name: "Cancel" });
const cancelCalls = () =>
  mocks.invokeIfTauri.mock.calls.filter((c: unknown[]) => c[0] === "domain_backup_cancel");

/** Путь, который выбрал человек, и путь, который вернула команда, — РАЗНЫЕ. */
const CHOSEN = "/Users/me/Documents/example.com";
const RETURNED = "/Users/me/Documents/example.com-20260819T103000Z.tar";

/** Ответ `domain_backup_create` — в форме `BackupResult` из Rust. */
function backupResult(over: Record<string, unknown> = {}) {
  return {
    file_name: "example.com-20260819T103000Z.tar",
    path: RETURNED,
    bytes: 2048,
    sha256: "abc",
    parts: [],
    warnings: [],
    duration_ms: 1234,
    facts_refreshed: true,
    ...over,
  };
}

/**
 * Слушатель, которого поставил стор. Держится ФАЙЛОВОЙ переменной, а не
 * `mocks.listen.mock.calls`, и это прямое следствие проверяемого свойства:
 * подписка одна на всё приложение и ставится единожды, так что в тестах после
 * первого `listen` больше не зовётся — а счётчик вызовов `vi.resetAllMocks`
 * между тестами обнуляет. Сам слушатель при этом остаётся рабочим: он замкнут
 * на стор, а не на рендер.
 */
let progressHandler: ((e: { payload: BackupProgressPayload }) => void) | null = null;

/** Прислать событие прогресса тем же путём, каким оно приходит из Rust. */
async function emitProgress(payload: Partial<BackupProgressPayload> = {}) {
  expect(progressHandler, "подписка на backup:progress не поставлена").toBeTruthy();
  await act(async () => {
    progressHandler!({ payload: { domain_id: "42", step: "download", ...payload } });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listen.mockImplementation(async (_event: string, cb: any) => {
    progressHandler = cb;
    // Отписка ГАСИТ хендлер, а не возвращает пустышку. Разница несущая: с
    // пустышкой подписка, перенесённая в эффект компонента и снимаемая при
    // размонтировании, прошла бы весь набор зелёной — то есть осознанное
    // решение «слушатель живёт столько же, сколько приложение» осталось бы
    // незакреплённым, и следующий человек снёс бы его как утечку.
    return () => {
      progressHandler = null;
    };
  });
  mocks.chooseSavePath.mockResolvedValue(CHOSEN);
  mocks.invokeSynced.mockResolvedValue(backupResult());
  mocks.invokeIfTauri.mockResolvedValue(true);
  queryClient.clear();
  useBackupRunsStore.setState({ runs: {} });
  setBlobUser();
  setTauri(true);
});

afterEach(() => {
  cleanup();
  setTauri(false);
  clearBlobUser();
  queryClient.clear();
  useBackupRunsStore.setState({ runs: {} });
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

describe("органов управления ровно столько, сколько работает", () => {
  it("в десктопе кнопка РОВНО ОДНА — создание копии, в любом состоянии списка", () => {
    // «Ровно одна» — не придирка к числу: вторая напрашивающаяся кнопка,
    // «Check on server», обещала бы починить пустой список, а новый
    // снимок его не принесёт (`DESKTOP_READS_BACKUPS`). Асимметрия с вкладкой
    // Logs осознанная: там снимок реально приносит пути логов, здесь — ничего.
    // Создание при этом от списка не зависит и есть во всех состояниях.
    for (const over of Object.values(EMPTY_STATES)) {
      show(over);
      expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Create backup"]);
      cleanup();
    }
  });

  it("кнопки отмены вне прогона нет вовсе: отменять нечего", () => {
    // Кнопка, которой не с чем работать, обещала бы действие, которого нет, —
    // ровно то, ради чего с этой вкладки сносили заглушки.
    showListed([backup()]);
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });

  it("в вебе кнопок нет ни одной и сказано почему — общей фразой продукта", () => {
    setTauri(false);
    showListed([backup()]);
    // Список при этом виден: веб смотрит те же данные, он только не выполняет.
    expect(rows()).toHaveLength(1);
    expect(screen.queryAllByRole("button")).toEqual([]);
    // Формулировка — общая `desktopOnly`, а не своя: иначе вкладка сочинила бы
    // четвёртый вариант объяснения одного и того же правила продукта.
    expect(screen.getByText(desktopOnly("Creating backups"))).toBeTruthy();
  });

  it("в вебе кнопок нет и во время прогона — ни создания, ни отмены", () => {
    // Прогон в вебе не запустить, но строка о нём приехать может: стор
    // модульный, а сборка одна на оба рантайма. Органов управления рядом с ней
    // не появляется ни одного (принцип №3).
    useBackupRunsStore.setState({
      runs: {
        "42": {
          step: "download",
          doneBytes: 10,
          totalBytes: 100,
          outcome: null,
          cancelRequested: false,
          notes: [],
        },
      },
    });
    setTauri(false);
    showListed([backup()]);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("ни селекта, ни поля пути, ни «Save» — того, что рисует макет, здесь нет", () => {
    showListed([backup()]);
    expect(screen.queryAllByRole("combobox")).toEqual([]);
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    // Меты «Last backup: … · 412 MB» из макета тоже нет: её никто не измерял.
    expect(document.body.textContent).not.toMatch(/Last backup/i);
  });

  it("домен без сервера: кнопка выключена и сказано, чего не хватает", () => {
    // Собирать архив не с чего — команда ответила бы «domain has no server_id».
    // Спрятать кнопку значило бы оставить вкладку без объяснения, почему копию
    // создать нельзя; включённая — обещала бы работу, которой не будет.
    showListed([backup()], { server_id: null });
    expect(createBtn().hasAttribute("disabled")).toBe(true);
    expect(createBtn().getAttribute("title")).toMatch(/not bound to a server/i);
  });
});

describe("прогон: два клика, отмена и путь", () => {
  it("два клика по кнопке дают ОДНУ команду", async () => {
    // Гейт живёт в `MutationCache`, а не в стейте компонента: `pending`
    // доезжает только к следующему рендеру, и два клика в одном такте успевают
    // случиться раньше него.
    showListed([backup()]);
    fireEvent.click(createBtn());
    fireEvent.click(createBtn());
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Saved to/));
    expect(mocks.invokeSynced.mock.calls.filter((c) => c[0] === "domain_backup_create")).toHaveLength(1);
  });

  it("отмена панели сохранения не оставляет следа: ни «Saved», ни ошибки", async () => {
    mocks.chooseSavePath.mockResolvedValue(null);
    showListed([backup()]);
    fireEvent.click(createBtn());
    await waitFor(() => expect(mocks.chooseSavePath).toHaveBeenCalled());
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    // Ни строки успеха, ни строки ошибки, ни строки прогона вообще: человек
    // ничего не запускал.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Saved to|Backup failed|Cancelled/);
  });

  it("успех печатает путь, который ВЕРНУЛА команда, а не выбранный человеком", async () => {
    // Панель сохранения дописывает расширение, а Rust нормализует путь: строки
    // расходятся, и на экране обязана быть та, по которой файл лежит.
    showListed([backup()]);
    fireEvent.click(createBtn());
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(RETURNED));
    expect(screen.getByRole("status").textContent).not.toContain(`Saved to ${CHOSEN} `);
  });

  it("после успеха сказано, что попало в архив: файлы и сколько баз", async () => {
    // Молчание про базы читается как «всё внутри», а архив без дампа выглядит
    // ровно как архив с дампом — и выясняется это при восстановлении.
    mocks.invokeSynced.mockResolvedValue(
      backupResult({
        parts: [
          { name: "files.tar", kind: "files", sha256: "d1" },
          { name: "db1.sql", kind: "database", sha256: "d2" },
        ],
      }),
    );
    showListed([backup()]);
    fireEvent.click(createBtn());
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Saved to/));
    expect(screen.getByRole("status").textContent).toMatch(/site files \+ 1 database/);
  });

  it("сбой печатается тревогой, а отмена прогона — нет", async () => {
    mocks.invokeSynced.mockRejectedValueOnce(new Error("ssh: handshake failed"));
    showListed([backup()]);
    fireEvent.click(createBtn());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("ssh: handshake failed"));

    cleanup();
    mocks.invokeSynced.mockRejectedValueOnce(new Error("api: BACKUP_CANCELLED"));
    showListed([backup()]);
    fireEvent.click(createBtn());
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Cancelled/));
    // Отмена — не авария: `role="alert"` на неё был бы враньём.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("бэкап удался, а снимок не пересняли — сказано отдельно, и это не ошибка", async () => {
    mocks.invokeSynced.mockResolvedValue(backupResult({ facts_refreshed: false }));
    showListed([backup()]);
    fireEvent.click(createBtn());
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Saved to/));
    expect(screen.getByText(/server snapshot could not be refreshed/i)).toBeTruthy();
    // И ни слова про «список выше»: списка нет и не будет, пока не
    // разблокирована фаза 3 — на его месте пунктирная панель.
    expect(document.body.textContent).not.toMatch(/list of copies above/i);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("оговорка и предупреждения объявляются вместе с успехом, а не остаются немыми", async () => {
    // Живая область накрывает ВЕСЬ исход, а не одну зелёную строку. Оговорка
    // меняет смысл успеха — успех с ней полу-, — и, объяви скринридер только
    // первую строку, он сказал бы «сохранено» там, где зрячий читает «но».
    mocks.invokeSynced.mockResolvedValue(
      backupResult({
        facts_refreshed: false,
        warnings: ["the archive is still on the server at /var/tmp/x.tar — remove it by hand"],
      }),
    );
    showListed([backup()]);
    fireEvent.click(createBtn());
    const status = await waitFor(() => screen.getByRole("status"));
    expect(within(status).getByText(/^Saved to/)).toBeTruthy();
    expect(within(status).getByText(/server snapshot could not be refreshed/i)).toBeTruthy();
    expect(within(status).getByText(/still on the server at/i)).toBeTruthy();
  });
});

describe("строка прогресса", () => {
  /** Довести прогон до состояния «идёт»: команда не отвечает, пока не разрешим. */
  async function startRun() {
    let finish: (v: unknown) => void = () => {};
    mocks.invokeSynced.mockReturnValue(new Promise((r) => (finish = r)));
    showListed([backup()]);
    fireEvent.click(createBtn());
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalled());
    return () => act(async () => finish(backupResult()));
  }

  it("знаменатель неизвестен — полосы нет, есть слова о шаге", async () => {
    // Полоса со знаменателем «на глаз» — тот же принцип №6, что зелёный бейдж
    // вместо «не измеряли». Байты приходят только у выгрузки; у сборки архива
    // на сервере их нет вовсе.
    await startRun();
    await emitProgress({ step: "archive" });
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText(/Building the archive on the server/)).toBeTruthy();

    // И даже у выгрузки: довезённые байты без общего числа полосы не дают.
    await emitProgress({ step: "download", done_bytes: 500 });
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("знаменатель известен — полоса с обоими числами", async () => {
    await startRun();
    await emitProgress({ step: "download", done_bytes: 512, total_bytes: 2048 });
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("512");
    expect(bar.getAttribute("aria-valuemax")).toBe("2048");
    // На слух — тот же формат, что на экране: голые байты на вопрос «сколько
    // осталось» не отвечают.
    expect(bar.getAttribute("aria-valuetext")).toBe("512 B of 2 KB");
  });

  it("живая область — на словах о шаге, и её НЕТ на счётчике байтов", async () => {
    // Оба конца сразу. Счётчик меняется четыре раза в секунду (троттлинг Rust
    // — 250 мс, то есть тысячи событий на гигабайт), и живая область вокруг
    // него превратила бы чтение с экрана в поток цифр, из которого не выудить
    // ни одной новости. Новость — смена шага, она и объявляется.
    await startRun();
    await emitProgress({ step: "download", done_bytes: 512, total_bytes: 2048 });

    const step = screen.getByText("Downloading the archive…");
    expect(step.getAttribute("aria-live")).toBe("polite");

    const counter = screen.getByText("512 B of 2 KB");
    // Спрашиваем не сам элемент, а всех его предков: `aria-live`, поднятый на
    // общую обёртку строки, накрыл бы счётчик ровно так же.
    expect(counter.closest("[aria-live]")).toBeNull();
  });

  it("«Saved» не появляется от события, даже когда довезены ВСЕ байты", async () => {
    // Между последним байтом и файлом на диске стоят sha256, сверка размера и
    // `rename`. Сервер мог доложить последний чанк и упасть на любом из них.
    const finish = await startRun();
    await emitProgress({ step: "download", done_bytes: 2048, total_bytes: 2048 });
    expect(document.body.textContent).not.toMatch(/Saved to/);
    // И только ответ команды рисует успех.
    await finish();
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Saved to/));
  });

  it("прогон переживает закрытие карточки: вернулись — он на месте", async () => {
    // Скачивание идёт минутами, и карточку за это время закрывают. Событие
    // шлётся ПОСЛЕ размонтирования и ДО повторного показа — то есть ровно
    // тогда, когда на экране нет ни одного потребителя. Пришли мы его до
    // `cleanup()`, тест прошёл бы и с подпиской, живущей в эффекте компонента:
    // цифра уже лежала бы в сторе. Здесь же поймать её может только слушатель,
    // переживший размонтирование, — а это и есть проверяемое решение.
    await startRun();
    cleanup();
    await emitProgress({ step: "download", done_bytes: 512, total_bytes: 2048 });
    showListed([backup()]);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("512");
    // И кнопка остаётся погашенной: прогон-то идёт. Признак берётся из
    // `MutationCache`, а не из стейта размонтированного экземпляра, — иначе
    // второй клик по перемонтированной вкладке открыл бы вторую SSH-сессию.
    // На месте кнопки создания стоит отмена — и она рабочая: прогон-то идёт.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel"]);
    expect(cancelBtn().hasAttribute("disabled")).toBe(false);
  });
});

describe("отмена прогона", () => {
  /** Довести прогон до состояния «идёт»: команда не отвечает, пока не разрешим. */
  async function startRun() {
    let finish: (v: unknown) => void = () => {};
    let fail: (e: unknown) => void = () => {};
    mocks.invokeSynced.mockReturnValue(
      new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
    );
    showListed([backup()]);
    fireEvent.click(createBtn());
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalled());
    return {
      finish: () => act(async () => finish(backupResult())),
      // Так отвечает Rust на отменённый прогон: маркером, а не текстом про
      // оборванный поток.
      cancelledByRust: () => act(async () => fail(new Error("api: BACKUP_CANCELLED"))),
    };
  }

  it("во время прогона кнопка ровно одна — и это остановка", async () => {
    // Две кнопки, зовущие в разные стороны, на экране не стоят: «сделай ещё
    // раз» поверх идущей выгрузки бессмысленна, и целиться в неё незачем.
    await startRun();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel"]);
  });

  it("пока висит панель сохранения, отменять нечего — и кнопки отмены нет", async () => {
    // `pending` встаёт раньше прогона: сначала нативная панель, потом
    // синхронизация кэша. Кнопка отмены в это окно отменяла бы то, чего ещё
    // нет ни в сторе, ни в реестре Rust, и клик по ней не оставил бы вообще
    // ничего.
    let pick: (v: unknown) => void = () => {};
    mocks.chooseSavePath.mockReturnValue(new Promise((r) => (pick = r)));
    showListed([backup()]);
    fireEvent.click(createBtn());
    await waitFor(() => expect(mocks.chooseSavePath).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    // Кнопка создания при этом погашена: живая над модальной панелью обещала
    // бы второй прогон.
    expect(createBtn().hasAttribute("disabled")).toBe(true);
    await act(async () => pick(null));
  });

  it("клик зовёт команду отмены с тем же доменом", async () => {
    await startRun();
    fireEvent.click(cancelBtn());
    await waitFor(() => expect(cancelCalls()).toHaveLength(1));
    expect(cancelCalls()[0][1]).toEqual({ domainId: "42" });
  });

  it("два клика дают ОДНУ команду", async () => {
    await startRun();
    fireEvent.click(cancelBtn());
    fireEvent.click(cancelBtn());
    await waitFor(() => expect(cancelCalls().length).toBeGreaterThan(0));
    expect(cancelCalls()).toHaveLength(1);
  });

  it("нажатие видно, пока прогон не кончился", async () => {
    // Команда отмены отвечает мгновенно, а прогон останавливается через
    // десятки секунд. Не покажи мы этого — человек решит, что не сработало, и
    // будет жать снова.
    await startRun();
    fireEvent.click(cancelBtn());
    const cancelling = await screen.findByRole("button", { name: "Cancelling…" });
    expect(cancelling.hasAttribute("disabled")).toBe(true);
  });

  it("итог отменённого прогона — «Cancelled», а не «Backup failed»", async () => {
    const { cancelledByRust } = await startRun();
    fireEvent.click(cancelBtn());
    await screen.findByRole("button", { name: "Cancelling…" });
    await cancelledByRust();
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Cancelled/));
    // Отмена — не авария: `role="alert"` на неё был бы враньём.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Backup failed/);
    // И кнопка вернулась к покою: прогона больше нет.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Create backup"]);
  });

  it("архив, оставшийся на сервере, назван и при отмене — иначе экран врёт", async () => {
    // На пути отмены `warnings` не возвращаются вовсе (команда отдаёт `Err`), и
    // событие `remote_cleanup_failed` — ЕДИНСТВЕННЫЙ канал этой вести. Заглуши
    // его, и экран напечатает «Cancelled — no copy was saved» над
    // многогигабайтным тарболлом, лежащим в `/var/tmp` продакшна, — а подсказка
    // кнопки рядом ещё и обещала бы, что его убрали.
    const note =
      "the archive is still on the server at /var/tmp/sdmp-backup/example.com-2026.tar (rm exited 1) — remove it by hand";
    const { cancelledByRust } = await startRun();
    fireEvent.click(cancelBtn());
    await screen.findByRole("button", { name: "Cancelling…" });
    await emitProgress({ step: "remote_cleanup_failed", note });
    await cancelledByRust();

    const status = await waitFor(() => screen.getByRole("status"));
    expect(within(status).getByText(/Cancelled/)).toBeTruthy();
    // Весть — в той же живой области, что и слово «Cancelled»: она меняет его
    // смысл, и объявиться обязана вместе с ним.
    expect(within(status).getByText(/still on the server at/i)).toBeTruthy();
  });

  it("подсказка кнопки не обещает сноса серверного архива безусловно", async () => {
    // Уборка на сервере — попытка: сессия после отмены могла уже развалиться, и
    // тогда архив останется лежать (о чём скажет строка выше). Безусловное «are
    // removed» врало бы ровно в тех отменах, где всё и пошло не так.
    await startRun();
    const title = cancelBtn().getAttribute("title") ?? "";
    expect(title).toMatch(/tries to remove/i);
    expect(title).not.toMatch(/archive are removed/i);
  });

  it("отбитая просьба возвращает кнопку в рабочее состояние, а прогон продолжается", async () => {
    mocks.invokeIfTauri.mockRejectedValue(new Error("command not found"));
    const { finish } = await startRun();
    fireEvent.click(cancelBtn());
    // «Cancelling…», которое ничего не отменило, — то же враньё, что зелёный
    // бейдж без измерения: кнопка обязана снова стать нажимаемой.
    await waitFor(() => expect(cancelBtn().hasAttribute("disabled")).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
    // Прогон живой и доходит до своего исхода сам.
    await finish();
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Saved to/));
  });
});

describe("домен без сервера", () => {
  it("своя фраза — читать копии не с чего, и создать их тоже нечем", () => {
    show({ server_id: null });
    expect(screen.getByText(/not bound to a server/)).toBeTruthy();
    // И это не «копий нет»: сервера у домена нет, а не копий на сервере.
    expect(document.body.textContent).not.toMatch(/no backup copies/i);
    // Кнопка на месте, но выключена: без сервера архив собирать не с чего (то
    // же правило проверяется выше, здесь оно замыкает разбор состояния).
    expect(createBtn().hasAttribute("disabled")).toBe(true);
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

  it("и ни слова о том, что создать копию нельзя: теперь можно", () => {
    // Фраза «Making a backup from here is not available yet» стояла здесь ровно
    // до кнопки. Оставить её рядом с работающей кнопкой — соврать в другую
    // сторону, поэтому её отсутствие тоже под тестом.
    showListed([backup()]);
    expect(document.body.textContent).not.toMatch(/not available yet/i);
  });
});
