import React from "react";
import { render, renderHook, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, vi, type Mock } from "vitest";

import { useAuthStore } from "../store/auth";

/**
 * Общая оснастка тестов на запись секретов. Заведена до того, как формы
 * FastPanel / регистратора / Cloudflare принесут по своей копии этих трёх
 * штук: `setTauri` уже размножен по файлам, и каждая копия — это шанс, что
 * в одной из них забудут снять флаг в `afterEach`.
 *
 * Фабрики `vi.mock` сюда переехать не могут (hoisting требует file-local
 * хендл от `vi.hoisted`) — всё остальное преамбулы может и должно.
 */

/** Флаг десктопа читает настоящий `isTauri`, поэтому подменяем именно окно. */
export function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/**
 * Ровно то, что вернёт `desktopOnly("Saving secrets")`: фраза на весь продукт
 * одна, и своей формулировки в тесте быть не должно — иначе тест разрешит
 * форме сочинить собственную.
 */
export const DESKTOP_NOTE = "Saving secrets runs in the SDMP desktop app.";

/** Кто пишет блоб: без `userId` `putSecretBlob` бросает «unlock session». */
export const BLOB_USER_ID = "user-1";

/** Пара для `beforeEach`/`afterEach`: стор глобальный и течёт между файлами. */
export function setBlobUser() {
  useAuthStore.setState({ userId: BLOB_USER_ID, email: "u@e.x" });
}

export function clearBlobUser() {
  useAuthStore.getState().clear();
}

/**
 * Преамбула файла тестов на секреты — одним вызовом внутри `describe`. Пара
 * `beforeEach`/`afterEach` была скопирована дословно в каждый файл, и цена
 * копии не в строках: и флаг десктопа (`__TAURI_INTERNALS__` на общем `window`),
 * и `userId` в глобальном сторе переживают файл. Забыть их снять — значит
 * покрасить ЧУЖОЙ тест: он увидит десктоп там, где сам его не включал.
 */
export function secretBlobLifecycle() {
  beforeEach(() => {
    vi.resetAllMocks();
    setBlobUser();
  });

  afterEach(() => {
    cleanup();
    setTauri(false);
    clearBlobUser();
  });
}

/**
 * Формы секретов живут под react-query. `retry: false` — не украшение: с
 * ретраями упавший POST доезжает до формы через задержки, и тест на «ошибка
 * показана, сервер не создан» ловил бы её не с первого прохода.
 */
export function renderWithClient(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/**
 * То же окружение для хука без экрана. Нужно там, где утверждение — про исход
 * САМОЙ мутации: удаление блобов при удалении сущности best-effort, и «провал
 * уборки не сделал удаление проваленным» через страницу не видно вовсе —
 * ошибку такой мутации на этих экранах никто не рисует.
 */
export function renderHookWithClient<T>(hook: () => T) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderHook(hook, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

/** Полный формат: биты версии и варианта — часть id, который уедет в БД. */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Аргументы всех вызовов `vault_put_blob` — для проверок «сколько раз». */
export function putBlobCalls(invokeIfTauri: Mock): Record<string, any>[] {
  return invokeIfTauri.mock.calls
    .filter((c: unknown[]) => c[0] === "vault_put_blob")
    .map((c: unknown[]) => c[1] as Record<string, any>);
}

/**
 * Аргументы единственного вызова. Требование «ровно один» — не строгость ради
 * строгости: второй вызов означает второй блоб на тот же секрет, и без этой
 * проверки такой тест молча смотрел бы на первый.
 */
export function putBlobArgs(invokeIfTauri: Mock): Record<string, any> {
  const calls = putBlobCalls(invokeIfTauri);
  if (calls.length !== 1) throw new Error(`vault_put_blob вызвана ${calls.length} раз, ожидался 1`);
  return calls[0];
}

/** Id, которые форма попросила стереть: удаление сущности снимает и её блобы. */
export function deletedBlobIds(invokeIfTauri: Mock): string[] {
  return invokeIfTauri.mock.calls
    .filter((c: unknown[]) => c[0] === "vault_delete_blob")
    .map((c: unknown[]) => (c[1] as { blobId: string }).blobId);
}
