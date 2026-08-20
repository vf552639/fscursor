import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { CloudflareAccount } from "../../api/cloudflare";
import DomainRow from "./DomainRow";
import { DomainUI, RowCfHint } from "./types";

/**
 * Колонка Cloudflare в строке домена: сохранённая привязка, живая подсказка и
 * прочерк.
 *
 * Предмет проверки один — подсказку видно, что она подсказка. В базе про этот
 * домен ничего не записано, а по `cloudflare_zone_id` фронт потом пушит NS
 * регистратору; строка, неотличимая от сохранённой привязки, обещала бы
 * пользователю связь, которой нет.
 */

const DOMAIN: DomainUI = {
  id: 1,
  domain: "a.com",
  server_id: null,
  registrar_id: null,
  cf_id: null,
  ns_status: "pending",
  status: "new",
  created: "2026-01-01T00:00:00Z",
};

const ACCOUNT: CloudflareAccount = {
  id: 7,
  name: "main",
  account_id: null,
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function renderRow(props: { domain?: DomainUI; cfAccount?: CloudflareAccount; cfHint?: RowCfHint }) {
  render(
    <table>
      <tbody>
        <DomainRow
          domain={props.domain ?? DOMAIN}
          cfAccount={props.cfAccount}
          cfHint={props.cfHint}
          now={Date.parse("2026-08-13T00:00:00Z")}
          selected={false}
          onToggleSelected={() => {}}
          focused={false}
          onOpenDetail={() => {}}
          onDelete={() => {}}
        />
      </tbody>
    </table>,
  );
  // По testid, а не по порядковому номеру ячейки: вставка колонки левее сдвинула
  // бы индекс молча, и половина тестов проверяла бы соседнюю колонку, продолжая
  // проходить. Тот же приём, что у ячеек срока и SSL.
  return screen.getByTestId("cf-cell");
}

afterEach(cleanup);

describe("DomainRow — колонка Cloudflare", () => {
  it("сохранённую привязку показывает как раньше: обычным текстом и без оговорок", () => {
    const cell = renderRow({ domain: { ...DOMAIN, cf_id: 7 }, cfAccount: ACCOUNT });

    expect(cell.textContent).toBe("main");
    expect(screen.queryByTitle(/в базе не сохранено/)).toBeNull();
  });

  it("живое совпадение показывает курсивом и с оговоркой, что это не факт", () => {
    const cell = renderRow({ cfHint: { outcome: "matched", account: ACCOUNT } });

    expect(cell.textContent).toBe("main");
    const hint = screen.getByTitle(/в базе не сохранено/);
    expect(hint.textContent).toBe("main");
    // Начертание — единственное, что отличает подсказку от факта: чипа рядом
    // нет по решению пользователя (лишний шум в списке на двести строк).
    expect((hint as HTMLElement).style.fontStyle).toBe("italic");
  });

  it("сохранённая привязка сильнее подсказки", () => {
    const cell = renderRow({
      domain: { ...DOMAIN, cf_id: 7 },
      cfAccount: ACCOUNT,
      cfHint: { outcome: "matched", account: { ...ACCOUNT, id: 9, name: "second" } },
    });

    // Иначе в одной ячейке оказалось бы два источника правды, и живой список
    // зон перебивал бы выбор, сделанный руками.
    expect(cell.textContent).toBe("main");
    expect(screen.queryByTitle(/в базе не сохранено/)).toBeNull();
  });

  it("неоднозначное совпадение остаётся прочерком без меток", () => {
    const cell = renderRow({ cfHint: { outcome: "ambiguous", accountIds: [7, 9] } });

    // Угадывать нельзя: домен уехал бы в чужую зону, а NS-путь потом прописал
    // бы регистратору её nameservers. Сказать об этом в строке — тоже шум:
    // решение всё равно за пользователем, и принимается оно в карточке.
    expect(cell.textContent).toBe("—");
  });

  it("без данных о зонах колонка остаётся прочерком", () => {
    expect(renderRow({}).textContent).toBe("—");
  });
});
