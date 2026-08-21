import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { FactRow, HasSnapshot, RecordedNoteInLegend } from "./fields";

/**
 * Контракт двух контекстов `FactRow` — проверенный НАПРЯМУЮ, а не через экраны.
 *
 * Причина писать этот файл конкретная и её стоит назвать. Контекста два, потому
 * что вопроса два («есть ли у домена снимок» и «сказаны ли эти слова легендой
 * выше»), но у обоих сегодняшних потребителей ответы СОВПАДАЮТ: секция сервера
 * рисует легенду ровно под `noSnapshot`, а карточка SSL — под ним же плюс
 * «есть что приглушать». Из-за этого слияние контекстов обратно в один
 * (`shownNote = hasSnapshot ? note : null`) не роняло ни одного теста через
 * экраны: на их комбинациях оба варианта дают одно и то же.
 *
 * Тест через экран и не должен был этого поймать — различие живёт в МОДУЛЕ, и
 * ловится только там: снимок ЕСТЬ, а легенда всё равно нарисована. Такой
 * комбинации сегодня не производит никто, и ровно поэтому она здесь: вкладка
 * Logs (фаза 5) собирается печатать ту же легенду над своим блоком, и первый же
 * потребитель, у которого ответы разойдутся, обязан застать правило живым, а не
 * свернувшимся обратно в «нет снимка — нет подписи».
 */

const RECORDED = { kind: "recorded-only", recorded: "8.2" } as const;
const NOTE = "from provision, not verified on the server";

function show(ui: React.ReactNode) {
  render(<>{ui}</>);
}

afterEach(cleanup);

describe("приписка «из provision» гасится ЛЕГЕНДОЙ, а не отсутствием снимка", () => {
  it("без провайдеров — печатается: по умолчанию легенды нет ни у кого", () => {
    show(<FactRow k="PHP" src={RECORDED} />);
    expect(screen.getByText(NOTE)).toBeTruthy();
  });

  it("легенда есть — приписка погашена ДАЖЕ под снимком", () => {
    // Различающий случай: `HasSnapshot` говорит «снимок есть», и слить два
    // контекста в один здесь уже нельзя — приписку гасит именно легенда.
    show(
      <HasSnapshot.Provider value={true}>
        <RecordedNoteInLegend.Provider value={true}>
          <FactRow k="PHP" src={RECORDED} />
        </RecordedNoteInLegend.Provider>
      </HasSnapshot.Provider>,
    );
    expect(screen.getByText("8.2")).toBeTruthy();
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it("снимка нет, а легенды нет тоже — приписка печатается", () => {
    // Второй различающий случай, и он же — состояние карточки SSL, у которой
    // легенды не бывает при пустом наборе записанного. Гаси приписку по
    // `HasSnapshot`, и смысл приглушённого значения не сказал бы ни один экран.
    show(
      <HasSnapshot.Provider value={false}>
        <RecordedNoteInLegend.Provider value={false}>
          <FactRow k="PHP" src={RECORDED} />
        </RecordedNoteInLegend.Provider>
      </HasSnapshot.Provider>,
    );
    expect(screen.getByText(NOTE)).toBeTruthy();
  });
});

describe("`HasSnapshot` отвечает за своё — прячет пустое поле", () => {
  it("снимка нет и сказать нечего — строки нет вовсе", () => {
    // Прочерк читался бы как «сервер спросили, там пусто», а спрашивать не
    // ходили. Легенда на это решение не влияет — вопросы разные.
    show(
      <HasSnapshot.Provider value={false}>
        <FactRow k="PHP" />
      </HasSnapshot.Provider>,
    );
    expect(screen.queryByText("PHP")).toBeNull();
  });

  it("снимок есть, а поле пусто — прочерк печатается: это измерение", () => {
    show(
      <HasSnapshot.Provider value={true}>
        <FactRow k="PHP" />
      </HasSnapshot.Provider>,
    );
    expect(screen.getByText("PHP")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });
});
