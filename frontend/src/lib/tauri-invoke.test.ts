import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { invokeIfTauri } from "./tauri-invoke";

function enterTauri() {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
}
function exitTauri() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

describe("invokeIfTauri — ошибка команды доходит до пользователя текстом", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    enterTauri();
  });
  afterEach(exitTauri);

  // `CommandError` — Rust-енум с `#[derive(Serialize)]` и БЕЗ `#[serde(tag)]`,
  // поэтому в JS он приезжает объектом `{"Keychain": "locked"}`, а не строкой:
  // Display из `thiserror` serde не использует. Вызывающие проверяют
  // `e instanceof Error && e.message` — не-Error проваливался в generic-ветку,
  // и «keychain: locked» подменялось на «Could not save SSH password».
  // Цена была не косметическая: пользователь видел «не сохранилось» и не имел
  // ни одного способа узнать, что нужно просто войти заново.
  it("разворачивает вариант CommandError в 'вариант: деталь'", async () => {
    invokeMock.mockRejectedValue({ Keychain: "locked" });
    const err = (await invokeIfTauri("vault_put_blob", {}).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("keychain: locked");
  });

  it("разворачивает вариант без полезной нагрузки в имя варианта", async () => {
    invokeMock.mockRejectedValue({ Locked: null });
    const err = (await invokeIfTauri("sync_now", {}).catch((e) => e)) as Error;
    expect(err.message).toBe("locked");
  });

  // Строку Tauri отдаёт, когда команда возвращает `Result<_, String>`, — она
  // уже готова к показу и обязана дойти дословно.
  it("строковую ошибку отдаёт как есть", async () => {
    invokeMock.mockRejectedValue("domain not in local cache");
    const err = (await invokeIfTauri("provision_domain", {}).catch((e) => e)) as Error;
    expect(err.message).toBe("domain not in local cache");
  });

  it("настоящий Error не переупаковывает", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    const err = (await invokeIfTauri("sync_init", {}).catch((e) => e)) as Error;
    expect(err.message).toBe("boom");
  });

  // Страховка от «сделали красиво, потеряли данные»: незнакомая форма не должна
  // схлопываться в `[object Object]` — пусть будет JSON, по нему хотя бы можно
  // понять, что произошло.
  it("незнакомую форму сериализует, а не превращает в [object Object]", async () => {
    invokeMock.mockRejectedValue({ code: 7, hint: "no key" });
    const err = (await invokeIfTauri("whatever", {}).catch((e) => e)) as Error;
    expect(err.message).not.toContain("[object Object]");
    expect(err.message).toContain("no key");
  });

  it("вне десктопа объясняет, что команда требует приложения", async () => {
    exitTauri();
    const err = (await invokeIfTauri("vault_put_blob", {}).catch((e) => e)) as Error;
    expect(err.message).toContain("desktop app");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
