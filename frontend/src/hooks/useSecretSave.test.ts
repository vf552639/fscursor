import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

import { useSecretSave, useMultiSecretSave, type SecretSave } from "./useSecretSave";
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
  mocks.putSecretBlob.mockImplementation(async (a: { blobKind: string }) => {
    trace.push(`blob:${a.blobKind}`);
    return `id-${a.blobKind}`;
  });
});

afterEach(cleanup);

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

  it("компилятор не пускает вложенный save внутрь persist", async () => {
    // Проверку делает `tsc --noEmit`: ослабнет `persist` обратно до
    // `Promise<unknown>` — директива станет неиспользованной (TS2578) и сборка
    // упадёт. Дыра была реальной и тихой: внутренний `save` на ошибке
    // возвращает `false`, а не бросает, поэтому внешний видел успешный промис,
    // стирал свой плейнтекст и закрывал форму, не сохранив ничего.
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
