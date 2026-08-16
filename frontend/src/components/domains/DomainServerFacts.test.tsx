import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainServerFacts from "./DomainServerFacts";
import { queryClient } from "../../api/queryClient";
import type { DomainFacts } from "../../lib/domainFacts";
import { setTauri, setBlobUser, clearBlobUser, putBlobArgs, blobPlaintext } from "../../test/secretBlobKit";

/**
 * Секция «Server state» карточки домена: витрина прочитанного с сервера с
 * честной свежестью. Проверяем ровно продуктовые правила фазы 3:
 *  - кнопка «Проверить на сервере» и ручной ввод пароля — ТОЛЬКО десктоп;
 *  - свежесть считается от `fp_facts_at`, «never checked» — отдельное слово;
 *  - провал последней попытки виден, но снимок остаётся;
 *  - пароль FTP — через `RevealSecret`, плейнтекста в DOM нет;
 *  - лестница SSL: протухший снимок не зелёный, «нет сертификата» отличимо.
 */

const mocks = vi.hoisted(() => ({ invokeSynced: vi.fn(), invokeIfTauri: vi.fn(), apiPut: vi.fn() }));

vi.mock("../../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

// Мокаем транспорт (`vault_put_blob`-канал и `apiPut`), а не сам `secretBlob`:
// тест обязан ВИДЕТЬ, что уехало в блоб (плейнтекст) и что — в тело PUT (только
// blobId). Заглушка над `putSecretBlob`/`useSecretSave` пропустила бы регрессию,
// прокидывающую пароль в `variables` мутации домена.
vi.mock("../../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiPut: mocks.apiPut,
}));

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

const SERVER = { id: 3, name: "web-01", ip_address: "10.0.0.3" } as any;

function facts(over: Partial<DomainFacts> = {}): DomainFacts {
  return {
    site: { domain_name: "example.com", site_user: "example_usr", site_path: "/var/www/example.com", php_version: "8.2" },
    ssl: { has_certificate: true, expires_at: ahead(60 * DAY), issuer: "Let's Encrypt", is_letsencrypt: true },
    ftp_accounts: [{ login: "example_ftp", home: "/var/www/example.com" }],
    php_version: "8.2",
    php_handler: "php-fpm",
    databases: ["example_db"],
    logs: [{ path: "/var/log/nginx/example.com.error.log", exists: true, size_bytes: 1024 }],
    ...over,
  };
}

function domain(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    domain_name: "example.com",
    status: "active",
    server_id: 3,
    registrar_id: 9,
    ftp_user: "example_ftp",
    ...over,
  } as any;
}

/**
 * Аргументы всех mock-вызовов, КРОМЕ `vault_put_blob` (единственного законного
 * получателя плейнтекста), в виде JSON-строк — чтобы искать в них утечку.
 */
function otherMockCalls(): { name: string; blob: string }[] {
  const out: { name: string; blob: string }[] = [];
  for (const c of mocks.invokeIfTauri.mock.calls) {
    if (c[0] === "vault_put_blob") continue;
    out.push({ name: `invokeIfTauri:${String(c[0])}`, blob: JSON.stringify(c) });
  }
  for (const c of mocks.invokeSynced.mock.calls) {
    out.push({ name: `invokeSynced:${String(c[0])}`, blob: JSON.stringify(c) });
  }
  for (const c of mocks.apiPut.mock.calls) {
    out.push({ name: "apiPut", blob: JSON.stringify(c) });
  }
  return out;
}

function show(over: Record<string, unknown> = {}, server = SERVER) {
  render(
    <QueryClientProvider client={queryClient}>
      <DomainServerFacts domain={domain(over)} server={server} now={Date.now()} />
    </QueryClientProvider>,
  );
}

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

