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
  db: {
    status: "created" as const,
    db_name: "example_db",
    db_user: "example_user",
    db_password: "db-pw-secret",
  },
  ftp: { status: "created" as const, ftp_user: "example_ftp", ftp_password: "ftp-pw-secret" },
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

  // Повтор по уже сделанному домену. Пароля у существующих аккаунтов в ответе
  // нет и быть не может (`status: "exists"`), и модалка обязана сказать это
  // словами. Молчание читалось бы как «пароль показали, а я проморгал», а
  // рамка «shown once … copy them now» без пароля — прямая ложь.
  it("про существовавшие аккаунты не обещает пароль, которого нет", () => {
    render(
      <ProvisionResultModal
        domain="example.com"
        result={{
          ...RESULT,
          db: { status: "exists", db_name: "example_db", db_user: "example_user" },
          ftp: { status: "exists", ftp_user: "example_ftp" },
        }}
        onClose={() => {}}
      />,
    );

    // Ни одного «скопируйте сейчас» и ни одного поля с паролем: неверная
    // реализация показала бы тот же блок с пустым значением под подписью
    // «shown once … copy them now», и пользователь искал бы потерянный пароль.
    // (Слова «shown once» в объяснении есть, но в прошедшем времени — про тот
    // прогон, который аккаунт создал.)
    expect(screen.queryByText(/copy them now/i)).toBeNull();
    expect(screen.queryByText(/DB password/i)).toBeNull();
    expect(screen.queryByText(/FTP password/i)).toBeNull();
    // Зато сказано, что аккаунты уже были и почему пароля здесь нет.
    expect(screen.getByText(/Database example_db and user example_user already existed/i))
      .toBeTruthy();
    expect(screen.getByText(/FTP account example_ftp already existed/i)).toBeTruthy();
    expect(screen.getAllByText(/cannot be shown again/i).length).toBe(2);
    // Логин показан: по нему аккаунт находят в панели, чтобы сменить пароль там.
    expect(screen.getAllByText("example_ftp").length).toBeGreaterThan(0);
  });

  // Смешанный случай — самый вероятный на повторе с `withDb`: базу создали
  // сейчас, FTP-аккаунт остался с прошлого раза. Блоки независимы: пароль
  // созданной базы обязан быть показан, и притом не под общей рамкой с чужим
  // аккаунтом.
  it("рядом с созданной базой честно объясняет существующий FTP-аккаунт", () => {
    render(
      <ProvisionResultModal
        domain="example.com"
        result={{ ...RESULT, ftp: { status: "exists", ftp_user: "example_ftp" } }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("db-pw-secret")).toBeTruthy();
    expect(screen.getByText(/Database credentials — shown once/i)).toBeTruthy();
    expect(screen.queryByText("ftp-pw-secret")).toBeNull();
    expect(screen.queryByText(/FTP password/i)).toBeNull();
    expect(screen.getByText(/FTP account example_ftp already existed/i)).toBeTruthy();
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
