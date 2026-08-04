import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

import {
  useSecretSave,
  useMultiSecretSave,
  resetSecretSaveGuardForTests,
  type SecretSave,
} from "./useSecretSave";
import { BLOB_KIND } from "../lib/secretBlob";

/**
 * Хук держит инвариант «блоб записан → и только потом сущность» и момент
 * стирания плейнтекста. Провал здесь выглядит как успех: форма закрывается,
 * пользователь уверен, что секрет сохранён, а в БД ссылки нет. Поэтому тесты
 * смотрят порядок вызовов и что `persist` НЕ позван, а не только флаги.
 */

const mocks = vi.hoisted(() => ({ putSecretBlob: vi.fn(), deleteSecretBlob: vi.fn() }));

// `BLOB_KIND` берём настоящий: литералы видов уезжают в БД, подменять их
// фикстурой — учить тест значениям, которых в проде нет.
vi.mock("../lib/secretBlob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/secretBlob")>()),
  putSecretBlob: mocks.putSecretBlob,
  deleteSecretBlob: mocks.deleteSecretBlob,
}));

const LABELS = { apiKey: "API key", apiSecret: "API secret" };
const TARGETS = {
  apiKey: { blobKind: BLOB_KIND.registrarApiKey, existingBlobId: null },
  apiSecret: { blobKind: BLOB_KIND.registrarApiSecret, existingBlobId: null },
};

