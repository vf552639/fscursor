import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { queryClient } from "../api/queryClient";
import { CfBindNotice, CfBindReport } from "../api/cfAutoBind";
import { useCloudflareBind } from "./useCloudflareBind";

/**
 * Гейт «один прогон привязки за раз» и доставка его итога.
 *
 * Проверяется здесь, а не на странице, ровно потому, что предмет проверки —
 * ПЕРЕЖИВАЕТ страницу: прогон идёт десятки секунд, уход с вкладки посреди него
 * штатен, и до выноса хука гейт жил в экземпляре страницы, то есть после
 * возврата исчезал вместе с ним.
 */

const mocks = vi.hoisted(() => ({
  autoBind: vi.fn(),
}));

vi.mock("../api/cfAutoBind", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  autoBindDomainsToCloudflare: mocks.autoBind,
}));

/** Отчёт «привязали один домен» — минимальный успешный прогон. */
function boundOneReport(): CfBindReport {
  return {
    status: "ran",
    bound: [{ domainId: 1, domain: "example.com", accountId: 7, zoneId: "z1" }],
    none: [],
    ambiguous: [],
    writeFailed: [],
    unreadAccounts: [],
    skipped: 0,
  };
}

function Harness({ onAway }: { onAway: (n: CfBindNotice) => void }) {
  const bind = useCloudflareBind(onAway);
  return (
    <div>
      <button onClick={() => { void bind.run([], "manual"); }}>Match</button>
      <button onClick={() => { void bind.run([], "auto"); }}>Auto</button>
      <div data-testid="pending">{bind.pending ? "pending" : "idle"}</div>
      <div data-testid="notice">{bind.notice?.text ?? ""}</div>
    </div>
  );
}

function renderHook(onAway: (n: CfBindNotice) => void) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness onAway={onAway} />
    </QueryClientProvider>
  );
}

describe("useCloudflareBind", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.getMutationCache().clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("прогон по кнопке переживает уход со страницы: вернувшись, второй не запустишь", async () => {
    // Прогон, который не заканчивается сам: пока он идёт, пользователь успевает
    // уйти со вкладки и вернуться.
    let finish: (r: CfBindReport) => void = () => {};
    mocks.autoBind.mockImplementation(
      () => new Promise<CfBindReport>((resolve) => { finish = resolve; })
    );

    const away = vi.fn();
    renderHook(away);
    fireEvent.click(screen.getByText("Match"));
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("pending"));
    expect(mocks.autoBind).toHaveBeenCalledTimes(1);

    // Ушли со вкладки — экземпляр умер вместе со своим стейтом.
    cleanup();

    // Вернулись: новый экземпляр обязан узнать про идущий прогон, иначе кнопка
    // жива и второй клик пойдёт вторым проходом по тем же доменам.
    renderHook(away);
    expect(screen.getByTestId("pending").textContent).toBe("pending");
    fireEvent.click(screen.getByText("Match"));
    expect(mocks.autoBind).toHaveBeenCalledTimes(1);

    finish(boundOneReport());
    // Итог принадлежит УМЕРШЕМУ экземпляру, поэтому уезжает наверх тостом, а не
    // в баннер нового: см. `deliver`.
    await waitFor(() => expect(away).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("idle"));
  });

  it("итог живого прогона идёт в баннер, а не наверх", async () => {
    mocks.autoBind.mockResolvedValue(boundOneReport());
    const away = vi.fn();
    renderHook(away);

    fireEvent.click(screen.getByText("Match"));

    await waitFor(() => expect(screen.getByTestId("notice").textContent).toContain("1"));
    expect(away).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("idle"));
  });

  it("автопривязка гейтом не связана: она не должна пропускать домены чужого прогона", async () => {
    let finish: (r: CfBindReport) => void = () => {};
    mocks.autoBind.mockImplementationOnce(
      () => new Promise<CfBindReport>((resolve) => { finish = resolve; })
    );
    mocks.autoBind.mockResolvedValue(boundOneReport());

    const away = vi.fn();
    renderHook(away);
    fireEvent.click(screen.getByText("Match"));
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("pending"));

    fireEvent.click(screen.getByText("Auto"));
    await waitFor(() => expect(mocks.autoBind).toHaveBeenCalledTimes(2));

    finish(boundOneReport());
  });
});
