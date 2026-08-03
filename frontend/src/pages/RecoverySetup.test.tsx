import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import RecoverySetup from "./RecoverySetup";

const PHRASE = Array.from({ length: 24 }, (_, i) => `word${i + 1}`).join(" ");

function renderAt(state: Record<string, unknown> | null) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/recovery-setup", state }]}>
      <Routes>
        <Route path="/recovery-setup" element={<RecoverySetup />} />
        <Route path="/" element={<div data-testid="workspace" />} />
        <Route path="/login" element={<div data-testid="login" />} />
      </Routes>
    </MemoryRouter>
  );
}

/** Экран прячет 4 случайных слова; отвечаем на то, что реально спросили. */
function answerChallenge() {
  const words = PHRASE.split(" ");
  for (const label of screen.getAllByText(/^Word \d+$/)) {
    const index = Number(label.textContent!.replace("Word ", "")) - 1;
    const input = label.closest("label")!.querySelector("input")!;
    fireEvent.change(input, { target: { value: words[index] } });
  }
}

describe("RecoverySetup", () => {
  // См. комментарий в RecoveryPhraseCard.test.tsx: `globals` у vitest выключен,
  // авто-очистку RTL приходится вешать вручную.
  afterEach(cleanup);

  it("returns a reconfiguring user to the workspace, not to login", () => {
    renderAt({ phrase: PHRASE, email: "a@b.c", mode: "reconfigure" });
    // /auth/recovery/setup не убивает сессию — выкидывать на логин было бы враньём.
    expect(screen.getByText(/previous recovery phrase no longer works/i)).toBeTruthy();
    answerChallenge();
    fireEvent.click(screen.getByText(/I’ve saved my recovery phrase/));
    expect(screen.getByTestId("workspace")).toBeTruthy();
  });

  it("still sends a freshly registered user to login", () => {
    renderAt({ phrase: PHRASE, email: "a@b.c" });
    expect(screen.queryByText(/previous recovery phrase no longer works/i)).toBeNull();
    answerChallenge();
    fireEvent.click(screen.getByText(/I’ve saved my recovery phrase/));
    expect(screen.getByTestId("login")).toBeTruthy();
  });

  it("offers both ways out when the phrase was lost on reload", () => {
    renderAt(null);
    expect(screen.getByText(/Settings → Encryption/)).toBeTruthy();
  });
});
