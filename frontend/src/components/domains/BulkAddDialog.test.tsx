import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import BulkAddDialog from "./BulkAddDialog";
import { queryClient } from "../../api/queryClient";

/**
 * Массовое добавление доменов: сервер на обеих вкладках.
 *
 * До этой правки пачка заводилась без `server_id` вовсе, а provision его ЧИТАЕТ
 * и без него падает, — то есть сотня заведённых доменов требовала сотни правок
 * на соседнем экране, прежде чем с ней можно было что-то сделать.
 *
 * Запирается здесь именно то, что нельзя увидеть в тестах разбора: селект виден
 * на обеих вкладках (а не только там, где стоял раньше), непонятая третья
 * колонка ДЕРЖИТ отправку, и держит она только вкладку CSV — на «Plain Text»
 * третьей колонки нет, и блокировать там нечего.
 */

const mocks = vi.hoisted(() => ({ apiPost: vi.fn() }));

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiPost: mocks.apiPost,
}));

const WEB01 = { id: 11, name: "web-01", ip_address: "45.83.194.107" };
const WEB02 = { id: 12, name: "web-02", ip_address: "10.0.0.2" };

const servers = [WEB01, WEB02].map((s) => ({
  ...s,
  ssh_port: 22,
  ssh_user: "root",
  os: null,
  provider: null,
  status: "active",
  purchase_date: null,
  expiry_date: null,
  fastpanel_status: "unknown",
  fastpanel_url: null,
  fastpanel_user: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  has_ssh: true,
  uptime_seconds: null,
  cpu_usage_pct: null,
  cpu_count: null,
  ram_used_mb: null,
  ram_total_mb: null,
  disk_used_gb: null,
  disk_total_gb: null,
  net_in_kbps: null,
  net_out_kbps: null,
  os_pretty: null,
})) as any;

const registrars = [
  { id: 5, provider: "namecheap", name: "main", created_at: "", updated_at: "" },
] as any;

function renderDialog() {
  return render(
    <QueryClientProvider client={queryClient}>
      <BulkAddDialog
        open
        onClose={() => {}}
        registrars={registrars}
        servers={servers}
        domains={[] as any}
        onCreated={() => {}}
      />
    </QueryClientProvider>,
  );
}

/**
 * Диалог с настоящим `open`, которым распоряжается родитель, — иначе не
 * проверить ни закрытие, ни обещание «прячется, а не размонтируется».
 */
function Harness() {
  const [open, setOpen] = React.useState(true);
  return (
    <QueryClientProvider client={queryClient}>
      <BulkAddDialog
        open={open}
        onClose={() => setOpen(false)}
        registrars={registrars}
        servers={servers}
        domains={[] as any}
        onCreated={() => {}}
      />
      <button onClick={() => setOpen(true)}>Открыть снова</button>
    </QueryClientProvider>
  );
}

const tab = (name: string) => screen.getByRole("button", { name: new RegExp(name) });
const importBtn = () => screen.getByRole("button", { name: /Import Domains/ });

beforeEach(() => {
  mocks.apiPost.mockReset();
  mocks.apiPost.mockResolvedValue({ created: [{ id: 1, domain_name: "example.com" }], skipped: [] });
});

afterEach(cleanup);