/** Единая лента событий: только по ней видно, что было ДО чего. */
let trace: string[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  trace = [];
  // Флаг гварда — модульный: `cleanup()` его не трогает, и подтёкший он упал бы
  // в следующем тесте сообщением про вложенность, которой там нет.
  resetSecretSaveGuardForTests();
  mocks.putSecretBlob.mockImplementation(async (a: { blobKind: string }) => {
    trace.push(`blob:${a.blobKind}`);
    return `id-${a.blobKind}`;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderRegistrar() {
  const { result } = renderHook(() => useMultiSecretSave(LABELS));
  act(() => {
    result.current.setValue("apiKey", "k3y");
    result.current.setValue("apiSecret", "s3cr3t");
  });
  return result;
}

describe("useMultiSecretSave.saveAll", () => {
  it("пишет все блобы до persist и отдаёт ему id по ключам полей", async () => {
    const result = renderRegistrar();
    const persist = vi.fn(async () => {
      trace.push("persist");
    });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.saveAll({ secrets: TARGETS, persist });
    });

    expect(ok).toBe(true);
    expect(trace).toEqual(["blob:registrar_api_key", "blob:registrar_api_secret", "persist"]);
    expect(persist).toHaveBeenCalledWith({
      apiKey: "id-registrar_api_key",
      apiSecret: "id-registrar_api_secret",
    });
    // Плейнтексты стираем только на успехе — здесь он есть.
    expect(result.current.values).toEqual({ apiKey: "", apiSecret: "" });
    expect(result.current.error).toBeNull();
    expect(result.current.saving).toBe(false);
  });

  it("упала вторая запись — persist не зовём и первый блоб не откатываем", async () => {
    // Ровно тот сценарий, ради которого saveAll и заведён: вложенные `save`
    // здесь сохранили бы аккаунт со ссылкой на несуществующий api_secret.
    // Откат первого блоба через deleteSecretBlob запрещён (JSDoc putSecretBlob):
    // на правке он снёс бы живой секрет, на который ещё указывает сущность.
    const result = renderRegistrar();
    mocks.putSecretBlob
      .mockImplementationOnce(async () => {
        trace.push("blob:registrar_api_key");
        return "id-registrar_api_key";
      })
      .mockRejectedValueOnce(new Error("keychain locked"));
    const persist = vi.fn(async () => {
      trace.push("persist");
    });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.saveAll({ secrets: TARGETS, persist });
    });

    expect(ok).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(mocks.deleteSecretBlob).not.toHaveBeenCalled();
    expect(trace).toEqual(["blob:registrar_api_key"]);
    // Ошибка одна и та самая: saveAll её НЕ пробрасывает наружу (иначе форма
    // показала бы вторую копию из своего catch) и не склеивает две.
    expect(result.current.error).toBe("keychain locked");
    // Плейнтексты остались — повторить сохранение можно, не набирая заново.
    expect(result.current.values).toEqual({ apiKey: "k3y", apiSecret: "s3cr3t" });
  });

  it("упал persist — плейнтексты остаются, блобы не откатываются", async () => {
    const result = renderRegistrar();
    const persist = vi.fn(async () => {
      throw new Error("409 conflict");
    });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.saveAll({ secrets: TARGETS, persist });
    });

    expect(ok).toBe(false);
    expect(mocks.deleteSecretBlob).not.toHaveBeenCalled();
    expect(result.current.error).toBe("409 conflict");
    expect(result.current.values).toEqual({ apiKey: "k3y", apiSecret: "s3cr3t" });
  });

  it("пустое поле останавливает всё до первой записи и называет себя", async () => {
    // Иначе в хранилище оседал бы блоб из нуля байт под первое поле, а форма
    // при этом честно показывала бы ошибку по второму.
    const { result } = renderHook(() => useMultiSecretSave(LABELS));
    act(() => result.current.setValue("apiKey", "k3y"));
    const persist = vi.fn(async () => {});

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.saveAll({ secrets: TARGETS, persist });
    });

    expect(ok).toBe(false);
    expect(mocks.putSecretBlob).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(result.current.error).toBe("API secret is required");
  });

  it("пустые оба — названы оба, а не первое по кругу", async () => {
    const { result } = renderHook(() => useMultiSecretSave(LABELS));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.saveAll({ secrets: TARGETS, persist: async () => {} });
    });

    expect(ok).toBe(false);
    expect(result.current.error).toBe("API key and API secret are required");
  });

  it("нетронутое поле не пишется и не едет в persist", async () => {
    // Форма правки: «оставь пустым — оставим текущий секрет». Без этого правка
    // имени аккаунта требовала бы перенабрать API-токен, а автор формы пошёл бы
    // в обход хука — мимо дисциплины стирания плейнтекста.
    const result = renderRegistrar();
    act(() => result.current.setValue("apiSecret", ""));
    const persist = vi.fn(async () => {
      trace.push("persist");
    });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.saveAll({
        secrets: { apiKey: TARGETS.apiKey, apiSecret: undefined },
        persist,
      });
    });

    expect(ok).toBe(true);
    expect(trace).toEqual(["blob:registrar_api_key", "persist"]);
    expect(persist).toHaveBeenCalledWith({ apiKey: "id-registrar_api_key" });
  });

  it("заявленное, но пустое поле — это ошибка, а не «не меняем»", async () => {
    // Обратная половина того же контракта: ключ в `secrets` значит «этот секрет
    // перезаписываем». Пустить сюда пустую строку — записать блоб из нуля байт.
    const result = renderRegistrar();
    act(() => result.current.setValue("apiSecret", ""));
    const persist = vi.fn(async () => {});

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.saveAll({ secrets: TARGETS, persist });
    });

    expect(ok).toBe(false);
    expect(mocks.putSecretBlob).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(result.current.error).toBe("API secret is required");
  });

  it("setValue гасит прошлую ошибку", async () => {
    // Без этого красный блок висит над полем, пока пользователь перенабирает
    // пароль, и снимается только следующим сохранением: текст противоречит
    // тому, что человек прямо сейчас делает.
    const result = renderRegistrar();
    mocks.putSecretBlob.mockRejectedValue(new Error("keychain locked"));
    await act(async () => {
      await result.current.saveAll({ secrets: TARGETS, persist: async () => {} });
    });
    expect(result.current.error).toBe("keychain locked");

    act(() => result.current.setValue("apiSecret", "s3cr3t-2"));

    expect(result.current.error).toBeNull();
  });
});

