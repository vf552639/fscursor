import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { queryClient } from "../api/queryClient";
import { FullSetupNotice, FullSetupReport } from "../api/fullSetup";
import { FullSetupPlan } from "../lib/fullSetupPlan";
import { useFullSetup } from "./useFullSetup";

/**
 * Гейт «одна полная настройка за раз», признак `pending` и доставка итога.
 *
 * Проверяется здесь, а не на странице, ровно потому, что предмет проверки
 * ПЕРЕЖИВАЕТ страницу: прогон по сотне доменов идёт минутами, уход со вкладки
 * посреди него штатен, а вернувшаяся страница обязана узнать про идущий прогон
 * — иначе кнопка жива, и второй прогон уходит поверх первого. У полной
 * настройки это не безобидный повтор, как у привязки: NS у регистратора
 * прописываются во второй раз, то есть платный вызов и второй увод трафика.
 */

const mocks = vi.hoisted(() => ({
  bulk: vi.fn(),
  single: vi.fn(),
}));

vi.mock("../api/fullSetup", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  bulkFullSetup: mocks.bulk,
  newDomainFullSetup: mocks.single,
}));

const PLAN: FullSetupPlan & { serverId: number } = {
  serverId: 5,
  cloudflareAccountId: 7,
  registrarId: null,
  createZone: true,
  pushNs: false,
};

/** Отчёт «связали и завели зону одному домену» — минимальный успешный прогон. */
function oneZoneReport(): FullSetupReport {
  return {
    outcome: "ran",
    links: { requested: 1, linked: 1, skipped: 0 },
    steps: "ran",
    items: [
      {
        domain: "a.com",
        result: {
          domain_id: "1",
          zone: { status: "created", zone_id: "z1", name_servers: ["a.ns"] },
          zone_saved: true,
          ns: { status: "skipped", reason: "not_requested" },
        },
      },
    ],
    aborted: null,
  };
}

function Harness({ onAway }: { onAway: (n: FullSetupNotice) => void }) {
  const setup = useFullSetup(onAway);
  return (
    <div>
      <button onClick={() => { void setup.runBulk([1], PLAN); }}>Run</button>
      {/* Оба запуска в одном такте: так гейт проверяется без обвязки страницы,
          а `pending` к этому моменту заведомо ещё не доехал до разметки. */}
      <button onClick={() => { void setup.runBulk([1], PLAN); void setup.runBulk([1], PLAN); }}>
        Run twice
      </button>
      <button onClick={() => { void setup.runForNewDomain({ id: 9, domain_name: "new.com" }, PLAN); }}>
        Wizard
      </button>
      <div data-testid="pending">{setup.pending ? "pending" : "idle"}</div>
      <div data-testid="notice">{setup.notice?.text ?? ""}</div>
    </div>
  );
}

function renderHook(onAway: (n: FullSetupNotice) => void) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness onAway={onAway} />
    </QueryClientProvider>,
  );
}

describe("useFullSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.getMutationCache().clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("два запуска в одном такте дают один прогон", async () => {
    mocks.bulk.mockImplementation(() => new Promise<FullSetupReport>(() => {}));

    renderHook(vi.fn());
    fireEvent.click(screen.getByText("Run twice"));
    await waitFor(() => expect(mocks.bulk).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.bulk).toHaveBeenCalledTimes(1);
    // Тот же признак, которым гасятся кнопка тулбара и кнопка диалога.
    expect(screen.getByTestId("pending").textContent).toBe("pending");
  });

  it("прогон переживает уход со страницы: вернувшись, второй не запустишь", async () => {
    let finish: (r: FullSetupReport) => void = () => {};
    mocks.bulk.mockImplementation(() => new Promise<FullSetupReport>((resolve) => { finish = resolve; }));

    const away = vi.fn();
    renderHook(away);
    fireEvent.click(screen.getByText("Run"));
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("pending"));

    // Ушли со вкладки — экземпляр умер вместе со своим стейтом.
    cleanup();
    renderHook(away);
    expect(screen.getByTestId("pending").textContent).toBe("pending");
    fireEvent.click(screen.getByText("Run"));
    expect(mocks.bulk).toHaveBeenCalledTimes(1);

    finish(oneZoneReport());
    // Итог принадлежит УМЕРШЕМУ экземпляру, поэтому уезжает наверх тостом.
    await waitFor(() => expect(away).toHaveBeenCalledTimes(1));
    expect(away.mock.calls[0][0].text).toContain("1 zone(s) created");
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("idle"));
  });

  it("итог живого прогона идёт в баннер, а не наверх", async () => {
    mocks.bulk.mockResolvedValue(oneZoneReport());
    const away = vi.fn();
    renderHook(away);

    fireEvent.click(screen.getByText("Run"));

    await waitFor(() =>
      expect(screen.getByTestId("notice").textContent).toContain("1 of 1 linked"),
    );
    expect(away).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("idle"));
  });

  it("мастер гейтом не связан: домен, заведённый во время пачки, настраивается", async () => {
    mocks.bulk.mockImplementation(() => new Promise<FullSetupReport>(() => {}));
    mocks.single.mockResolvedValue(oneZoneReport());

    renderHook(vi.fn());
    fireEvent.click(screen.getByText("Run"));
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("pending"));

    fireEvent.click(screen.getByText("Wizard"));

    // Иначе домен, ради которого мастер и открывали, молча остался бы без зоны
    // — ровно тот случай, ради которого функция сделана.
    await waitFor(() => expect(mocks.single).toHaveBeenCalledTimes(1));
  });
});
