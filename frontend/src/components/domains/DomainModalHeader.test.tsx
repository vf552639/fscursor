import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainModalHeader from "./DomainModalHeader";
import { queryClient } from "../../api/queryClient";
import { SSL_BADGE, sslState, type DomainFacts, type SslState } from "../../lib/domainFacts";

/**
 * Шапка карточки домена — и ровно одно правило, которое видно только отсюда.
 *
 * Состояние сертификата шапка ПОЛУЧАЕТ: `sslState` модалка считает один раз на
 * всю карточку и раздаёт обоим потребителям — сюда и в карточку SSL на
 * Overview. Через модалку это не проверяется никак: считай шапка состояние
 * сама, теми же аргументами, она дала бы тот же ответ, и на экране не
 * изменилось бы ничего. Вторая копия расчёта дожила бы до первого дня, когда
 * аргументы разойдутся — гейт `fp_facts_at`, чужое «сейчас», другой порог
 * протухания, — и разошлась бы молча. Именно так эти два ответа и разъезжались
 * до того, как расчёт подняли в модалку.
 *
 * Поэтому снимок в тесте НАРОЧНО противоречит пропу: по снимку сертификат
 * валиден, а сказать шапка обязана то, что ей дали. И противоречие проходит по
 * ВСЕЙ лестнице: потребитель, оставивший `SSL_BADGE` на месте и подменивший один
 * ярлык, прошёл бы проверку на любом другом состоянии.
 *
 * Больше шапка не считает ничего, и своих проверок на это здесь нет: статус
 * называет `lib/domainStatus` (через `DomainStatusBadge`), срок —
 * `lib/domainExpiry` (через `DomainExpiryField`), и каждый проверяется у себя.
 * Близнец этой проверки — у второго потребителя (`DomainSslCard.test.tsx`).
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Живой сертификат на 60 дней вперёд: сам по себе он считается «valid». */
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

/** Свежий снимок домена — то, чему проп обязан противоречить. */
const SNAPSHOT = { fp_facts: facts(), fp_facts_at: ago(HOUR) };

/** Ступени берём из самой карты: новая приедет в таблицу сама. */
const STATES = Object.keys(SSL_BADGE) as SslState[];
/** Что даёт пересчёт по снимку теста: живой сертификат на 60 дней — «valid». */
const COMPUTED: SslState = "valid";

afterEach(cleanup);

describe("шапка карточки домена", () => {
  it("фикстура и правда даёт COMPUTED, иначе пропуск строки съедет молча", () => {
    // Без этой строки `COMPUTED` — комментарий, а не проверка: поменяй снимок,
    // и пропуск сработает не на той ступени, а тест продолжит зеленеть.
    expect(sslState(SNAPSHOT.fp_facts.ssl, SNAPSHOT.fp_facts_at, Date.now())).toBe(COMPUTED);
  });

  it.each(STATES)("состояние сертификата ПРИЕЗЖАЕТ пропсом, а не считается по снимку заново: %s", (state) => {
    render(
      <QueryClientProvider client={queryClient}>
        <DomainModalHeader
          domain={
            {
              id: 42,
              domain_name: "example.com",
              status: "active",
              expiry_date: null,
              ...SNAPSHOT,
            } as any
          }
          ssl={state}
          now={Date.now()}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText(SSL_BADGE[state].label)).toBeTruthy();
    // На `valid` противоречия нет по построению — это ровно то, что дал бы
    // пересчёт; строка таблицы остаётся, но доказывает только показ.
    if (state !== COMPUTED) expect(screen.queryByText(SSL_BADGE[COMPUTED].label)).toBeNull();
  });
});
