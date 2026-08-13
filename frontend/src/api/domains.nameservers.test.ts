import { describe, it, expect } from "vitest";

import { MIN_NAMESERVERS, normalizeNameservers } from "./domains";
import { normalizeZoneName } from "../lib/cfZoneMatch";

/**
 * Список NS перед отправкой регистратору.
 *
 * Проверяется отдельно от карточки, потому что предмет проверки — правило, а не
 * разметка: тот же список, который эта функция готовит к ОТПРАВКЕ, соседние
 * модули приводят к сравнимому виду для СВЕРКИ (`lib/nsDelegation`,
 * `lib/cfZoneMatch`) и десктоп — для чтения ответа регистратора (`normalize_ns`
 * в `registrars/mod.rs`). Разъехавшись, эти правила дают худшее: порог
 * «минимум два» проходит, а регистратор получает один сервер дважды и отвечает
 * отказом, который оседает в `ns_status: error`.
 */

describe("normalizeNameservers", () => {
  // Копипаста из зонного файла — обычный способ заполнить это поле, а
  // `ns1.x.com.` в нём законная запись FQDN. Для сверки такая строка и
  // `ns1.x.com` — ОДИН сервер; значит и для отправки тоже.
  it("«ns1.x.com.» и «ns1.x.com» — один сервер, а не два", () => {
    const out = normalizeNameservers(["ns1.x.com.", "ns1.x.com"]);
    expect(out).toEqual(["ns1.x.com"]);
    // И порог не проходит: отправлять по-прежнему нечего.
    expect(out.length < MIN_NAMESERVERS).toBe(true);
  });

  it("срезает точку и у того имени, что уезжает регистратору", () => {
    // Десктоп шлёт список как есть (`set_nameservers`), а прочитанный обратно
    // нормализует, — оставленная точка означала бы FQDN, отправленный в одной
    // форме и сверяемый в другой.
    expect(normalizeNameservers(["ns1.x.com.", "ns2.x.com."])).toEqual(["ns1.x.com", "ns2.x.com"]);
  });

  it("регистр первого вхождения сохраняет: схлопывает повтор, а не «чинит» ввод", () => {
    expect(normalizeNameservers(["NS1.Hoster.net", "ns1.hoster.net.", "ns2.hoster.net"])).toEqual([
      "NS1.Hoster.net",
      "ns2.hoster.net",
    ]);
  });

  it("выбрасывает пустое и пробелы по краям", () => {
    expect(normalizeNameservers([" ns1.x.com ", "", "   ", "\tns2.x.com\t"])).toEqual([
      "ns1.x.com",
      "ns2.x.com",
    ]);
  });

  // Правило схлопывания — буквально то же, которым сверяется делегирование.
  // Копия, знающая про регистр, но не про точку, у нас уже была.
  it("считает дубли тем же правилом, что и сверка", () => {
    for (const raw of ["ns1.x.com.", " NS1.X.com ", "ns1.x.com..", "NS1.x.com."]) {
      const out = normalizeNameservers([raw, "ns1.x.com"]);
      // Схлопнулось в одно — и это «одно» отличается от сравнимого вида ровно
      // регистром: он единственное, что путь отправки бережёт намеренно.
      expect(out).toHaveLength(1);
      expect(out[0].toLowerCase()).toBe(normalizeZoneName(raw));
    }
  });
});
