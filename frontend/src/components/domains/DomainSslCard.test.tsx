import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import DomainSslCard from "./DomainSslCard";
import type { DomainFacts, SslState } from "../../lib/domainFacts";

/**
 * Карточка SSL вкладки Overview — сертификат домена и то, что о нём говорит
 * наша запись из provision.
 *
 * Приехала сюда из секции «Server state» вместе со своей половиной правила
 * расхождений, и проверяется здесь ровно то, что от секции унаследовано:
 *
 *  - значением поля остаётся ФАКТ, наша запись всплывает строкой «при
 *    развёртывании: X» только при расхождении и печатается по-человечески;
 *  - «сертификата нет» и «прочитать не смогли» — отдельные слова, а не пустота;
 *  - без снимка приписки под полями не печатаются (`HasSnapshot`), а значения
 *    остаются приглушёнными.
 *
 * И одно новое, чего у секции не было: **свежесть снимка в шапке карточки**.
 * Кнопка снятия осталась на вкладке Server (снимок один на обе), но молчать про
 * возраст здесь нельзя — Overview выдавал бы протухшее измерение за свежее.
 *
 * Лестница самих состояний (`sslState`: протухший снимок не зелёный и т.д.)
 * проверяется не тут, а на модалке (`DomainDetailModal.overview.test.tsx`):
 * значение считается ОДИН раз на всю карточку домена и раздаётся вниз, поэтому
 * его смысл охраняется там, где видно обоих потребителей сразу — бейдж шапки и
 * эту карточку.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

function facts(over: Partial<DomainFacts> = {}): DomainFacts {
  return {
    site: { domain_name: "example.com", site_user: "example_usr", site_path: "/var/www/example.com", php_version: "8.2" },
    ssl: { has_certificate: true, expires_at: ahead(60 * DAY), issuer: "Let's Encrypt", is_letsencrypt: true },
    ftp_accounts: [],
    php_version: "8.2",
    php_handler: "php-fpm",
    databases: [],
    logs: [],
    ...over,
  };
}

function domain(over: Record<string, unknown> = {}) {
  return { id: 42, domain_name: "example.com", status: "active", ...over } as any;
}

/** Исход правила, которым нарисовано поле с этой подписью. */
function sourceOf(label: string): string | null {
  return screen.getByText(label).closest("[data-source]")?.getAttribute("data-source") ?? null;
}

function show(over: Record<string, unknown> = {}, ssl: SslState = "valid") {
  render(<DomainSslCard domain={domain(over)} ssl={ssl} now={Date.now()} />);
}

const fresh = { fp_facts: facts(), fp_facts_at: ago(HOUR) };

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe("свежесть снимка — в шапке карточки", () => {
  it("снимка не было — «Never checked», а не пустая шапка", () => {
    // Кнопка снятия живёт на вкладке Server, но возраст обязан быть здесь:
    // иначе Overview печатает срок сертификата, ни словом не сказав, когда его
    // в последний раз читали.
    show();
    expect(screen.getByText("Never checked")).toBeTruthy();
  });

  it("старый снимок помечен протухшим, свежий — нет", () => {
    show({ fp_facts: facts(), fp_facts_at: ago(8 * DAY) });
    expect(screen.getByText(/Checked/).textContent).toContain("stale");

    cleanup();
    show(fresh);
    expect(screen.getByText(/Checked/).textContent).not.toContain("stale");
  });

  it("кнопки снятия снимка здесь нет — она одна и стоит на вкладке Server", () => {
    // Два места, снимающих один и тот же снимок, — это два ответа на вопрос
    // «когда мы читали сервер» и гонка между ними.
    show(fresh);
    expect(screen.queryByText("Проверить на сервере")).toBeNull();
  });
});

