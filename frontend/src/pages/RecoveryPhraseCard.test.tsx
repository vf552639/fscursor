import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import RecoveryPhraseCard from "./RecoveryPhraseCard";
import { useAuthStore } from "../store/auth";

const invokeIfTauri = vi.fn();
vi.mock("../lib/tauri-invoke", () => ({
  invokeIfTauri: (cmd: string, args?: Record<string, unknown>) => invokeIfTauri(cmd, args),
}));
vi.mock("../lib/runtime", () => ({ isTauri: () => true }));

/** Показывает, куда и с чем нас увёл navigate — фразу проверяем по факту передачи. */
function LandingProbe() {
  const state = useLocation().state as Record<string, unknown> | null;
  return <div data-testid="landed">{JSON.stringify(state)}</div>;
}

function renderCard() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<RecoveryPhraseCard />} />
        <Route path="/recovery-setup" element={<LandingProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("RecoveryPhraseCard", () => {
  beforeEach(() => {
    invokeIfTauri.mockReset();
    useAuthStore.getState().setUser("u-1", "owner@example.com");
  });

  // Авто-очистки нет: в vite.config.ts у vitest не включён `globals`, поэтому RTL
  // не вешает свой afterEach и DOM прошлого теста иначе остаётся на странице.
  afterEach(cleanup);

  it("warns a legacy account that it cannot be recovered", async () => {
    invokeIfTauri.mockResolvedValue(false);
    renderCard();
    expect(await screen.findByText(/cannot be recovered/i)).toBeTruthy();
    // Кнопка зовёт настроить, а не «перевыпустить»: перевыпускать нечего.
    expect(screen.getByText("Set up recovery phrase")).toBeTruthy();
  });

  it("confirms a configured account instead of nagging it", async () => {
    invokeIfTauri.mockResolvedValue(true);
    renderCard();
    expect(await screen.findByText(/Recovery phrase is configured/i)).toBeTruthy();
    expect(screen.queryByText(/cannot be recovered/i)).toBeNull();
  });

  // Ложное «не настроено» заставило бы перевыпустить фразу и обесценить записанную.
  it("claims nothing when the server did not report a status", async () => {
    invokeIfTauri.mockResolvedValue(null);
    renderCard();
    await waitFor(() => expect(screen.getByText(/Generate a new recovery phrase/)).toBeTruthy());
    expect(screen.queryByText(/cannot be recovered/i)).toBeNull();
    expect(screen.queryByText(/Recovery phrase is configured/i)).toBeNull();
  });

  it("stays usable when the status probe itself fails", async () => {
    invokeIfTauri.mockRejectedValue(new Error("offline"));
    renderCard();
    await waitFor(() => expect(screen.getByText(/Generate a new recovery phrase/)).toBeTruthy());
  });

  it("passes the freshly minted phrase to the save screen in reconfigure mode", async () => {
    invokeIfTauri.mockImplementation((cmd: string) => {
      if (cmd === "auth_recovery_status") return Promise.resolve(false);
      return Promise.resolve({ user_id: "u-1", recovery_phrase: "alpha beta gamma" });
    });
    renderCard();

    fireEvent.click(await screen.findByText("Set up recovery phrase"));
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "pw" } });
    fireEvent.click(screen.getByText("Generate phrase"));

    const landed = await screen.findByTestId("landed");
    const state = JSON.parse(landed.textContent || "{}");
    expect(state.phrase).toBe("alpha beta gamma");
    // Без mode экран увёл бы на /login, хотя сессия жива: setup её не трогает.
    expect(state.mode).toBe("reconfigure");
    expect(state.email).toBe("owner@example.com");
    expect(invokeIfTauri).toHaveBeenCalledWith("auth_recovery_setup", { password: "pw" });
  });

  it("keeps the user on the page and shows why when the password is wrong", async () => {
    invokeIfTauri.mockImplementation((cmd: string) => {
      if (cmd === "auth_recovery_status") return Promise.resolve(true);
      return Promise.reject({ Api: "Wrong master password — recovery was not changed." });
    });
    renderCard();

    fireEvent.click(await screen.findByText("Generate a new recovery phrase"));
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "bad" } });
    fireEvent.click(screen.getByText("Generate phrase"));

    // `{ Api: "…" }` без describeCommandError отрендерилось бы как [object Object].
    expect(await screen.findByText(/Wrong master password/)).toBeTruthy();
    expect(screen.queryByTestId("landed")).toBeNull();
  });
});
