import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FastPanelCredsModal } from "./FastPanelCredsModal";

describe("FastPanelCredsModal", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  // vitest без `globals: true` не регистрирует авто-cleanup RTL.
  afterEach(cleanup);

  it("показывает пароль один раз и предупреждает, что он нигде не хранится", () => {
    const { container } = render(
      <FastPanelCredsModal
        creds={{
          server_id: "7",
          url: "https://10.0.0.7:8888",
          user: "fastuser",
          password: "s3cr3t-panel-pw",
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("s3cr3t-panel-pw")).toBeTruthy();
    expect(container.textContent).toContain("Shown once");
    // Единственное место, где пароль существует, — этот DOM.
    expect(JSON.stringify(localStorage)).not.toContain("s3cr3t-panel-pw");
    expect(JSON.stringify(sessionStorage)).not.toContain("s3cr3t-panel-pw");
  });

  it("по Done просит владельца стейта погасить креды", () => {
    const onClose = vi.fn();
    render(
      <FastPanelCredsModal
        creds={{ server_id: "7", url: null, user: "fastuser", password: "s3cr3t-panel-pw" }}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText("Done"));
    // Своего стейта у модалки нет: показ-один-раз держится на том, что владелец
    // (DesktopWorkspace) по этому вызову обнуляет creds.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("без пароля объясняет, что делать, вместо пустого поля", () => {
    render(
      <FastPanelCredsModal
        creds={{ server_id: "7", url: "https://10.0.0.7:8888", user: null, password: null }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/credentials could not be read/)).toBeTruthy();
  });
});
