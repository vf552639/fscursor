import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainModalHeader from "./DomainModalHeader";
import { queryClient } from "../../api/queryClient";
import type { DomainFacts } from "../../lib/domainFacts";

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
 * валиден, а сказать шапка обязана то, что ей дали.
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

afterEach(cleanup);

describe("шапка карточки домена", () => {
  it("состояние сертификата ПРИЕЗЖАЕТ пропсом, а не считается по снимку заново", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <DomainModalHeader
          domain={
            {
              id: 42,
              domain_name: "example.com",
              status: "active",
              expiry_date: null,
              fp_facts: facts(),
              fp_facts_at: ago(HOUR),
            } as any
          }
          ssl="expiring"
          now={Date.now()}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Expiring soon")).toBeTruthy();
    expect(screen.queryByText("Valid")).toBeNull();
  });
});
