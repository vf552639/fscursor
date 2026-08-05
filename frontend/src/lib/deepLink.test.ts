import { describe, it, expect, vi } from "vitest";

// Ради одного теста — «чем спрашивает дефолт». Остальные передают свой
// `confirmAction` третьим аргументом и мока не касаются. Пока дефолтную ветку не
// проверял никто, в ней стоял `window.confirm`: в десктопе он не показывает
// ничего и возвращает `false`, то есть КАЖДАЯ `sdmp://`-ссылка молча
// отменялась.
const mocks = vi.hoisted(() => ({ confirmAction: vi.fn() }));
vi.mock("./confirmDialog", () => ({ confirmAction: mocks.confirmAction }));

import {
  parseSdmpDeepLink,
  parseDeepLinkAction,
  describeDeepLinkAction,
  handleSdmpDeepLinkInTauri,
} from "./deepLink";

describe("parseSdmpDeepLink", () => {
  it("accepts sdmp: urls and rejects everything else", () => {
    expect(parseSdmpDeepLink("sdmp://provision?domainId=3")?.hostname).toBe("provision");
    expect(parseSdmpDeepLink("https://evil.example/provision")).toBeNull();
    expect(parseSdmpDeepLink("sdmp")).toBeNull();
  });
});

describe("parseDeepLinkAction", () => {
  it("parses provision by domainId and by id", () => {
    expect(parseDeepLinkAction("sdmp://provision?domainId=3")).toEqual({
      kind: "provision",
      domainId: "3",
    });
    expect(parseDeepLinkAction("sdmp://provision?id=7")).toEqual({
      kind: "provision",
      domainId: "7",
    });
  });

  it("parses bulk-provision into a trimmed id list", () => {
    expect(parseDeepLinkAction("sdmp://bulk-provision?ids=1,%202%20,,3")).toEqual({
      kind: "bulk-provision",
      domainIds: ["1", "2", "3"],
    });
  });

  it("parses install-fastpanel", () => {
    expect(parseDeepLinkAction("sdmp://install-fastpanel?serverId=9")).toEqual({
      kind: "install-fastpanel",
      serverId: "9",
    });
  });

  it("returns null for unknown hosts and for targetless links", () => {
    expect(parseDeepLinkAction("sdmp://whatever?x=1")).toBeNull();
    expect(parseDeepLinkAction("sdmp://provision")).toBeNull();
    expect(parseDeepLinkAction("sdmp://bulk-provision?ids=")).toBeNull();
    expect(parseDeepLinkAction("sdmp://install-fastpanel")).toBeNull();
  });
});

describe("describeDeepLinkAction", () => {
  it("names the action and the specific target", () => {
    expect(describeDeepLinkAction({ kind: "provision", domainId: "3" })).toContain("domain #3");
    expect(describeDeepLinkAction({ kind: "install-fastpanel", serverId: "9" })).toContain(
      "server #9",
    );
    const bulk = describeDeepLinkAction({ kind: "bulk-provision", domainIds: ["1", "2"] });
    expect(bulk).toContain("2 domain(s)");
    expect(bulk).toContain("1, 2");
  });
});

describe("handleSdmpDeepLinkInTauri", () => {
  it("asks for confirmation naming the action, and runs nothing when declined", async () => {
    const asked: string[] = [];
    const res = await handleSdmpDeepLinkInTauri(
      "sdmp://install-fastpanel?serverId=9",
      "user-1",
      (m) => {
        asked.push(m);
        return false;
      },
    );
    // Ни один invoke не случился — иначе тест упал бы на отсутствии Tauri.
    expect(res).toEqual({ handled: true, cancelled: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("server #9");
  });

  it("по умолчанию спрашивает через общий confirmAction, а не через window.confirm", async () => {
    mocks.confirmAction.mockResolvedValue(false);
    const windowConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    // Третий аргумент не передан — работает дефолт.
    const res = await handleSdmpDeepLinkInTauri("sdmp://install-fastpanel?serverId=9", "user-1");

    expect(res).toEqual({ handled: true, cancelled: true });
    expect(mocks.confirmAction).toHaveBeenCalledTimes(1);
    expect(mocks.confirmAction.mock.calls[0][0]).toContain("server #9");
    expect(windowConfirm).not.toHaveBeenCalled();
    windowConfirm.mockRestore();
  });

  it("never prompts for links that are not ours", async () => {
    let asked = 0;
    const res = await handleSdmpDeepLinkInTauri("https://evil.example/x", "user-1", () => {
      asked += 1;
      return true;
    });
    expect(res).toEqual({ handled: false });
    expect(asked).toBe(0);
  });

  it("does nothing without a signed-in user", async () => {
    let asked = 0;
    const res = await handleSdmpDeepLinkInTauri("sdmp://provision?domainId=3", null, () => {
      asked += 1;
      return true;
    });
    expect(res).toEqual({ handled: false });
    expect(asked).toBe(0);
  });
});
