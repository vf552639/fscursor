import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { onlineManager, QueryClientProvider } from "@tanstack/react-query";

import {
  runProvisionDomain,
  runBulkProvisionDomains,
  useProvisionDomain,
  domainsKeys,
  type BulkProvisionDesktopResult,
  type ProvisionDesktopResult,
} from "./domains";
import { queryClient } from "./queryClient";
import { useAuthStore } from "../store/auth";
import { b64ToU8 } from "../lib/b64";

/**
 * Фаза 4: provision перестаёт терять пароли FTP/БД.
 *
 * Проверяем ровно security-инвариант фазы: пароль, сгенерированный на сервере,
 * уходит В БЛОБ (`vault_put_blob`) и его id — в `PUT /domains/{id}`, а сам
 * плейнтекст НИКУДА больше не расходится — ни в тело PUT, ни в кэш мутаций, ни
 * в консоль. И что сохранение идёт ДО показа модалки, поштучно в bulk, и что
 * его провал не роняет показ кредов.
 *
 * Мокаем транспорт (`vault_put_blob` через `invokeIfTauri` и `apiPut`), а не сам
 * `putSecretBlob`: тест обязан ВИДЕТЬ, что именно уехало в блоб и что — в тело
 * PUT. Заглушка над `putSecretBlob` пропустила бы регрессию «пароль в теле PUT».
 */

const mocks = vi.hoisted(() => ({
  invokeSynced: vi.fn(),
  invokeIfTauri: vi.fn(),
  apiPut: vi.fn(),
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiPut: mocks.apiPut,
}));

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/** Ответ `provision_domain` с созданными FTP и (опционально) БД. */
function result(over: Partial<ProvisionDesktopResult> = {}): ProvisionDesktopResult {
  return {
    domain_id: "42",
    site_user: "example_usr",
    site_path: "/var/www/example.com",
    ssl_issued: true,
    ftp: { status: "created", ftp_user: "example_ftp", ftp_password: "FTP-PW" },
    db: { status: "created", db_name: "example_db", db_user: "example_dbu", db_password: "DB-PW" },
    ...over,
  };
}

function bulkReport(over: Partial<BulkProvisionDesktopResult>): BulkProvisionDesktopResult {
  return { idempotency_key: "k", status: "ok", items: [], ...over };
}

/** Аргументы всех вызовов `vault_put_blob`. */
function putBlobCalls(): Record<string, any>[] {
  return mocks.invokeIfTauri.mock.calls
    .filter((c: unknown[]) => c[0] === "vault_put_blob")
    .map((c: unknown[]) => c[1] as Record<string, any>);
}

function blobPlaintext(call: Record<string, any>): string {
  return new TextDecoder().decode(b64ToU8(call.plaintextB64));
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  queryClient.clear();
  queryClient.getMutationCache().clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({ ...base, mutations: { ...base.mutations, retry: false } });
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  setTauri(true);
  // По умолчанию блоб и PUT проходят; конкретные тесты переопределяют.
  mocks.invokeIfTauri.mockResolvedValue(undefined);
  mocks.apiPut.mockResolvedValue({});
});

afterEach(() => {
  onlineManager.setOnline(true);
  queryClient.clear();
  queryClient.getMutationCache().clear();
  useAuthStore.getState().clear();
  setTauri(false);
  vi.restoreAllMocks();
});