describe("useSecretSave", () => {
  it("сохраняет один секрет и стирает плейнтекст только на успехе", async () => {
    const { result } = renderHook(() => useSecretSave("SSH password"));
    act(() => result.current.setValue("p@ss"));
    const persist = vi.fn(async () => {
      trace.push("persist");
    });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.save({
        blobKind: BLOB_KIND.serverSshPassword,
        existingBlobId: null,
        persist,
      });
    });

    expect(ok).toBe(true);
    expect(trace).toEqual(["blob:server_ssh_password", "persist"]);
    expect(persist).toHaveBeenCalledWith("id-server_ssh_password");
    expect(result.current.value).toBe("");
  });

  it("пустой плейнтекст: ни записи, ни сущности", async () => {
    const { result } = renderHook(() => useSecretSave("SSH password"));
    const persist = vi.fn(async () => {});

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.save({
        blobKind: BLOB_KIND.serverSshPassword,
        existingBlobId: null,
        persist,
      });
    });

    expect(ok).toBe(false);
    expect(mocks.putSecretBlob).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(result.current.error).toBe("SSH password is required");
  });

  it("setValue гасит прошлую ошибку", async () => {
    const { result } = renderHook(() => useSecretSave("SSH password"));
    await act(async () => {
      await result.current.save({
        blobKind: BLOB_KIND.serverSshPassword,
        existingBlobId: null,
        persist: async () => {},
      });
    });
    expect(result.current.error).toBe("SSH password is required");

    act(() => result.current.setValue("p"));

    expect(result.current.error).toBeNull();
  });

  it("компилятор не пускает короткую стрелку с вложенным save", async () => {
    // Проверку делает `tsc --noEmit`: ослабнет `persist` обратно до
    // `Promise<unknown>` — директива станет неиспользованной (TS2578) и сборка
    // упадёт. Дыра была реальной и тихой: внутренний `save` на ошибке
    // возвращает `false`, а не бросает, поэтому внешний видел успешный промис,
    // стирал свой плейнтекст и закрывал форму, не сохранив ничего.
    //
    // Тип закрывает ТОЛЬКО эту запись; блочное тело и брошенный промис
    // компилируются — их ловит рантайм-гвард, см. блок ниже.
    const { result } = renderHook(() => useSecretSave("API key"));
    const inner = result.current;
    const args: Parameters<SecretSave["save"]>[0] = {
      blobKind: BLOB_KIND.registrarApiKey,
      existingBlobId: null,
      // @ts-expect-error — вложенный save() отдаёт Promise<boolean>, а persist ждёт Promise<void>.
      persist: (blobId: string) =>
        inner.save({
          blobKind: BLOB_KIND.registrarApiSecret,
          existingBlobId: blobId,
          persist: async () => {},
        }),
    };
    expect(typeof args.persist).toBe("function");
  });
});

/**
 * Всё, что типом не выражается. `async (id) => { … }` возвращает
 * `Promise<void>` независимо от содержимого, поэтому четыре записи ниже
 * компилируются — и каждая даёт тот же тихий провал: внутренний `save` отдаёт
 * `false` вместо броска, внешний рапортует успех, второй секрет не записан.
 * Подстраховки от линтера нет: eslint во фронте отсутствует, `no-floating-
 * promises` не сработает. Ловит только рантайм-гвард на переиспользование.
 */
