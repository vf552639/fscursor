import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Activity from "./Activity";

vi.mock("../api/tasks", () => ({
  useTaskLogs: () => ({ data: { items: [] }, isLoading: false }),
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