describe("одиночный provision — пароли уходят в блобы", () => {
  it("FTP и БД: плейнтекст в vault_put_blob, в PUT домена — только id блобов", async () => {
    mocks.invokeSynced.mockResolvedValue(result());

    await runProvisionDomain({ domainId: 42, domainName: "example.com", withDb: true });

    // Два блоба: FTP и БД, каждый с верным kind и точным плейнтекстом.
    const blobs = putBlobCalls();
    expect(blobs).toHaveLength(2);
    const byKind = Object.fromEntries(blobs.map((b) => [b.blobKind, b]));
    expect(blobPlaintext(byKind["domain_ftp_password"])).toBe("FTP-PW");
    expect(blobPlaintext(byKind["domain_db_password"])).toBe("DB-PW");

    // PUT несёт ТОЛЬКО ссылки на блобы — ни одного плейнтекста.
    expect(mocks.apiPut).toHaveBeenCalledTimes(1);
    const [url, body] = mocks.apiPut.mock.calls[0];
    expect(url).toBe("/domains/42");
    expect(body).toEqual({
      ftp_password_blob_id: byKind["domain_ftp_password"].blobId,
      db_password_blob_id: byKind["domain_db_password"].blobId,
    });
    expect(JSON.stringify(body)).not.toContain("FTP-PW");
    expect(JSON.stringify(body)).not.toContain("DB-PW");
  });

  it("FTP уже существовал (status:exists) — блоб не пишется, PUT не идёт", async () => {
    mocks.invokeSynced.mockResolvedValue(
      result({ ftp: { status: "exists", ftp_user: "example_ftp" }, db: undefined }),
    );

    await runProvisionDomain({ domainId: 42, domainName: "example.com", withDb: false });

    expect(putBlobCalls()).toHaveLength(0);
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("только FTP (БД не просили) — один блоб и PUT только с ftp_password_blob_id", async () => {
    mocks.invokeSynced.mockResolvedValue(result({ db: undefined }));

    await runProvisionDomain({ domainId: 42, domainName: "example.com", withDb: false });

    const blobs = putBlobCalls();
    expect(blobs).toHaveLength(1);
    expect(blobs[0].blobKind).toBe("domain_ftp_password");
    const [, body] = mocks.apiPut.mock.calls[0];
    expect(body).toEqual({ ftp_password_blob_id: blobs[0].blobId });
  });

  it("переprovision переписывает ТОТ ЖЕ блоб, а не осиротит старый", async () => {
    // У домена уже есть блоб пароля (ручной ввод фазы 3 или прошлый прогон).
    const existingId = "11111111-1111-4111-8111-111111111111";
    queryClient.setQueryData(domainsKeys.list(), [
      { id: 42, domain_name: "example.com", ftp_password_blob_id: existingId },
    ]);
    mocks.invokeSynced.mockResolvedValue(result({ db: undefined }));

    await runProvisionDomain({ domainId: 42, domainName: "example.com", withDb: false });

    const ftp = putBlobCalls().find((b) => b.blobKind === "domain_ftp_password");
    // vault_put_blob получил СУЩЕСТВУЮЩИЙ id — версии блоба ведёт сервер внутри
    // одного id, старый пароль не осиротел.
    expect(ftp!.blobId).toBe(existingId);
    const [, body] = mocks.apiPut.mock.calls[0];
    expect(body).toEqual({ ftp_password_blob_id: existingId });
  });

  it("сохраняет пароли ДО показа модалки (persist раньше onResult)", async () => {
    mocks.invokeSynced.mockResolvedValue(result({ db: undefined }));
    const onResult = vi.fn();

    const { result: hook } = renderHook(() => useProvisionDomain(onResult), {
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children),
    });
    await hook.current.mutateAsync({ domainId: 42, domainName: "example.com", withDb: false });

    expect(onResult).toHaveBeenCalledTimes(1);
    // PUT сделан раньше, чем показана модалка — «ещё до показа модалки» из ТЗ.
    expect(mocks.apiPut.mock.invocationCallOrder[0]).toBeLessThan(
      onResult.mock.invocationCallOrder[0],
    );
  });

  it("шифрование пароля БД упало — линковка FTP не потеряна (PUT уходит с ftp_password_blob_id)", async () => {
    // FTP-блоб записывается, DB-блоб бросает. Регрессия: единый catch до apiPut
    // уносил бы уже зашифрованный FTP-пароль — id получен, но домен на него не
    // ссылается, то есть пароль потерян ровно вопреки цели фазы.
    let call = 0;
    mocks.invokeIfTauri.mockImplementation((cmd: string) => {
      if (cmd !== "vault_put_blob") return Promise.resolve(undefined);
      call += 1;
      // Первый vault_put_blob — FTP (успех), второй — БД (провал).
      return call === 1 ? Promise.resolve(undefined) : Promise.reject(new Error("vault down"));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.invokeSynced.mockResolvedValue(result());

    const out = await runProvisionDomain({ domainId: 42, domainName: "example.com", withDb: true });
    expect(out.domain).toBe("example.com");

    // PUT всё равно ушёл — и ровно с блобом FTP, без блоба БД.
    expect(mocks.apiPut).toHaveBeenCalledTimes(1);
    const ftp = putBlobCalls().find((b) => b.blobKind === "domain_ftp_password");
    const [url, body] = mocks.apiPut.mock.calls[0];
    expect(url).toBe("/domains/42");
    expect(body).toEqual({ ftp_password_blob_id: ftp!.blobId });
    // Плейнтекста в теле нет ни FTP, ни БД.
    expect(JSON.stringify(body)).not.toContain("FTP-PW");
    expect(JSON.stringify(body)).not.toContain("DB-PW");
  });

  it("провал сохранения не роняет provision-результат и не глушит модалку", async () => {
    mocks.invokeSynced.mockResolvedValue(result({ db: undefined }));
    mocks.apiPut.mockRejectedValue(new Error("network down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Результат всё равно возвращается — пароль уже показан пользователю.
    const out = await runProvisionDomain({
      domainId: 42,
      domainName: "example.com",
      withDb: false,
    });
    expect(out.domain).toBe("example.com");

    // Провал не проглочен молча — след в консоли есть, но без плейнтекста.
    expect(errSpy).toHaveBeenCalled();
    const dump = JSON.stringify(errSpy.mock.calls);
    expect(dump).not.toContain("FTP-PW");
  });
});

describe("одиночный provision — плейнтекст не оседает в кэше мутаций", () => {
  it("ни пароль, ни его base64 не попадают в MutationCache/storage/консоль", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    mocks.invokeSynced.mockResolvedValue(result());

    await runProvisionDomain({ domainId: 42, domainName: "example.com", withDb: true });

    // Пароли действительно ушли в блоб (иначе «нигде нет» ничего не доказывает).
    const b64s = putBlobCalls().map((b) => b.plaintextB64 as string);
    expect(b64s).toHaveLength(2);

    const cacheDump = JSON.stringify(
      queryClient.getMutationCache().getAll().map((m) => m.state),
    );
    const consoleDump = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of ["FTP-PW", "DB-PW", ...b64s]) {
      expect(cacheDump).not.toContain(secret);
      expect(JSON.stringify(localStorage)).not.toContain(secret);
      expect(JSON.stringify(sessionStorage)).not.toContain(secret);
      expect(consoleDump).not.toContain(secret);
    }
    // В data кэша мутации — только domain_id, без паролей.
    expect(cacheDump).toContain("42");
  });
});

describe("массовый provision — сохранение поштучно", () => {
  it("на каждый отработавший домен — свой блоб и свой PUT", async () => {
    mocks.invokeSynced.mockResolvedValue(
      bulkReport({
        items: [
          {
            domain_id: "1",
            outcome: "done",
            result: result({
              domain_id: "1",
              ftp: { status: "created", ftp_user: "u1", ftp_password: "PW-1" },
              db: undefined,
            }),
          },
          {
            domain_id: "2",
            outcome: "done",
            result: result({
              domain_id: "2",
              ftp: { status: "created", ftp_user: "u2", ftp_password: "PW-2" },
              db: undefined,
            }),
          },
        ],
      }),
    );

    const out = await runBulkProvisionDomains("user-1", ["1", "2"]);
    expect(out.results).toHaveLength(2);

    // Два PUT — по одному на домен, каждый на свой url.
    const urls = mocks.apiPut.mock.calls.map((c) => c[0]).sort();
    expect(urls).toEqual(["/domains/1", "/domains/2"]);
    // И два блоба с верными плейнтекстами.
    const plain = putBlobCalls().map(blobPlaintext).sort();
    expect(plain).toEqual(["PW-1", "PW-2"]);
    // В телах PUT плейнтекста нет.
    for (const [, body] of mocks.apiPut.mock.calls) {
      expect(JSON.stringify(body)).not.toMatch(/PW-\d/);
    }
  });

  it("упавшее сохранение одного домена не мешает сохранить остальные", async () => {
    // Первый PUT падает, второй проходит.
    mocks.apiPut.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.invokeSynced.mockResolvedValue(
      bulkReport({
        items: [
          {
            domain_id: "1",
            outcome: "done",
            result: result({ domain_id: "1", db: undefined }),
          },
          {
            domain_id: "2",
            outcome: "done",
            result: result({ domain_id: "2", db: undefined }),
          },
        ],
      }),
    );

    const out = await runBulkProvisionDomains("user-1", ["1", "2"]);
    // Оба дошли до PUT — обрыв первого не остановил очередь.
    expect(mocks.apiPut).toHaveBeenCalledTimes(2);
    expect(out.results).toHaveLength(2);
  });

  it("для exists-элементов блоб не пишется", async () => {
    mocks.invokeSynced.mockResolvedValue(
      bulkReport({
        items: [
          {
            domain_id: "1",
            outcome: "done",
            result: result({
              domain_id: "1",
              ftp: { status: "exists", ftp_user: "u1" },
              db: undefined,
            }),
          },
          { domain_id: "2", outcome: "failed", error: "boom" },
          { domain_id: "3", outcome: "skipped" },
        ],
      }),
    );

    await runBulkProvisionDomains("user-1", ["1", "2", "3"]);
    expect(putBlobCalls()).toHaveLength(0);
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });
});
