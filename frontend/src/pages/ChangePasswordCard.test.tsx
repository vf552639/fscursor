import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ChangePasswordCard from "./ChangePasswordCard";

const invokeIfTauri = vi.fn();
vi.mock("../lib/tauri-invoke", () => ({
  invokeIfTauri: (cmd: string, args?: Record<string, unknown>) => invokeIfTauri(cmd, args),
}));

/** Переключаемый рантайм: в вебе карточка обязана быть заглушкой, а не формой. */
let tauri = true;
vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return { ...actual, isTauri: () => tauri };
});

function openForm() {
  render(<ChangePasswordCard />);
  fireEvent.click(screen.getByText("Change master password"));
}

function fill(placeholder: string, value: string) {
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
}

describe("ChangePasswordCard", () => {
  beforeEach(() => {
    tauri = true;
    invokeIfTauri.mockReset();
    invokeIfTauri.mockResolvedValue(null);
  });

  // См. RecoveryPhraseCard.test.tsx: `globals` у vitest выключен, автоочистки RTL нет.
  afterEach(cleanup);

  it("is a desktop-only note in the web panel, never a password form", () => {
    tauri = false;
    render(<ChangePasswordCard />);
    expect(screen.getByText(/runs in the SDMP desktop app/i)).toBeTruthy();
    expect(screen.queryByText("Change master password")).toBeNull();
    expect(document.querySelector("input[type=password]")).toBeNull();
  });

  it("hands the desktop command camelCase argument keys", async () => {
    openForm();
    fill("Current password", "old-pw");
    fill("New password", "new-pw");
    fill("Repeat new password", "new-pw");
    fireEvent.click(screen.getByText("Change password"));

    expect(await screen.findByText(/Master password changed/i)).toBeTruthy();
    // snake_case здесь молча падает на "missing required key oldPassword".
    expect(invokeIfTauri).toHaveBeenCalledWith("auth_change_password", {
      oldPassword: "old-pw",
      newPassword: "new-pw",
    });
  });

  it("refuses a mistyped repeat before touching the account", async () => {
    openForm();
    fill("Current password", "old-pw");
    fill("New password", "new-pw");
    fill("Repeat new password", "new-pwq");
    fireEvent.click(screen.getByText("Change password"));

    // Опечатка в новом пароле — это обёртка VK под паролем, которого никто не знает:
    // отбить её до вызова дешевле, чем потом восстанавливаться по фразе.
    expect(await screen.findByText(/do not match/i)).toBeTruthy();
    expect(invokeIfTauri).not.toHaveBeenCalled();
  });

  it("keeps the user on the form and says why when the current password is wrong", async () => {
    invokeIfTauri.mockRejectedValue({
      Api: "Wrong current password — the password was not changed.",
    });
    openForm();
    fill("Current password", "bad");
    fill("New password", "new-pw");
    fill("Repeat new password", "new-pw");
    fireEvent.click(screen.getByText("Change password"));

    // `{ Api: "…" }` без describeCommandError отрендерилось бы как [object Object].
    expect(await screen.findByText(/Wrong current password/)).toBeTruthy();
    expect(screen.queryByText(/Master password changed/i)).toBeNull();
    expect(screen.getByText("Change password")).toBeTruthy();
  });

  it("explains a locked vault instead of printing the bare word «locked»", async () => {
    // `auth_change_password` читает VK из связки ключей ОС; если его там нет,
    // Rust отдаёт `CommandError::Keychain("locked")`.
    invokeIfTauri.mockRejectedValue({ Keychain: "locked" });
    openForm();
    fill("Current password", "old-pw");
    fill("New password", "new-pw");
    fill("Repeat new password", "new-pw");
    fireEvent.click(screen.getByText("Change password"));

    expect(await screen.findByText(/vault is locked/i)).toBeTruthy();
    expect(screen.queryByText("locked")).toBeNull();
  });

  it("promises the secrets survive, because the vault key does", () => {
    render(<ChangePasswordCard />);
    expect(screen.getByText(/vault key/i)).toBeTruthy();
  });
});
