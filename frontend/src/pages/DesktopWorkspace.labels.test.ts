import { describe, it, expect } from "vitest";
import { AUDIT_ACTION_LABEL, FASTPANEL_STEP_LABEL, PROVISION_STEP_LABEL } from "./DesktopWorkspace";

/**
 * Слушатели `fastpanel:progress` / `provision:progress` молча выбрасывают шаги,
 * которых нет в этих таблицах. Значит, шаг, добавленный в Rust, но забытый
 * здесь, не виден пользователю вообще — а `writeback_failed` сообщает ровно то,
 * о чём молчать нельзя: работа сделана, но на сервере не записана.
 */
describe("таблицы шагов прогресса", () => {
  it("знают writeback_failed в обоих каналах", () => {
    expect(FASTPANEL_STEP_LABEL.writeback_failed).toBeTruthy();
    expect(PROVISION_STEP_LABEL.writeback_failed).toBeTruthy();
  });

  it("текст writeback_failed говорит и об успехе работы, и о незаписанном результате", () => {
    for (const label of [
      FASTPANEL_STEP_LABEL.writeback_failed,
      PROVISION_STEP_LABEL.writeback_failed,
    ]) {
      expect(label).toMatch(/not (be )?(saved|recorded|written)/i);
      expect(label.toLowerCase()).toMatch(/installed|provisioned/);
    }
  });

  it("покрывают все шаги, которые шлёт Rust по каналу fastpanel:progress", () => {
    for (const step of [
      "ssh_connect",
      "updating",
      "installing",
      "creds_unparsed",
      "audit_failed",
      "writeback_failed",
    ]) {
      expect(FASTPANEL_STEP_LABEL[step], `нет текста для шага ${step}`).toBeTruthy();
    }
  });

  // Тот же слушатель `audit:progress` разводит теперь два шага, и оба молча
  // выбрасывают действие, которого нет в таблице. `registrar.ns_set` шлют оба:
  // и audit_best_effort, и провал write-back'а `ns_status`.
  it("знает все действия, которые шлёт Rust по каналу audit:progress", () => {
    for (const action of [
      "cf.zone.create",
      "cf.dns.create",
      "cf.dns.update",
      "cf.dns.delete",
      "cf.cache_purge",
      "registrar.ns_set",
    ]) {
      expect(AUDIT_ACTION_LABEL[action], `нет названия для действия ${action}`).toBeTruthy();
    }
  });
});