describe("кнопка «Проверить на сервере» — только десктоп", () => {
  it("в вебе кнопки нет", () => {
    setTauri(false);
    show();
    expect(screen.queryByText("Проверить на сервере")).toBeNull();
  });

  it("в десктопе есть и зовёт domain_read_facts с id домена", async () => {
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
});

describe("свежесть", () => {
  it("снимка не было — «Never checked»", () => {
    show();
    expect(screen.getByText("Never checked")).toBeTruthy();
  });

  it("старый снимок помечен протухшим", () => {
    show({ fp_facts: facts(), fp_facts_at: ago(8 * DAY) });
    const el = screen.getByText(/Checked/);
    expect(el.textContent).toContain("stale");
  });

  it("свежий снимок протухшим не помечен", () => {
    show({ fp_facts: facts(), fp_facts_at: ago(2 * HOUR) });
    const el = screen.getByText(/Checked/);
    expect(el.textContent).not.toContain("stale");
  });
});

describe("ошибка последней попытки", () => {
  it("показана, а снимок остаётся (свежесть — от fp_facts_at)", () => {
    show({ fp_facts: facts(), fp_facts_at: ago(2 * HOUR), fp_check_error: "ssh: connection refused" });
    expect(screen.getByText(/ssh: connection refused/)).toBeTruthy();
    // Снимок жив: SSL по-прежнему «Valid», ошибка его не стёрла.
    expect(screen.getByText("Valid")).toBeTruthy();
  });
});

describe("SSL по лестнице", () => {
  it("свежий валидный сертификат — «Valid» (зелёный)", () => {
    show({ fp_facts: facts(), fp_facts_at: ago(HOUR) });
    expect(screen.getByText("Valid")).toBeTruthy();
  });

  it("протухший снимок валидного сертификата — «Not checked», а не «Valid»", () => {
    show({ fp_facts: facts(), fp_facts_at: ago(8 * DAY) });
    expect(screen.getByText("Not checked")).toBeTruthy();
    expect(screen.queryByText("Valid")).toBeNull();
  });

  it("свежий снимок без сертификата — «No certificate», отличимо от «не проверяли»", () => {
    show({
      fp_facts: facts({ ssl: { has_certificate: false, expires_at: null, issuer: null, is_letsencrypt: false } }),
      fp_facts_at: ago(HOUR),
    });
    expect(screen.getByText("No certificate")).toBeTruthy();
  });
});

describe("пароль FTP", () => {
  it("без блоба — «not set», ручной ввод только в десктопе", () => {
    setTauri(false);
    show();
    expect(screen.getByText("not set")).toBeTruthy();
    expect(screen.queryByText("Задать пароль")).toBeNull();
  });

  it("«Задать пароль»: плейнтекст уходит ТОЛЬКО в vault_put_blob, в PUT домена — лишь blobId", async () => {
    // Единственный security-инвариант фазы: пароль FTP не попадает ни в
    // `variables` мутации `updateDomain`, ни в тело PUT, ни в один другой вызов
    // — только в блоб. Регрессия «прокинули `ftp_password` в мутацию» обязана
    // красить этот тест, поэтому он ВВОДИТ значение и стережёт его отсутствие.
    const SENTINEL = "ftp-sentinel-pw-9f3";
    setTauri(true);
    mocks.invokeIfTauri.mockResolvedValue(undefined);
    mocks.apiPut.mockResolvedValue(domain());
    show();

    fireEvent.click(screen.getByText("Задать пароль"));
    fireEvent.change(screen.getByLabelText("FTP password"), { target: { value: SENTINEL } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));

    // Легитимный путь: плейнтекст уехал в блоб байт в байт и под верным kind.
    const blob = putBlobArgs(mocks.invokeIfTauri);
    expect(blob.blobKind).toBe("domain_ftp_password");
    expect(blobPlaintext(blob)).toBe(SENTINEL);
    const b64 = blob.plaintextB64 as string;

    // Инвариант: PUT /domains/42 несёт ТОЛЬКО ссылку на блоб.
    const [url, body] = mocks.apiPut.mock.calls[0];
    expect(url).toBe("/domains/42");
    expect(body).toEqual({ ftp_password_blob_id: blob.blobId });
    expect(JSON.stringify(body)).not.toContain(SENTINEL);
    expect(JSON.stringify(body)).not.toContain(b64);

    // И нигде больше: ни в одном mock-вызове, кроме `vault_put_blob`, нет ни
    // плейнтекста, ни его base64.
    const leaked = otherMockCalls().filter(
      (c) => c.blob.includes(SENTINEL) || c.blob.includes(b64),
    );
    expect(leaked).toEqual([]);
  });

  it("в десктопе «Задать пароль» открывает поле ввода (по aria-label), а не показывает секрет", () => {
    setTauri(true);
    show();
    fireEvent.click(screen.getByText("Задать пароль"));
    expect(screen.getByLabelText("FTP password")).toBeTruthy();
  });

  it("с блобом — показывается кнопка RevealSecret, а не сам пароль", () => {
    show({ ftp_password_blob_id: "11111111-1111-4111-8111-111111111111" });
    expect(screen.getByText("Show FTP password")).toBeTruthy();
  });
});

describe("данные сайта", () => {
  it("путь, PHP с обработчиком, БД и логи из фактов", () => {
    show({ fp_facts: facts(), fp_facts_at: ago(HOUR) });
    expect(screen.getByText("/var/www/example.com")).toBeTruthy();
    expect(screen.getByText("8.2 · php-fpm")).toBeTruthy();
    expect(screen.getByText("example_db")).toBeTruthy();
    expect(screen.getByText("/var/log/nginx/example.com.error.log")).toBeTruthy();
  });
});
