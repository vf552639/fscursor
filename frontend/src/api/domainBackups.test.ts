import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Прогон создания резервной копии: гейт, панель сохранения и три правила «не
 * соврать».
 *
 * Проверяется здесь то, чего не видно с экрана: сколько раз прогон зовёт
 * команду при двух кликах, что остаётся в сторе после отказа от панели
 * сохранения и ЧЕЙ путь попадает в результат — выбранный человеком или
 * возвращённый командой. Ошибиться в любом из трёх мест можно так, что UI
 * останется зелёным и будет уверенно врать.
 */

const mocks = vi.hoisted(() => ({
  invokeSynced: vi.fn(),
  invokeIfTauri: vi.fn(),
  chooseSavePath: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

/**
 * Отмена идёт мимо `invokeSynced` намеренно, и мок здесь ВТОРОЙ именно поэтому:
 * синхронизация кэша перед просьбой остановиться — круг в сеть ровно там, где
 * от вызова требуется быстрота, а резолвить отмене нечего (она смотрит только в
 * реестр прогонов). Два разных мока держат это правило под тестом.
 */
vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

vi.mock("../lib/chooseSavePath", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  chooseSavePath: mocks.chooseSavePath,
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  BACKUP_CANCELLED,
  runCancelDomainBackup,
  runCreateDomainBackup,
  type DomainBackupResult,
} from "./domainBackups";
import { queryClient } from "./queryClient";
import { useAuthStore } from "../store/auth";
import { useBackupRunsStore } from "../store/backupRuns";

const DOMAIN = { id: 42, domain_name: "example.com" };

/** Путь, который выбрал человек, и путь, который вернула команда, — РАЗНЫЕ. */
const CHOSEN = "/Users/me/Documents/example.com";
const RETURNED = "/Users/me/Documents/example.com-20260819T103000Z.tar";

function result(over: Partial<DomainBackupResult> = {}): DomainBackupResult {
  return {
    file_name: "example.com-20260819T103000Z.tar",
    path: RETURNED,
    bytes: 2048,
    sha256: "abc",
    parts: [{ name: "files.tar", kind: "files", sha256: "d1" }],
    warnings: [],
    duration_ms: 1234,
    facts_refreshed: true,
    ...over,
  };
}

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

const run = () => useBackupRunsStore.getState().runs["42"];
const createCalls = () => mocks.invokeSynced.mock.calls.filter((c: unknown[]) => c[0] === "domain_backup_create");

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listen.mockResolvedValue(() => {});
  mocks.chooseSavePath.mockResolvedValue(CHOSEN);
  mocks.invokeIfTauri.mockResolvedValue(true);
  queryClient.clear();
  useBackupRunsStore.setState({ runs: {} });
  setTauri(true);
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
});

afterEach(() => {
  setTauri(false);
  queryClient.clear();
  useBackupRunsStore.setState({ runs: {} });
  useAuthStore.getState().clear();
});

describe("гейт «один прогон за раз»", () => {
  it("два клика подряд дают ОДНУ команду", async () => {
    // Прогон занимает сервер на часы и пишет гигабайты; второй такой же поверх
    // первого — это вторая SSH-сессия к тому же домену и второй `tar` на живом
    // продакшне. Заявка гейта встаёт синхронно, поэтому второй вызов в том же
    // такте её уже видит.
    mocks.invokeSynced.mockResolvedValue(result());
    await Promise.all([runCreateDomainBackup(DOMAIN), runCreateDomainBackup(DOMAIN)]);
    expect(createCalls()).toHaveLength(1);
  });

  it("и одну панель сохранения — вторая не открывается поверх первой", async () => {
    // Панель спрашивается ВНУТРИ гейта. Спроси мы до него — человек дважды
    // выбирал бы путь, а работа всё равно шла бы одна.
    mocks.invokeSynced.mockResolvedValue(result());
    await Promise.all([runCreateDomainBackup(DOMAIN), runCreateDomainBackup(DOMAIN)]);
    expect(mocks.chooseSavePath).toHaveBeenCalledTimes(1);
  });

  it("после конца прогона следующий запускается", async () => {
    mocks.invokeSynced.mockResolvedValue(result());
    await runCreateDomainBackup(DOMAIN);
    await runCreateDomainBackup(DOMAIN);
    expect(createCalls()).toHaveLength(2);
  });
});

describe("отмена панели сохранения не оставляет следа", () => {
  it("ни команды, ни записи о прогоне", async () => {
    // Человек ничего не запускал. Ни «отменено», ни ошибки, ни пустой строки
    // прогона — след означал бы, что что-то происходило.
    mocks.chooseSavePath.mockResolvedValue(null);
    await runCreateDomainBackup(DOMAIN);
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    expect(run()).toBeUndefined();
  });

  it("и не запирает кнопку: следующая попытка проходит", async () => {
    mocks.chooseSavePath.mockResolvedValueOnce(null).mockResolvedValueOnce(CHOSEN);
    mocks.invokeSynced.mockResolvedValue(result());
    await runCreateDomainBackup(DOMAIN);
    await runCreateDomainBackup(DOMAIN);
    expect(createCalls()).toHaveLength(1);
  });
});

describe("успех", () => {
  it("печатается путь, который ВЕРНУЛА команда, а не тот, что выбрал человек", async () => {
    // Панель сохранения дописывает расширение, а Rust ещё и нормализует путь:
    // строки расходятся, и показать надо ту, по которой файл действительно
    // лежит.
    mocks.invokeSynced.mockResolvedValue(result());
    await runCreateDomainBackup(DOMAIN);
    expect(run().outcome).toEqual({
      kind: "saved",
      saved: {
        path: RETURNED,
        fileName: "example.com-20260819T103000Z.tar",
        bytes: 2048,
        warnings: [],
        factsRefreshed: true,
      },
    });
    expect(run().outcome).not.toMatchObject({ saved: { path: CHOSEN } });
  });

  it("команда зовётся с id домена строкой и выбранным путём", async () => {
    mocks.invokeSynced.mockResolvedValue(result());
    await runCreateDomainBackup(DOMAIN);
    expect(createCalls()[0][1]).toEqual({
      userId: "user-1",
      domainId: "42",
      destPath: CHOSEN,
    });
  });

  it("провал пересъёмки фактов не превращается в провал бэкапа", async () => {
    // Архив на диске, снимок старый. Это полууспех, и он обязан доехать до
    // экрана отдельным признаком, а не красной ошибкой и не тишиной.
    mocks.invokeSynced.mockResolvedValue(result({ facts_refreshed: false }));
    await runCreateDomainBackup(DOMAIN);
    expect(run().outcome).toMatchObject({ kind: "saved", saved: { factsRefreshed: false } });
  });

  it("список домена перетягивается: успех обязан стать виден", async () => {
    // Бэкап пересъёмывает снимок и пишет его на сервер write-back'ом — без
    // инвалидации вкладка осталась бы со списком копий «до».
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    mocks.invokeSynced.mockResolvedValue(result());
    await runCreateDomainBackup(DOMAIN);
    expect(spy.mock.calls.map((c) => (c[0] as any)?.queryKey)).toContainEqual(["domains"]);
    spy.mockRestore();
  });
});

describe("неуспех", () => {
  it("отмена прогона — свой исход, а не красная ошибка", async () => {
    // Маркер приезжает внутри текста `CommandError`, поэтому проверяется
    // вхождение, а не равенство: `formatInvokeError` собирает «api: …».
    mocks.invokeSynced.mockRejectedValue(new Error(`api: ${BACKUP_CANCELLED}`));
    await runCreateDomainBackup(DOMAIN);
    expect(run().outcome).toEqual({ kind: "cancelled" });
  });

  it("маркер посреди чужого текста отменой НЕ считается", async () => {
    // В тексте сбоя выгрузки едет путь на сервере. Файл или каталог с таким
    // именем при разборе «содержит маркер» превратил бы аварию в тихое
    // «отменено» — то есть спрятал бы провал. `Display` ставит маркер
    // последним, так что строгость ничего не теряет.
    mocks.invokeSynced.mockRejectedValue(
      new Error(`ssh: the archive is still at /var/tmp/${BACKUP_CANCELLED}/site.tar — remove it`),
    );
    await runCreateDomainBackup(DOMAIN);
    expect(run().outcome).toMatchObject({ kind: "failed" });
  });

  it("сбой доезжает текстом, а не молчанием", async () => {
    mocks.invokeSynced.mockRejectedValue(new Error("ssh: handshake failed"));
    await runCreateDomainBackup(DOMAIN);
    expect(run().outcome).toEqual({ kind: "failed", error: "ssh: handshake failed" });
  });

  it("и всё равно перетягивает домен: пересъёмка могла пройти до сбоя", async () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    mocks.invokeSynced.mockRejectedValue(new Error("ssh: handshake failed"));
    await runCreateDomainBackup(DOMAIN);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("запертый сейф — строка на экране, а панель сохранения даже не открывается", async () => {
    useAuthStore.getState().clear();
    await runCreateDomainBackup(DOMAIN);
    expect(mocks.chooseSavePath).not.toHaveBeenCalled();
    expect(run().outcome).toMatchObject({ kind: "failed" });
  });
});

describe("отмена прогона", () => {
  const cancelCalls = () =>
    mocks.invokeIfTauri.mock.calls.filter((c: unknown[]) => c[0] === "domain_backup_cancel");

  it("зовёт команду с тем же доменом и отмечает просьбу на экране", async () => {
    useBackupRunsStore.getState().start(42);
    await runCancelDomainBackup(42);
    expect(cancelCalls()).toHaveLength(1);
    expect(cancelCalls()[0][1]).toEqual({ domainId: "42" });
    // Реакция придёт через десятки секунд — всё это время нажатие обязано быть
    // видно.
    expect(run().cancelRequested).toBe(true);
  });

  it("два клика подряд дают ОДНУ команду", async () => {
    useBackupRunsStore.getState().start(42);
    await Promise.all([runCancelDomainBackup(42), runCancelDomainBackup(42)]);
    expect(cancelCalls()).toHaveLength(1);
  });

  it("не идёт через синхронизацию кэша: резолвить ей нечего, а ждать некогда", async () => {
    useBackupRunsStore.getState().start(42);
    await runCancelDomainBackup(42);
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
  });

  it("«такого прогона нет» тоже снимает признак: нажатие ушло в пустоту", async () => {
    // Между нашим `start()` и `runs.start()` в Rust лежит синхронизация кэша,
    // то есть поход в сеть, и всё это время кнопка отмены на экране уже живая.
    // Нажатие в это окно отменять нечего — Rust о прогоне ещё не знает, — и
    // ответ `false` единственное, чем он может это сказать. Промолчи мы, и
    // человек смотрел бы на «Cancelling…» десятки минут, чтобы получить
    // «Saved».
    mocks.invokeIfTauri.mockResolvedValue(false);
    useBackupRunsStore.getState().start(42);
    await runCancelDomainBackup(42);
    expect(run().cancelRequested).toBe(false);
    expect(run().outcome).toBeNull();
  });

  it("отбитая просьба не хоронит живой прогон, но и не врёт, что отменила", async () => {
    mocks.invokeIfTauri.mockRejectedValue(new Error("command not found"));
    useBackupRunsStore.getState().start(42);
    await runCancelDomainBackup(42);
    expect(run().cancelRequested).toBe(false);
    // Прогон-то идёт: красная строка на его месте объявила бы мёртвым живого.
    expect(run().outcome).toBeNull();
  });

  it("нажатая отмена доводит прогон до исхода «отменён», а не «провален»", async () => {
    // Полный путь: человек жмёт отмену, Rust отвечает прогону маркером.
    mocks.invokeSynced.mockRejectedValue(new Error(`api: ${BACKUP_CANCELLED}`));
    const running = runCreateDomainBackup(DOMAIN);
    await runCancelDomainBackup(42);
    await running;
    expect(run().outcome).toEqual({ kind: "cancelled" });
    // И признак просьбы снят вместе с исходом.
    expect(run().cancelRequested).toBe(false);
  });

  it("в вебе не зовёт ничего", async () => {
    setTauri(false);
    await runCancelDomainBackup(42);
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });
});

describe("веб", () => {
  it("не зовёт ни панель, ни команду — веб только смотрит", async () => {
    // Кнопки в вебе нет вовсе (это проверяет тест вкладки), но прогон обязан
    // отказать и сам: он экспортирован модулем и звать его может кто угодно.
    setTauri(false);
    await runCreateDomainBackup(DOMAIN);
    expect(mocks.chooseSavePath).not.toHaveBeenCalled();
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    expect(run()).toBeUndefined();
  });
});
