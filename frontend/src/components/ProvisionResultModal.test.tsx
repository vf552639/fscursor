import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { ProvisionResultModal } from "./ProvisionResultModal";

/**
 * Модалка показа-один-раз для результата provision. Пароли БД и FTP приходят
 * только сюда: сервер их не знает, кэш запросов и SQLCipher-кэш их не хранят.
 * Отсюда правила компонента — ничего не писать в storage и не держать своего
 * стейта: гасит пароли владелец, вызовом `onClose`.
 */

const RESULT = {
  domain_id: "42",
  site_user: "example_com",
  site_path: "/var/www/example_com",
  ssl_issued: true,
  db: { db_name: "example_db", db_user: "example_user", db_password: "db-pw-secret" },
  ftp: { ftp_user: "example_ftp", ftp_password: "ftp-pw-secret" },
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

describe("ProvisionResultModal", () => {
  it("показывает креды БД и FTP один раз и не сохраняет их", () => {
    render(<ProvisionResultModal domain="example.com" result={RESULT} onClose={() => {}} />);

    expect(screen.getByText("db-pw-secret")).toBeTruthy();
    expect(screen.getByText("ftp-pw-secret")).toBeTruthy();
    // Предупреждение — часть гарантии: второй раз их взять негде.
    expect(screen.getAllByText(/shown once/i).length).toBeGreaterThan(0);
    expect(JSON.stringify(localStorage)).not.toContain("db-pw-secret");
    expect(JSON.stringify(sessionStorage)).not.toContain("ftp-pw-secret");
  });

  it("без блока БД не обещает базу, которую не создавали", () => {
    render(
      <ProvisionResultModal
        domain="example.com"
        result={{ ...RESULT, db: undefined }}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText("db-pw-secret")).toBeNull();
    expect(screen.queryByText(/DB password/i)).toBeNull();
    expect(screen.getByText("ftp-pw-secret")).toBeTruthy();
  });

  it("отдаёт закрытие владельцу", () => {
    const onClose = vi.fn();
    render(<ProvisionResultModal domain="example.com" result={RESULT} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // `onClose` здесь — не «свернуть окно», а уничтожить единственную копию
  // паролей. В очереди из двадцати модалок разной высоты промах мимо Done в
  // затемнение — вопрос времени, а стоит он FTP-аккаунта, войти в который уже
  // никто не сможет.
  it("не закрывается кликом в затемнение — это уничтожило бы пароли", () => {
    const onClose = vi.fn();
    const { container } = render(
      <ProvisionResultModal domain="example.com" result={RESULT} onClose={onClose} />,
    );

    const backdrop = container.firstElementChild as HTMLElement;
    fireEvent.click(backdrop);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("ftp-pw-secret")).toBeTruthy();
  });

  // Пачка результатов от одного bulk-прогона: без счётчика пользователь не
  // знает ни сколько паролей ещё впереди, ни что очередь вообще есть.
  it("называет своё место в очереди показов, когда их несколько", () => {
    const { rerender } = render(
      <ProvisionResultModal
        domain="#1"
        result={RESULT}
        onClose={() => {}}
        position={1}
        total={3}
      />,
    );
    expect(screen.getByText(/1 of 3/)).toBeTruthy();

    // Одиночный provision счётчиком не мусорит.
    rerender(
      <ProvisionResultModal
        domain="#1"
        result={RESULT}
        onClose={() => {}}
        position={1}
        total={1}
      />,
    );
    expect(screen.queryByText(/1 of 1/)).toBeNull();
  });
});