describe("состояние сертификата названо словом", () => {
  it("«сертификата нет» — отдельная строка, отличимая от «не проверяли»", () => {
    show({ fp_facts: facts({ ssl: { has_certificate: false, expires_at: null, issuer: null, is_letsencrypt: false } }), fp_facts_at: ago(HOUR) }, "missing");
    expect(screen.getByText("No certificate")).toBeTruthy();
    expect(screen.getByText("No certificate on the server.")).toBeTruthy();
  });

  it("провал чтения сертификата напечатан словами сервера", () => {
    show(
      {
        fp_facts: facts({ ssl: { has_certificate: false, expires_at: null, issuer: null, is_letsencrypt: false, error: "openssl: connect timed out" } }),
        fp_facts_at: ago(HOUR),
      },
      "error",
    );
    expect(screen.getByText("openssl: connect timed out")).toBeTruthy();
  });
});

describe("расхождение нашей записи с фактом", () => {
  it("совпало — строки «при развёртывании» нет вовсе", () => {
    show({ ...fresh, ssl_issuer: "Let's Encrypt" });
    expect(screen.queryByText(/при развёртывании/)).toBeNull();
  });

  it("издатель разошёлся: значением остаётся факт, наша запись — серой строкой", () => {
    show({ ...fresh, ssl_issuer: "ZeroSSL" });
    expect(screen.getByText("Let's Encrypt")).toBeTruthy();
    expect(screen.getByText("при развёртывании: ZeroSSL")).toBeTruthy();
  });

  it("срок сертификата сверяется по дате, а наша запись печатается по-человечески", () => {
    // Часы задаём ЛОКАЛЬНЫЕ: «тот же день» не должен зависеть от зоны CI.
    const at = (days: number, hour: number) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      d.setHours(hour, 0, 0, 0);
      return d;
    };
    const base = {
      fp_facts: facts({
        ssl: { has_certificate: true, expires_at: at(60, 9).toISOString(), issuer: "Let's Encrypt", is_letsencrypt: true },
      }),
      fp_facts_at: ago(HOUR),
    };

    // Тот же день, другое время — не расхождение (наша запись сделана в момент
    // выпуска, сервер отдаёт то, что написано в сертификате).
    show({ ...base, ssl_expires_at: at(60, 18).toISOString() });
    expect(screen.queryByText(/при развёртывании/)).toBeNull();

    cleanup();
    // Другой день — расхождение, и в строке стоит ДАТА, а не сырой ISO: иначе
    // она читалась бы расхождением с форматированным значением над ней.
    const other = at(62, 9);
    show({ ...base, ssl_expires_at: other.toISOString() });
    const note = screen.getByText(/при развёртывании/).textContent ?? "";
    expect(note).toContain(other.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }));
    expect(note).not.toContain("T");
  });
});

describe("снимка не было ни разу", () => {
  it("известное из provision показано как наша запись, а не как измерение", () => {
    show({ ssl_issuer: "Let's Encrypt", ssl_expires_at: ahead(60 * DAY) }, "unchecked");
    expect(sourceOf("Issuer")).toBe("recorded-only");
    expect(sourceOf("Expires")).toBe("recorded-only");
    // Приписки под полями нет: без снимка её место — легенда секции сервера, а
    // здесь то же самое говорят бейдж «Not checked» и шапка «Never checked».
    expect(screen.queryByText("из provision, на сервере не проверено")).toBeNull();
  });

  it("сказать нечего — прочерков не печатаем вовсе", () => {
    // Прочерк в поле читается как «сервер спросили, там пусто», а спрашивать мы
    // не ходили.
    show({}, "unchecked");
    expect(screen.queryByText("Expires")).toBeNull();
    expect(screen.queryByText("Issuer")).toBeNull();
    expect(screen.queryAllByText("—")).toEqual([]);
  });

  it("факты без отметки времени не печатаются вопреки шапке", () => {
    // Пара «`fp_facts` есть, `fp_facts_at` нет» бэкендом не производится, но
    // если разъедется — карточка не должна сказать «Never checked» и тут же
    // напечатать издателя из этих фактов как измеренный.
    show({ fp_facts: facts(), fp_facts_at: null }, "unchecked");
    expect(screen.getByText("Never checked")).toBeTruthy();
    expect(screen.queryByText("Let's Encrypt")).toBeNull();
  });
});
