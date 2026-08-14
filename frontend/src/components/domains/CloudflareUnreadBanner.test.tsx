import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { CloudflareAccount } from "../../api/cloudflare";
import CloudflareUnreadBanner from "./CloudflareUnreadBanner";

/**
 * Оговорка про аккаунты, чьи зоны не прочитались.
 *
 * Проверяется текст, потому что он и есть вся работа этой строки: без неё
 * прочерк в колонке Cloudflare читается как «Cloudflare нет», а с неточной
 * формулировкой — как «подсказок по этим аккаунтам нет вовсе», что неправда для
 * аккаунта, прочитанного до поломки токена.
 */

function account(id: number, name: string): CloudflareAccount {
  return {
    id,
    name,
    account_id: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

afterEach(cleanup);

describe("CloudflareUnreadBanner", () => {
  it("называет аккаунты и не обещает, что подсказок по ним нет вовсе", () => {
    render(
      <CloudflareUnreadBanner
        accounts={[
          { account: account(7, "main"), error: new Error("Invalid API Token") },
          { account: account(8, "backup"), error: new Error("network error") },
        ]}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe(
      "Cloudflare: 2 account(s) could not be read (main, backup) — matches from them may be missing or out of date.",
    );
  });

  it("причину отказа держит при имени аккаунта, а не теряет", () => {
    render(
      <CloudflareUnreadBanner
        accounts={[{ account: account(7, "main"), error: new Error("Invalid API Token") }]}
      />,
    );

    // Истёкший токен чинят в настройках, оборвавшуюся сеть — повтором: «не
    // прочитан» без причины нечем отработать.
    expect(screen.getByTitle("Invalid API Token").textContent).toBe("main");
  });

  it("длинную чужую ошибку обрезает тем же правилом, что и отчёт привязки", () => {
    render(
      <CloudflareUnreadBanner
        accounts={[{ account: account(7, "main"), error: new Error("x".repeat(500)) }]}
      />,
    );

    // В пределе сюда приезжает тело ответа Cloudflare, а `title` показывается
    // одной подсказкой поверх страницы.
    const title = screen.getByText("main").getAttribute("title") ?? "";
    expect(title.length).toBeLessThan(500);
    expect(title.endsWith("…")).toBe(true);
  });
});
