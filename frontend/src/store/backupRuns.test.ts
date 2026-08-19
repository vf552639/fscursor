import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Стор прогона бэкапа — место, где живут два правила «не соврать» из плана и
 * подписка на события.
 *
 * Правило первое и главное: **«Saved» не может появиться из события прогресса**
 * — ни при каком его содержимом, включая `done === total`. Соблазн ровный:
 * последний чанк доложен, значит файл на месте. Не значит: после последнего
 * байта Rust ещё считает sha256, сверяет размер и переименовывает `.part` — и
 * любой из этих шагов может не сойтись, а файла с правильным именем не
 * появится вовсе. Успех выставляет только ответ команды.
 *
 * Правило второе: событие, опоздавшее к финишу, ничего не воскрешает. Доставка
 * событий асинхронна, и последнее из них вполне доезжает ПОСЛЕ ответа команды.
 *
 * Подписка проверяется на единственность: событие Tauri получают все слушатели
 * окна, поэтому вторая подписка — это не «лишний слушатель», а тот же байт,
 * посчитанный дважды.
 */

const mocks = vi.hoisted(() => ({ listen: vi.fn() }));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  BACKUP_PROGRESS_EVENT,
  ensureBackupProgressSubscription,
  useBackupRunsStore,
  type BackupProgressPayload,
} from "./backupRuns";

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

const store = () => useBackupRunsStore.getState();
const run = (id: number | string) => useBackupRunsStore.getState().runs[String(id)];

function progress(over: Partial<BackupProgressPayload> = {}) {
  store().progress({ domain_id: "42", step: "download", ...over });
}

const SAVED = {
  path: "/Users/me/Documents/example.com.tar",
  fileName: "example.com-20260819T103000Z.tar",
  bytes: 2048,
  warnings: [],
  factsRefreshed: true,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listen.mockResolvedValue(() => {});
  useBackupRunsStore.setState({ runs: {} });
});

afterEach(() => {
  setTauri(false);
  useBackupRunsStore.setState({ runs: {} });
});

describe("события прогресса", () => {
  it("не выставляют успех НИКОГДА — даже когда довезены все байты", () => {
    // Ровно та поломка, ради которой написан тест: «done === total, значит
    // сохранено». Между последним байтом и файлом на диске стоят sha256,
    // сверка размера и `rename`, и любой из них может не сойтись.
    store().start(42);
    progress({ done_bytes: 1000, total_bytes: 1000 });
    expect(run(42).outcome).toBeNull();
    expect(run(42).doneBytes).toBe(1000);
  });

  it("не заводят прогон, которого никто не запускал", () => {
    // Строку на экране заводит запуск, а не провод: показать прогон, об исходе
    // которого этот экран ничего не узнает, значит оставить его крутиться
    // навсегда.
    progress({ done_bytes: 10, total_bytes: 100 });
    expect(run(42)).toBeUndefined();
  });

  it("не воскрешают уже кончившийся прогон", () => {
    store().start(42);
    store().saved(42, SAVED);
    progress({ done_bytes: 1, total_bytes: 100 });
    expect(run(42).outcome).toEqual({ kind: "saved", saved: SAVED });
    // И шаг с байтами не вернулись: рядом со словом «Saved» полосы быть не
    // должно вовсе.
    expect(run(42).step).toBeNull();
    expect(run(42).doneBytes).toBeNull();
  });

  it("шаг без байтов гасит знаменатель, а не оставляет прошлый", () => {
    // Байты приходят только у выгрузки. Останься `total` от неё на уборке —
    // полоса рисовалась бы под шагом, у которого измерения нет вовсе.
    store().start(42);
    progress({ done_bytes: 500, total_bytes: 1000 });
    progress({ step: "remote_cleanup" });
    expect(run(42).step).toBe("remote_cleanup");
    expect(run(42).doneBytes).toBeNull();
    expect(run(42).totalBytes).toBeNull();
  });

  it("выгрузка без знаменателя оставляет знаменатель пустым, а не выдумывает его", () => {
    store().start(42);
    progress({ done_bytes: 500 });
    expect(run(42).doneBytes).toBe(500);
    expect(run(42).totalBytes).toBeNull();
  });

  it("мусор вместо чисел — то же самое незнание, а не ноль", () => {
    store().start(42);
    progress({ done_bytes: "много" as unknown as number, total_bytes: Number.NaN });
    expect(run(42).doneBytes).toBeNull();
    expect(run(42).totalBytes).toBeNull();
  });

  it("незнакомый шаг выбрасывается молча, прежний остаётся на экране", () => {
    store().start(42);
    progress({ step: "archive" });
    progress({ step: "телепортация" });
    expect(run(42).step).toBe("archive");
  });

  it("`facts_failed` — не шаг: об этом говорит ответ команды, а не событие", () => {
    // Провал пересъёмки приезжает полем `facts_refreshed`, и верить событию в
    // этом вопросе нельзя по той же причине, что и в вопросе «сохранено»:
    // команда после него ещё может упасть.
    store().start(42);
    progress({ step: "facts" });
    progress({ step: "facts_failed" });
    expect(run(42).step).toBe("facts");
  });

  it("прогон одного домена не трогает соседний", () => {
    store().start(42);
    store().start(7);
    progress({ domain_id: "42", step: "archive" });
    expect(run(7).step).toBeNull();
  });
});

