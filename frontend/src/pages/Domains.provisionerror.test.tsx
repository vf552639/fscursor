import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { queryClient } from "../api/queryClient";

/**
 * Видимость упавшего провижининга в списке доменов (фаза 4, долг №4).
 *
 * Десктоп теперь пишет `last_provision_error` и `status: failed` на провале —
 * страница обязана это показывать, а счётчик «Failed at SSL» обязан считать то,
 * что действительно бывает. Раньше он требовал `status === "failed"` И слова
 * «ssl» в тексте ошибки: провал выпуска SSL провижининг не роняет (домен
 * остаётся `site_created`), а фатальные ошибки про SSL не говорят — то есть
 * счётчик не мог стать ненулевым ни при одном прогоне.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiPut: mocks.apiPut,
  apiDelete: mocks.apiDelete,
}));

vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));
vi.mock("../components/DomainDetailModal", () => ({ default: () => null }));
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));

const PROVISION_ERROR = "provision failed at create_site: the command failed on the server";

function domainRow(over: Partial<Record<string, unknown>> & { id: number; domain_name: string }) {
  return {
    status: "new",
    registrar_id: null,
    server_id: 5,
    cloudflare_account_id: null,
    cloudflare_zone_id: null,
    cloudflare_enabled: false,
    expiry_date: null,
    purchase_date: null,
    ns_status: "pending",
    ns_updated_at: null,
    ssl_status: null,
    last_provision_error: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function renderPage(rows: ReturnType<typeof domainRow>[]) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return rows;
    if (url === "/servers") return { items: [], total: 0 };
    if (url === "/registrars/accounts") return [];
    if (url === "/cloudflare/accounts") return [];
    return {};
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Domains onProvisionResult={vi.fn()} onBulkProvisionResult={vi.fn()} onBulkProvisionError={vi.fn()} onCloudflareBindNotice={vi.fn()} onFullSetupNotice={vi.fn()} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("упавший provision виден в списке доменов", () => {
  it("показывает текст ошибки в строке домена, а не только в тултипе", async () => {
    renderPage([
      domainRow({
        id: 42,
        domain_name: "broken.com",
        status: "failed",
        last_provision_error: PROVISION_ERROR,
      }),
      domainRow({ id: 43, domain_name: "fine.com", status: "active" }),
    ]);

    const failed = (await screen.findByText("broken.com")).closest("tr") as HTMLElement;
    // Текст, а не `title`: тултип невидим, пока в него не попали мышью.
    expect(within(failed).getByText(PROVISION_ERROR)).toBeTruthy();
    expect(within(failed).getByText("Failed")).toBeTruthy();
    // И то, и другое — в ячейке ИМЕНИ домена: своей колонки у ступени настройки
    // больше нет, а сигнал остался под именем, рядом с сервером и регистратором.
    const nameCell = within(failed).getAllByRole("cell")[1];
    expect(within(nameCell).getByText(PROVISION_ERROR)).toBeTruthy();
    expect(within(nameCell).getByText("Failed")).toBeTruthy();

    // Вторая половина утверждения: у домена без ошибки блока нет вовсе.
    // Считается именно число блоков: проверка «нет текста в чистой строке»
    // осталась бы зелёной и у реализации, которая рисует блок всем подряд, —
    // у чистого домена он просто вышел бы пустым.
    const ok = (await screen.findByText("fine.com")).closest("tr") as HTMLElement;
    expect(within(ok).queryByTestId("provision-error")).toBeNull();
    expect(screen.getAllByTestId("provision-error")).toHaveLength(1);
    // И ступень у доехавшего домена не называется вовсе: чипы над таблицей уже
    // сказали, сколько таких, и повторять это в каждой строке значило бы
    // вернуть колонку под другим именем.
    expect(within(ok).queryByText("Deployed")).toBeNull();
  });

  // Набор подобран так, что старый и новый предикаты дают РАЗНЫЕ числа (2 и 1):
  // с одним доменом на каждую сторону утверждение было бы верно при обеих
  // реализациях и не проверяло бы ничего.
  it("считает «Failed at SSL» по доменам, у которых SSL не вышел", async () => {
    renderPage([
      // Считаются эти двое: провижининг дошёл до конца, сертификата нет.
      domainRow({ id: 1, domain_name: "nossl.com", status: "site_created", ssl_status: "error" }),
      domainRow({ id: 2, domain_name: "nossl2.com", status: "active", ssl_status: "error" }),
      // Прежний предикат посчитал бы этот (status failed + «ssl» в тексте) —
      // а сертификат у него как раз есть. Новый его не считает.
      domainRow({
        id: 3,
        domain_name: "sslfine.com",
        status: "failed",
        ssl_status: "active",
        last_provision_error: "provision failed at ssh_connect: ssl-ish words",
      }),
      domainRow({ id: 4, domain_name: "quiet.com", status: "active", ssl_status: "active" }),
    ]);

    // Счётчик переехал из отдельного красного бейджа в строку NS-деталей: в
    // макете вкладки поверхности под него нет, а сигнал терять нельзя — провал
    // SSL больше нигде на этом экране не суммируется. Поэтому сначала разворот.
    fireEvent.click(await screen.findByRole("button", { name: "NS details" }));
    expect(screen.getByText("Failed at SSL: 2")).toBeTruthy();
  });

  it("не показывает «Failed at SSL», когда SSL везде на месте", async () => {
    renderPage([
      domainRow({ id: 1, domain_name: "a.com", status: "active", ssl_status: "active" }),
      domainRow({
        id: 2,
        domain_name: "b.com",
        status: "failed",
        last_provision_error: PROVISION_ERROR,
      }),
    ]);

    // Дождаться отрисовки таблицы, иначе «нет пункта» верно и до загрузки.
    await screen.findByText("b.com");
    // Детали РАЗВЁРНУТЫ: свёрнутая строка не показывает и настоящий счётчик,
    // так что проверка «пункта нет» осталась бы зелёной у любой реализации.
    fireEvent.click(screen.getByRole("button", { name: "NS details" }));
    expect(screen.queryByText(/Failed at SSL/)).toBeNull();
  });
});