describe("гвард на вложенный save", () => {
  function nesting() {
    const outer = renderHook(() => useSecretSave("API key")).result;
    const inner = renderHook(() => useSecretSave("API secret")).result;
    act(() => {
      outer.current.setValue("k3y");
      inner.current.setValue("s3cr3t");
    });
    const nested = () =>
      inner.current.save({
        blobKind: BLOB_KIND.registrarApiSecret,
        existingBlobId: null,
        persist: async () => {},
      });
    return { outer, inner, nested };
  }

  // Сам вызов лежит в таблице, а не выбирается сравнением с именем строки:
  // иначе переименование случая молча уронило бы его в `else`, продублировав
  // соседний, — и грид, объявленный главной защитой, тихо потерял бы ветку.
  // Первая запись — ровно та, которую JSDoc `persist` советует как лечение от
  // ошибки компиляции: человек применит её и вернётся в баг.
  type Nested = () => Promise<boolean>;
  it.each<[string, (nested: Nested) => Promise<void>]>([
    ["блочное тело с await", async (nested) => {
      await nested();
    }],
    ["брошенный промис", async (nested) => {
      nested();
    }],
    ["void", async (nested) => void nested()],
    [".then(() => {})", async (nested) => nested().then(() => {})],
  ])("%s: внешний save падает, а не рапортует успех", async (_form, persist) => {
    const { outer, inner, nested } = nesting();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    let ok: boolean | undefined;
    await act(async () => {
      ok = await outer.current.save({
        blobKind: BLOB_KIND.registrarApiKey,
        existingBlobId: null,
        persist: () => persist(nested),
      });
    });

    expect(ok).toBe(false);
    expect(outer.current.error).toMatch(/do not call save\(\) inside persist\(\)/);
    // И у заблокированной формы тоже: сработай гвард вне вложенности, только её
    // `error` и увидел бы автор — у внешней формы его ставит `catch` в `run`.
    expect(inner.current.error).toMatch(/nested secret save/);
    // Ещё и в консоль: сработавший не по делу гвард не должен уметь молчать.
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/nested secret save/));
    // Плейнтекст внешнего поля цел: провал не притворился успехом.
    expect(outer.current.value).toBe("k3y");
    // Блоб записан только внешний — до вложенного дело не дошло.
    expect(mocks.putSecretBlob).toHaveBeenCalledTimes(1);
  });

  it("после сработавшего гварда форма сохраняется снова", async () => {
    // Путь через `throw` тоже обязан снять флаг: иначе одна ошибка автора формы
    // выключала бы сохранение секретов во всём приложении до перезагрузки.
    const { outer, nested } = nesting();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const args = {
      blobKind: BLOB_KIND.registrarApiKey,
      existingBlobId: null,
      persist: async () => {},
    };

    let blocked: boolean | undefined;
    let after: boolean | undefined;
    await act(async () => {
      blocked = await outer.current.save({ ...args, persist: async () => void (await nested()) });
      after = await outer.current.save(args);
    });

    expect(blocked).toBe(false);
    expect(after).toBe(true);
  });

  it("две формы подряд (не вложенно) сохраняются обе", async () => {
    // Флаг модульный, и снимать его надо на всех путях: иначе первая же
    // успешная форма заблокировала бы все остальные до перезагрузки.
    const { outer, inner } = nesting();
    const args = (kind: (typeof BLOB_KIND)[keyof typeof BLOB_KIND]) => ({
      blobKind: kind,
      existingBlobId: null,
      persist: async () => {},
    });

    let first: boolean | undefined;
    let second: boolean | undefined;
    await act(async () => {
      first = await outer.current.save(args(BLOB_KIND.registrarApiKey));
      second = await inner.current.save(args(BLOB_KIND.registrarApiSecret));
    });

    expect([first, second]).toEqual([true, true]);
  });

  it("пока одна форма пишет блоб, вторая проходит целиком", async () => {
    // Окно гварда — только `persist`, и держится это одним комментарием.
    // Расширь его на всю операцию (самая долгая часть — запись блоба через
    // Tauri-IPC), и вторая, ни во что не вложенная форма получит бросок
    // «nested secret save» просто за то, что сохранилась не в свою очередь.
    const { outer, inner } = nesting();
    let releaseBlob: (blobId: string) => void = () => {};
    mocks.putSecretBlob.mockImplementationOnce(
      () => new Promise<string>((resolve) => { releaseBlob = resolve; }),
    );
    const args = (kind: (typeof BLOB_KIND)[keyof typeof BLOB_KIND]) => ({
      blobKind: kind,
      existingBlobId: null,
      persist: async () => {},
    });

    let slow: boolean | undefined;
    let fast: boolean | undefined;
    await act(async () => {
      const pending = outer.current.save(args(BLOB_KIND.registrarApiKey));
      // Целиком, вместе с `persist`: первая форма в этот момент висит на записи
      // своего блоба и снять с неё гвард нечему.
      fast = await inner.current.save(args(BLOB_KIND.registrarApiSecret));
      releaseBlob("id-registrar_api_key");
      slow = await pending;
    });

    expect([slow, fast]).toEqual([true, true]);
  });

  it("повтор после ошибки не заблокирован", async () => {
    // `finally` снимает флаг и на исключении — иначе одна упавшая запись
    // блоба навсегда закрывала бы форму.
    const { outer } = nesting();
    mocks.putSecretBlob.mockRejectedValueOnce(new Error("keychain locked"));
    const args = {
      blobKind: BLOB_KIND.registrarApiKey,
      existingBlobId: null,
      persist: async () => {},
    };

    let failed: boolean | undefined;
    let retried: boolean | undefined;
    await act(async () => {
      failed = await outer.current.save(args);
      retried = await outer.current.save(args);
    });

    expect(failed).toBe(false);
    expect(retried).toBe(true);
  });
});