describe("исходы", () => {
  it("новый запуск стирает прошлый исход: он уже не про сейчас", () => {
    store().start(42);
    store().failed(42, "ssh: handshake failed");
    store().start(42);
    expect(run(42).outcome).toBeNull();
  });

  it("отмена — свой исход, а не ошибка", () => {
    store().start(42);
    store().cancelled(42);
    expect(run(42).outcome).toEqual({ kind: "cancelled" });
  });
});

describe("просьба об отмене", () => {
  it("остаётся видна, пока прогон не кончился", () => {
    // Команда отмены отвечает мгновенно, а реакция приходит через десятки
    // секунд — флаг читается на следующем чанке выгрузки. Всё это время экран
    // обязан показывать, что нажатие услышано, иначе человек жмёт снова.
    store().start(42);
    store().requestCancel(42);
    expect(run(42).cancelRequested).toBe(true);
    // И события прогресса её не стирают: прогон ещё идёт, отмена ещё в силе.
    progress({ step: "download", done_bytes: 10, total_bytes: 100 });
    expect(run(42).cancelRequested).toBe(true);
  });

  it("снимается вместе с исходом — любым", () => {
    for (const finish of [
      () => store().cancelled(42),
      () => store().failed(42, "ssh: handshake failed"),
      () => store().saved(42, SAVED),
    ]) {
      store().start(42);
      store().requestCancel(42);
      finish();
      expect(run(42).cancelRequested).toBe(false);
    }
  });

  it("не ставится там, где отменять нечего", () => {
    // Прогона нет вовсе.
    store().requestCancel(42);
    expect(run(42)).toBeUndefined();
    // Прогон кончился: «Cancelling…» над законченным прогоном не сменится
    // никогда, потому что менять его уже некому.
    store().start(7);
    store().saved(7, SAVED);
    store().requestCancel(7);
    expect(run(7).cancelRequested).toBe(false);
  });

  it("отбитая просьба снимает признак: кнопка обязана стать нажимаемой", () => {
    // «Cancelling…», которое ничего не отменило, — то же враньё, что зелёный
    // бейдж без измерения.
    store().start(42);
    store().requestCancel(42);
    store().cancelRequestFailed(42);
    expect(run(42).cancelRequested).toBe(false);
    // И прогон при этом остаётся живым: провал ПРОСЬБЫ — не провал бэкапа.
    expect(run(42).outcome).toBeNull();
  });
});

describe("подписка на backup:progress", () => {
  /**
   * Оба утверждения — одним тестом, и это не лень: подписка memoized модульно, а
   * `vi.resetAllMocks` в `beforeEach` стирает счётчик вызовов. Разложи их по
   * двум тестам — и второй увидел бы ноль вызовов `listen` (первый уже занял
   * подписку) либо начал бы зависеть от порядка. Модульного сброса ради теста
   * заводить не стали: он существовал бы только для теста и врал бы про то, что
   * подписка снимаема.
   */
  it("одна на всё приложение — и события через неё доезжают до стора", async () => {
    setTauri(true);
    await ensureBackupProgressSubscription();
    await ensureBackupProgressSubscription();
    await ensureBackupProgressSubscription();
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    expect(mocks.listen.mock.calls[0][0]).toBe(BACKUP_PROGRESS_EVENT);

    const handler = mocks.listen.mock.calls[0][1] as (e: { payload: BackupProgressPayload }) => void;
    store().start(42);
    handler({ payload: { domain_id: "42", step: "download", done_bytes: 7, total_bytes: 9 } });
    expect(run(42)).toMatchObject({ step: "download", doneBytes: 7, totalBytes: 9 });
  });
});
