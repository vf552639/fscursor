import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainOverviewTab from "./DomainOverviewTab";
import { queryClient } from "../../../api/queryClient";
import { SSL_BADGE, type DomainFacts, type SslState } from "../../../lib/domainFacts";
import type { NsDelegation } from "../../../lib/nsDelegation";
import type { NsDraft } from "../useNsDraft";

/**
 * Вкладка Overview — и ровно один вопрос: доносит ли она чужие ответы, ничего по
 * дороге не пересчитывая.
 *
 * Содержимое вкладки проверяется не здесь: ряд связей и наша запись — на модалке
 * (`DomainDetailModal.overview.test.tsx`), карточка сертификата — у себя
 * (`DomainSslCard.test.tsx`), панель NS — в наборах про зону и про запись
 * nameservers. Дублировать это было бы покрытием ради покрытия.
 *
 * Проверяется ПРОВОД. Состояние сертификата считает модалка — один `sslState` на
 * всю карточку, — а вкладка только передаёт его карточке SSL. Оба конца провода
 * уже под тестом (шапка и карточка обязаны показывать полученное, а не считать
 * своё), но сам провод не был проверен ничем: подмени здесь `ssl={ssl}` на свой
 * вызов `sslState` с теми же аргументами — и не упадёт ничего. Через модалку не
 * упадёт потому, что аргументы те же и ответ тот же; через тесты карточки — потому
 * что они рисуют карточку напрямую, минуя вкладку. Ровно та дыра, что была у
 * самих потребителей, только этажом выше.
 *
 * Поэтому снимок в домене НАРОЧНО противоречит пропу, и противоречие идёт по всей
 * лестнице: потребитель, подменивший ОДИН ярлык, прошёл бы проверку на любом
 * другом состоянии.
 */

const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("../../../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
}));

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Ступени берём из самой карты: шестая приедет в таблицу сама. */
const STATES = Object.keys(SSL_BADGE) as SslState[];
/** Что дал бы пересчёт по снимку ниже: живой сертификат на 60 дней — «valid». */
const COMPUTED: SslState = "valid";

/** Свежий снимок с живым сертификатом — то, чему проп обязан противоречить. */
function facts(): DomainFacts {
  return {
    site: null,
    ssl: { has_certificate: true, expires_at: ahead(60 * DAY), issuer: "Let's Encrypt", is_letsencrypt: true },
    ftp_accounts: [],
    php_version: null,
    php_handler: null,
    databases: [],
    logs: [],
  };
}

/** Делегирование «не знаем»: у вкладки оно только едет в пилюлю и в панель NS. */
const DELEGATION: NsDelegation = { state: "unknown", reason: "no-zone", detail: null };

/** Черновик NS в покое: живёт он в модалке, вкладка его только раздаёт. */
const NS_DRAFT: NsDraft = {
  text: "",
  edited: false,
  zoneSource: null,
  zoneNameservers: [],
  edit: () => {},
  restore: () => {},
};

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  mocks.apiGet.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("вкладка Overview доносит состояние сертификата, а не считает своё", () => {
  it.each(STATES)("%s", (state) => {
    render(
      <QueryClientProvider client={queryClient}>
        <DomainOverviewTab
          domain={
            {
              id: 42,
              domain_name: "example.com",
              status: "active",
              fp_facts: facts(),
              fp_facts_at: ago(HOUR),
            } as any
          }
          server={undefined}
          zone={null}
          zones={undefined}
          zonesError={null}
          ssl={state}
          now={Date.now()}
          delegation={DELEGATION}
          nsDraft={NS_DRAFT}
          registrarProvider={undefined}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText(SSL_BADGE[state].label)).toBeTruthy();
    // На `valid` противоречия нет по построению — это ровно то, что дал бы
    // пересчёт; строка таблицы остаётся, но доказывает только показ.
    if (state !== COMPUTED) expect(screen.queryByText(SSL_BADGE[COMPUTED].label)).toBeNull();
  });
});
