import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainDetailModal from "./DomainDetailModal";
import { queryClient } from "../api/queryClient";

/**
 * Вкладка Overview карточки домена.
 *
 * Показывала она шесть полей из двух десятков, которые модель про домен знает:
 * ни срока домена, ни срока и издателя сертификата, ни версии PHP, ни имён
 * сайта, FTP и базы. Всё это уже приезжало в ответе `/domains` — то есть
 * пользователь ходил за этим в панель на сервере, имея ответ на экране.
 *
 * Два правила, которые тут и проверяются: пустое поле рисуется прочерком (а не
 * пустым местом, которое читается как «нечего показывать, значит порядок»), и
 * паролей на карточке нет вовсе — сервер их не знает, и пустая строка под них
 * обещала бы значение, которого не будет никогда.
 */

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), invokeSynced: vi.fn() }));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** Час сверху — чтобы граница полных суток не перескакивала от задержки рендера. */
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
/** `expiry_date` в производственном виде: `date`, без времени и без зоны. */
const dateOnly = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 10);
/** `2026-09-01` → `01.09.2026`, своей арифметикой — не форматтером продукта. */
const ddMmYyyy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

function domain(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    domain_name: "example.com",
    status: "active",
    registrar_id: 9,
    server_id: 3,
    cloudflare_account_id: 7,
    cloudflare_zone_id: null,
    cloudflare_enabled: false,
    expiry_date: null,
    purchase_date: null,
    ns_status: "ok",
    ns_updated_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  } as any;
}

function show(over: Record<string, unknown> = {}) {
  render(
    <QueryClientProvider client={queryClient}>
      <DomainDetailModal domain={domain(over)} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

/** Значение строки карточки без её подписи. */
function field(label: string): string {
  const row = screen.getByText(`${label}:`).parentElement;
  if (!row) throw new Error(`строки «${label}» на карточке нет`);
  return (row.textContent ?? "").replace(`${label}:`, "").trim();
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("DomainDetailModal — overview", () => {
  it("показывает то, что модель про домен знает", () => {
    const expiry = dateOnly(10 * DAY);
    show({
      expiry_date: expiry,
      ssl_status: "active",
      ssl_expires_at: at(60 * DAY + HOUR),
      ssl_issuer: "Let's Encrypt",
      php_version: "8.2",
      site_user: "example_usr",
      site_path: "/var/www/example_usr/data/www/example.com",
      ftp_user: "example_ftp",
      db_name: "example_db",
      db_user: "example_dbu",
    });
    expect(field("PHP")).toBe("8.2");
    expect(field("SSL issuer")).toBe("Let's Encrypt");
    expect(field("Site user")).toBe("example_usr");
    expect(field("FTP user")).toBe("example_ftp");
    expect(field("DB name")).toBe("example_db");
    expect(field("DB user")).toBe("example_dbu");
    // Срок — тем же модулем, что и колонка списка: дата плюс остаток словами.
    // Дата — та, которую называет регистратор: `expiry_date` приходит без
    // времени, и печатать её надо в UTC, иначе западнее UTC карточка называет
    // предыдущий день.
    expect(field("Expires")).toContain(ddMmYyyy(expiry));
    expect(field("Expires")).toContain("in 10 days");
    expect(field("SSL expires")).toContain("in 60 days");
  });

  it("близкий срок красит, дальний — нет", () => {
    show({ expiry_date: dateOnly(10 * DAY), ssl_expires_at: at(60 * DAY + HOUR) });
    expect((screen.getByText(/in 10 days/).closest("span") as HTMLElement).style.color).toBe(
      "rgb(217, 119, 6)",
    );
    expect((screen.getByText(/in 60 days/).closest("span") as HTMLElement).style.color).toBe(
      "rgb(55, 65, 81)",
    );
  });

  it("незаполненное поле — прочерк, а не пустое место", () => {
    show();
    // Домен, заведённый вручную: сроков нет, сайта на сервере ещё нет. Пустая
    // строка тут читалась бы как «всё в порядке», а это «мы не знаем».
    expect(field("Expires")).toBe("—");
    expect(field("SSL")).toBe("—");
    expect(field("SSL expires")).toBe("—");
    expect(field("PHP")).toBe("—");
    expect(field("DB name")).toBe("—");
    expect(field("Last error")).toBe("—");
  });

  it("полей под пароли нет вовсе", () => {
    // Их и не может быть: пароли FTP и БД показываются один раз сразу после
    // provision и нигде не хранятся. Пустая строка «FTP password: —» обещала бы
    // значение, которое не появится никогда.
    show({ ftp_user: "example_ftp", db_user: "example_dbu" });
    expect(screen.queryByText(/password/i)).toBeNull();
  });

  it("сервер и регистратор пока названы id — имён у карточки нет", () => {
    // Зафиксировано намеренно: за именами пришлось бы тянуть сюда три списка
    // или три новых пропа, а это работа плана про разбор страницы на
    // компоненты. Тест не одобряет id, он не даёт им поменяться молча.
    show();
    expect(field("Server")).toBe("3");
    expect(field("Registrar")).toBe("9");
  });
});
