import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { useShowOnceQueue } from "./useShowOnceQueue";

/**
 * Очередь показов-один-раз. Смысл ровно один: то, что показывается один раз,
 * нельзя перезаписать следующим результатом — иначе первый пароль исчезает с
 * экрана, а взять его больше негде.
 */

function Harness() {
  const queue = useShowOnceQueue<string>();
  return (
    <div>
      <button onClick={() => queue.push("A")}>push A</button>
      <button onClick={() => queue.push("B")}>push B</button>
      <button onClick={queue.dismiss}>dismiss</button>
      <div data-testid="current">{queue.current ?? "—"}</div>
    </div>
  );
}

const current = () => screen.getByTestId("current").textContent;

afterEach(cleanup);

describe("useShowOnceQueue", () => {
  it("показывает первый и не даёт второму его затереть", () => {
    render(<Harness />);
    expect(current()).toBe("—");

    fireEvent.click(screen.getByText("push A"));
    fireEvent.click(screen.getByText("push B"));

    expect(current()).toBe("A");
  });

  it("после закрытия показывает следующий, а не пустоту", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("push A"));
    fireEvent.click(screen.getByText("push B"));

    fireEvent.click(screen.getByText("dismiss"));
    expect(current()).toBe("B");

    fireEvent.click(screen.getByText("dismiss"));
    expect(current()).toBe("—");
  });

  it("лишнее закрытие пустой очереди безвредно", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("dismiss"));
    expect(current()).toBe("—");

    fireEvent.click(screen.getByText("push A"));
    expect(current()).toBe("A");
  });

  it("держит стабильные `push` и `dismiss`", () => {
    // Идентичность важна: `push` уезжает пропом в `Domains`/`ServerDetail` и
    // захватывается замыканием `mutationFn`, которое живёт дольше рендера.
    const seen: Array<{ push: unknown; dismiss: unknown }> = [];
    function Probe() {
      const q = useShowOnceQueue<string>();
      seen.push({ push: q.push, dismiss: q.dismiss });
      return <button onClick={() => q.push("A")}>push</button>;
    }
    render(<Probe />);
    fireEvent.click(screen.getByText("push"));

    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1].push).toBe(seen[0].push);
    expect(seen[seen.length - 1].dismiss).toBe(seen[0].dismiss);
  });
});