describe("BulkAddDialog", () => {
  it("селект сервера виден на обеих вкладках", () => {
    renderDialog();
    expect(screen.getByLabelText("Assign to Server")).toBeTruthy();

    fireEvent.click(tab("CSV"));
    expect(screen.getByLabelText("Assign to Server")).toBeTruthy();
    // Регистратор переехал вместе с ним: до правки он был виден только здесь.
    expect(screen.getByLabelText("Assign to Registrar")).toBeTruthy();
  });

  it("пункты сервера подписаны нагрузкой — тем же списком, что в мастере", () => {
    renderDialog();
    const options = Array.from(
      (screen.getByLabelText("Assign to Server") as HTMLSelectElement).options,
    ).map((o) => o.textContent);
    expect(options).toContain("web-01 — 0 domains");
  });

  it("Plain Text отправляет выбранный сервер в payload", async () => {
    renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/blog\.example\.com/), {
      target: { value: "example.com" },
    });
    fireEvent.change(screen.getByLabelText("Assign to Server"), { target: { value: String(WEB02.id) } });
    fireEvent.click(importBtn());

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalled());
    expect(mocks.apiPost).toHaveBeenCalledWith("/domains/bulk", {
      domains_text: "example.com",
      registrar_id: null,
      server_id: WEB02.id,
    });
  });

  it("CSV отправляет сервер из третьей колонки, а строкам без неё даёт сервер из селекта", async () => {
    renderDialog();
    fireEvent.click(tab("CSV"));
    fireEvent.change(screen.getByPlaceholderText(/45\.83\.194\.107/), {
      target: { value: "example.com;Namecheap;web-02\nshop.com;Hostiq" },
    });
    fireEvent.change(screen.getByLabelText("Assign to Server"), { target: { value: String(WEB01.id) } });
    fireEvent.click(importBtn());

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalled());
    const [url, body] = mocks.apiPost.mock.calls[0];
    expect(url).toBe("/domains/bulk-structured");
    expect(body.items.map((i: any) => i.server_id)).toEqual([WEB02.id, WEB01.id]);
  });

  it("непонятая третья колонка называет строку и не отправляет ничего", async () => {
    renderDialog();
    fireEvent.click(tab("CSV"));
    fireEvent.change(screen.getByPlaceholderText(/45\.83\.194\.107/), {
      target: { value: "example.com;Namecheap;web-01\n\nshop.com;Hostiq;1.2.3.4" },
    });
    fireEvent.click(importBtn());

    // Номер — по тексту в textarea, вместе с пустой строкой посередине.
    await waitFor(() => expect(screen.getByText(/Line 3/)).toBeTruthy());
    expect(screen.getByText(/Line 3/).textContent).toContain("1.2.3.4");
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("правка текста гасит список: он приговор прошлому тексту", async () => {
    renderDialog();
    fireEvent.click(tab("CSV"));
    const area = screen.getByPlaceholderText(/45\.83\.194\.107/);
    fireEvent.change(area, { target: { value: "shop.com;Hostiq;1.2.3.4" } });
    fireEvent.click(importBtn());
    await waitFor(() => expect(screen.getByText(/Line 1/)).toBeTruthy());

    fireEvent.change(area, { target: { value: "shop.com;Hostiq;web-01" } });
    expect(screen.queryByText(/Line 1/)).toBeNull();
  });

  it("ошибки CSV не держат Plain Text — третьей колонки там нет", async () => {
    renderDialog();
    fireEvent.click(tab("CSV"));
    fireEvent.change(screen.getByPlaceholderText(/45\.83\.194\.107/), {
      target: { value: "shop.com;Hostiq;1.2.3.4" },
    });
    fireEvent.click(importBtn());
    await waitFor(() => expect(screen.getByText(/Line 1/)).toBeTruthy());

    fireEvent.click(tab("Plain Text"));
    // Коробка — новость про чужой ввод: на этой вкладке третьей колонки нет.
    expect(screen.queryByText(/Line 1/)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/blog\.example\.com/), {
      target: { value: "example.com" },
    });
    fireEvent.click(importBtn());

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith("/domains/bulk", expect.anything()));
  });

  it("запятые вместо точек с запятой по-прежнему отменяют отправку", async () => {
    renderDialog();
    fireEvent.click(tab("CSV"));
    const area = screen.getByPlaceholderText(/45\.83\.194\.107/);
    fireEvent.change(area, { target: { value: "example.com,Namecheap,web-01" } });
    fireEvent.click(importBtn());

    await waitFor(() => expect(screen.getByText(/commas/)).toBeTruthy());
    expect(mocks.apiPost).not.toHaveBeenCalled();

    // Вердикт про разделитель живёт ровно столько же, сколько список строк:
    // две одинаковые коробки на одной вкладке с разными правилами — это
    // «вы используете запятые» над текстом, в котором их больше нет.
    fireEvent.change(area, { target: { value: "example.com;Namecheap;web-01" } });
    expect(screen.queryByText(/commas/)).toBeNull();
  });

  it("дубль домена в одной вставке держит отправку и называет строку", async () => {
    renderDialog();
    fireEvent.click(tab("CSV"));
    fireEvent.change(screen.getByPlaceholderText(/45\.83\.194\.107/), {
      target: { value: "a.com;Namecheap;web-01\na.com;Namecheap;web-02" },
    });
    fireEvent.click(importBtn());

    // Дошло бы до бэкенда — был бы 500 на уникальном индексе, без номера
    // строки и без единого созданного домена.
    await waitFor(() => expect(screen.getByText(/Line 2/)).toBeTruthy());
    expect(screen.getByText(/Line 2/).textContent).toContain("a.com");
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("закрытие уносит вердикт прошлой попытки, но не набранный текст", async () => {
    render(<Harness />);
    fireEvent.click(tab("CSV"));
    fireEvent.change(screen.getByPlaceholderText(/45\.83\.194\.107/), {
      target: { value: "shop.com;Hostiq;1.2.3.4" },
    });
    fireEvent.click(importBtn());
    await waitFor(() => expect(screen.getByText(/Line 1/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText(/45\.83\.194\.107/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Открыть снова" }));
    // Ошибка описывала отправку, которой больше нет, — показанная снова, она
    // рассказывала бы о несуществующем событии.
    expect(screen.queryByText(/Line 1/)).toBeNull();
    // А вставленный текст промах по Cancel пережить обязан: диалог прячется,
    // а не размонтируется.
    expect((screen.getByPlaceholderText(/45\.83\.194\.107/) as HTMLTextAreaElement).value).toBe(
      "shop.com;Hostiq;1.2.3.4",
    );
  });
});
