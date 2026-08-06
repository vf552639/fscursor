import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Activity from "./Activity";

const mocks = vi.hoisted(() => ({ taskLogs: [] as any[] }));

// Размонтирование между тестами: без него второй рендер живёт рядом с первым, и
// `getByText` находит два экрана вместо одного.
afterEach(() => {
  cleanup();
  mocks.taskLogs = [];
});

// GET /tasks отдаёт голый массив (List[TaskLogResponse]), а GET /servers —
// пагинированный объект (ServerListResponse). Моки повторяют реальные контракты.
vi.mock("../api/tasks", () => ({
  useTaskLogs: () => ({ data: mocks.taskLogs, isLoading: false }),
}));

vi.mock("../api/servers", () => ({
  useServers: () => ({ data: { items: [] }, isLoading: false }),
}));

vi.mock("../api/audit", () => ({
  useAuditLog: () => ({
    data: [
      {
        id: 1,
        action: "auth.login",
        target_type: null,
        target_id: null,
        device_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        ip: "127.0.0.1",
        metadata: null,
        ts: "2026-01-01T12:00:00.000Z",
      },
    ],
    isLoading: false,
  }),
}));

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("Activity audit tab", () => {
  it("renders audit rows from /audit/log", async () => {
    wrap(<Activity />);
    fireEvent.click(screen.getByText(/Activity Log/i));
    expect(await screen.findByText("auth.login")).toBeTruthy();
    expect(screen.getByText("127.0.0.1")).toBeTruthy();
  });
});

/**
 * Пакетный прогон, дошедший до конца и обработавший не всё (`partial` —
 * мониторинг серверов ставит его, когда часть машин проверить не удалось).
 * Раскладка по трём явным спискам строк его не ловила: в сводке он не считался
 * нигде, а в таблице выглядел серым, то есть статусом, которого мы не знаем.
 * Молчание интерфейса о деградации читается как «всё в порядке» — тот же класс
 * дефекта, что зелёный статус без проверки.
 */
describe("Activity — прогон «сделано не всё» виден", () => {
  const TASKS = [
    { id: 1, task_type: "server_monitor", status: "success", entity_type: "system", entity_id: null, log_text: "checked 10 servers: 0 down, 10 up", created_at: "2026-08-06T09:00:00.000Z" },
    { id: 2, task_type: "server_monitor", status: "partial", entity_type: "system", entity_id: null, log_text: "checked 8 servers: 1 down, 7 up, 2 not checked", created_at: "2026-08-06T10:00:00.000Z" },
    { id: 3, task_type: "install_fastpanel", status: "failed", entity_type: "server", entity_id: 4, log_text: "ssh: connection refused", created_at: "2026-08-06T11:00:00.000Z" },
  ];

  /**
   * Ряд плиток сводки. Ищем именно его, а не текст по всему экрану: слова
   * «Failed» и «Partial» есть ещё и в фильтре статусов, и в бейджах таблицы, и
   * `getByText` по документу находил бы три разных предмета под одним словом.
   */
  function tiles(): HTMLElement {
    const grid = document.querySelector('div[style*="repeat(4,1fr)"]');
    if (!grid) throw new Error("ряда плиток на экране нет");
    return grid as HTMLElement;
  }

  /** Значение плитки по её подписи (`StatCard`). */
  function tile(label: string): string {
    const box = within(tiles()).getByText(label).parentElement;
    if (!box) throw new Error(`плитки «${label}» на экране нет`);
    // Второй потомок: подпись, значение, приписка — в этом порядке.
    return (box.children[1]?.textContent || "").trim();
  }

  it("деградировавший прогон входит в счёт завершённых, но с оговоркой", () => {
    mocks.taskLogs = TASKS;
    wrap(<Activity />);

    // Прогон завершился, поэтому он в «Completed», а не в «Failed»…
    expect(tile("Completed")).toBe("2");
    expect(tile("Failed")).toBe("1");
    // …но слиться с успехом молча он не может: «2 Completed» без оговорки
    // означало бы, что оба прогона сделали свою работу целиком.
    expect(within(tiles()).getByText(/incl\. 1 partial/)).toBeTruthy();
  });

  it("без деградировавших прогонов оговорки нет", () => {
    mocks.taskLogs = [TASKS[0], TASKS[2]];
    wrap(<Activity />);

    expect(tile("Completed")).toBe("1");
    expect(within(tiles()).queryByText(/partial/i)).toBeNull();
  });

  it("в таблице у него свой бейдж, а не серое «не знаем»", () => {
    mocks.taskLogs = TASKS;
    wrap(<Activity />);

    const badge = screen.getByText("◐ Partial");
    // Жёлтый: не провал (красный) и не «✓» (зелёный). Серый в этом UI занят под
    // «статус нам незнаком», а этот статус мы как раз знаем.
    expect(badge.style.background).toBe("rgb(255, 251, 235)");
  });

  it("фильтр статусов умеет отобрать именно их", () => {
    mocks.taskLogs = TASKS;
    wrap(<Activity />);

    const filter = screen.getByDisplayValue("All Statuses") as HTMLSelectElement;
    expect(Array.from(filter.options).map((o) => o.value)).toContain("partial");

    fireEvent.change(filter, { target: { value: "partial" } });
    expect(screen.getByText(/2 not checked/)).toBeTruthy();
    expect(screen.queryByText(/0 down, 10 up/)).toBeNull();
  });
});
