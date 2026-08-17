import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { registrarSupportsNsApi } from "./registrarCaps";
import {
  API_PROVIDERS,
  apiKeyLabel,
  apiUserField,
  hasApi,
  needsApiUser,
  needsClientIp,
  normalizeProvider,
  providerMeta,
  buildProviderList,
} from "./registrarProviders";

describe("registrarProviders — API-способность", () => {
  it("hasApi: только каталожные провайдеры, без учёта регистра", () => {
    expect(hasApi("hostiq")).toBe(true);
    expect(hasApi("Namecheap")).toBe(true);
    expect(hasApi("godaddy")).toBe(false);
    expect(hasApi("")).toBe(false);
  });

  it("hasApi: пробелы НЕ схлопывает — их не срезает и десктоп", () => {
    // `make_service` делает только `to_lowercase()`, поэтому `" Namecheap "` для
    // него — `unknown provider`. Признай мы такую строку API-шной, Settings дал
    // бы бейдж «API» и кнопку Test там, где карточка домена уже показывает
    // выключенный «Set NS», а за кнопкой ждёт гарантированный отказ.
    expect(hasApi("  Namecheap ")).toBe(false);
    expect(hasApi(" hostiq")).toBe(false);
  });

  it("needsClientIp: только Namecheap", () => {
    expect(needsClientIp("namecheap")).toBe(true);
    expect(needsClientIp("HOSTIQ")).toBe(false);
    expect(needsClientIp("godaddy")).toBe(false);
    expect(needsClientIp("")).toBe(false);
  });

  it("needsClientIp: не спрашивает поле там, где hasApi говорит «нет»", () => {
    expect(hasApi(" namecheap ")).toBe(false);
    expect(needsClientIp(" namecheap ")).toBe(false);
  });

  it("normalizeProvider: нижний регистр и trim (ключ показа, не ответ десктопа)", () => {
    expect(normalizeProvider("  Hostiq ")).toBe("hostiq");
  });
});

describe("registrarProviders — состав учётки: API User и подпись секрета", () => {
  /**
   * Живая проверка боевым токеном: настоящий API Hostiq — DI-API v3, вся
   * авторизация в одном заголовке `X-Authorization-Token`. Email в запрос не
   * уходит, значит и спрашивать его нельзя: поле, которое никуда не едет,
   * называет пользователю ложную причину отказа регистратора.
   */
  it("needsApiUser: только Namecheap — Hostiq авторизуется одним токеном", () => {
    expect(needsApiUser("namecheap")).toBe(true);
    expect(needsApiUser("Namecheap")).toBe(true);
    expect(needsApiUser("hostiq")).toBe(false);
    expect(needsApiUser("HOSTIQ")).toBe(false);
  });

  it("needsApiUser: у ручного и неизвестного провайдера полей API не бывает", () => {
    for (const manual of ["godaddy", "GoDaddy", "", null, undefined]) {
      expect(needsApiUser(manual), String(manual)).toBe(false);
    }
  });

  it("needsApiUser: пробелы НЕ схлопывает — такого провайдера десктоп не знает", () => {
    // Тот же гейт `hasApi`, что у `needsClientIp`: у провайдера, которому форма
    // отказала в бейдже «API», не спрашивают НИ ОДНОГО поля учётки.
    expect(hasApi(" namecheap ")).toBe(false);
    expect(needsApiUser(" namecheap ")).toBe(false);
    expect(needsApiUser(" hostiq ")).toBe(false);
  });

  it("apiKeyLabel: как поле называется у самого регистратора", () => {
    // В личном кабинете Hostiq нет ничего с названием «API key» — есть токен
    // DI-API. Подпись формы обязана совпадать с тем, что человек ищет глазами.
    expect(apiKeyLabel("hostiq")).toBe("API token");
    expect(apiKeyLabel("HOSTIQ")).toBe("API token");
    expect(apiKeyLabel("namecheap")).toBe("API key");
    expect(apiKeyLabel("Namecheap")).toBe("API key");
  });

  it("apiKeyLabel: у провайдера без API — общее имя, а не пустая строка", () => {
    // Отсюда подпись уходит в `labels` хука, а тот собирает из неё «… is
    // required». Пустая строка дала бы сообщение, начинающееся с пробела.
    for (const manual of ["godaddy", " hostiq ", "", null, undefined]) {
      expect(apiKeyLabel(manual), String(manual)).toBe("API key");
    }
  });
});

describe("registrarProviders — подсказки поля API User", () => {
  /**
   * Последнее место, где страница знала регистраторов по именам: подпись и
   * плейсхолдер поля выбирались тернарником по `needsClientIp` — то есть
   * «нужен ли Client IP» работало прокси для «это Namecheap». Сегодня это не
   * врёт (в каталоге ровно два провайдера, Client IP ровно у одного), но третий
   * Rust-клиент с whitelist получил бы чужой `your_namecheap_username`, а без
   * whitelist — чужой `admin@hostiq.ua`. Подсказки живут в каталоге, рядом с
   * остальным показом.
   */
  it("подсказки берутся у провайдера, а не выводятся из другой способности", () => {
    expect(apiUserField("Namecheap")).toEqual({ suffix: "", placeholder: "your_namecheap_username" });
  });

  it("у кого поля нет — у того нет и подсказок: Hostiq, ручной, битый ввод", () => {
    // Hostiq здесь стоит рядом с ручным провайдером намеренно: подсказки
    // гейтятся тем же `needsApiUser`, что решает про само поле. Оставь мы ему
    // прежний `admin@hostiq.ua` — и первый читатель принял бы живой плейсхолдер
    // за указание вернуть поле, которого у DI-API v3 не бывает.
    for (const noField of ["hostiq", "HOSTIQ", "GoDaddy", " hostiq ", "", null, undefined]) {
      expect(apiUserField(noField), String(noField)).toEqual({ suffix: "", placeholder: "" });
    }
  });
});

describe("registrarProviders — согласие с десктопом", () => {
  /**
   * Держит каталог от дрейфа так же, как `registrarCaps.test.ts` держит зеркало
   * предиката: список `make_service` читается из исходника с диска. Без этого
   * теста третий регистратор, добавленный в десктоп, покрасил бы только
   * `registrarCaps.test.ts`, а `API_PROVIDERS` молча остался бы с двумя
   * записями — и у нового провайдера не было бы ни полей секретов, ни «Test».
   *
   * Пути от файла теста, а не от `process.cwd()`, и через `fileURLToPath` —
   * причины те же, что в `registrarCaps.test.ts`.
   */
  const HERE = dirname(fileURLToPath(import.meta.url));
  const RUST_SOURCE = resolve(HERE, "../../../desktop/src-tauri/src/registrars/mod.rs");

  function providersIn(source: string): string[] {
    const text = readFileSync(source, "utf8");
    const declaration = /NS_API_PROVIDERS[^=]*=\s*\[([^\]]*)\]/.exec(text);
    if (!declaration) {
      throw new Error(`NS_API_PROVIDERS не найден в ${source} — объявление переименовали?`);
    }
    return [...declaration[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  }

  it("каждый провайдер десктопа имеет запись в каталоге показа", () => {
    const rust = providersIn(RUST_SOURCE);
    expect(rust.length).toBeGreaterThan(0);
    for (const provider of rust) {
      expect(
        Object.prototype.hasOwnProperty.call(API_PROVIDERS, provider),
        `провайдер ${provider} есть в make_service, но не в API_PROVIDERS`,
      ).toBe(true);
    }
  });

  it("каждый ключ каталога признаётся предикатом registrarCaps", () => {
    // Обратная сторона: запись в каталоге без Rust-клиента дала бы поля секретов
    // и кнопку Test под провайдером, которого десктоп не умеет.
    for (const key of Object.keys(API_PROVIDERS)) {
      expect(registrarSupportsNsApi(key), `провайдер ${key}`).toBe(true);
      expect(hasApi(key), `провайдер ${key}`).toBe(true);
    }
  });
});

describe("registrarProviders — метаданные показа", () => {
  it("API-провайдер: метка и флаг из каталога", () => {
    const m = providerMeta("namecheap");
    expect(m.label).toBe("Namecheap");
    expect(m.api).toBe(true);
    expect(m.icon).toBe("N");
  });

  it("ручной провайдер: метка = ввод, буква = первая, api=false, без '?'", () => {
    const m = providerMeta("GoDaddy");
    expect(m.label).toBe("GoDaddy");
    expect(m.api).toBe(false);
    expect(m.icon).toBe("G");
  });

  it("ручной провайдер: цвет детерминирован по имени", () => {
    expect(providerMeta("GoDaddy").bg).toBe(providerMeta("godaddy").bg);
  });

  it("каталожное имя с пробелами — ручная ветка, как и у десктопа", () => {
    // Не «сломано», а честно: `" hostiq "` десктоп не знает, поэтому ни бейджа
    // «API», ни кнопки Test. Метка при этом подчищена — она про показ.
    const m = providerMeta(" hostiq ");
    expect(m.api).toBe(false);
    expect(m.key).toBe("hostiq");
    expect(m.label).toBe("hostiq");
    expect(m.icon).toBe("H");
  });

  it("пустой ввод: фолбэк в '?', а не в undefined", () => {
    for (const empty of ["", "   "]) {
      const m = providerMeta(empty);
      expect(m.api).toBe(false);
      expect(m.key).toBe("");
      expect(m.label).toBe("?");
      expect(m.icon).toBe("?");
      expect(m.bg).toBeTruthy();
      expect(m.color).toBeTruthy();
    }
  });

  it("raw: строка как она пришла — чтобы показ мог объяснить, почему провайдер ручной", () => {
    // Метка тримлена (она идёт в список и в дедуп), и из-за этого символ, из-за
    // которого аккаунт понижен в правах, из UI исчезал: на карточке стояло
    // `hostiq` с чипом manual, и это читалось как «приложение неправильно
    // определило мой Hostiq». `raw` держит исходник для показа причины.
    expect(providerMeta(" hostiq ").raw).toBe(" hostiq ");
    expect(providerMeta(" hostiq ").label).toBe("hostiq"); // метка чистая, как была
    expect(providerMeta("namecheap").raw).toBe("namecheap");
    expect(providerMeta(null).raw).toBe("");
  });

  it("null/undefined: та же '?'-мета, что у пустой строки — функция показа обязана вернуть", () => {
    // Колонка `provider` НЕ nullable (`nullable=False`, схема ответа
    // `provider: str`) — терпимость здесь не про штатный `null` от сервера, а
    // про битый или частичный ответ и `undefined` у недособранного объекта.
    // Зовут `providerMeta` внутри `map` по списку аккаунтов без error boundary:
    // брось она здесь, и одна порченая строка уносила бы всю вкладку
    // Registrars, а не одну карточку. Терпимость к «не знаем провайдера» у предиката
    // (`registrarSupportsNsApi`) уже есть по той же причине; страховка на каждом
    // месте вызова — это её отсутствие, размазанное по вызывающим.
    const blank = providerMeta("");
    for (const empty of [null, undefined]) {
      expect(() => providerMeta(empty)).not.toThrow();
      expect(providerMeta(empty)).toEqual(blank);
    }
  });

  it("hasApi/needsClientIp тоже принимают null/undefined — и это «не умеет»", () => {
    for (const empty of [null, undefined]) {
      expect(hasApi(empty)).toBe(false);
      expect(needsClientIp(empty)).toBe(false);
    }
  });

  it("имя из прототипа объекта не уходит в API-ветку", () => {
    // `provider` — свободный ввод, а `"constructor"`/`"__proto__"`/`"valueOf"`
    // есть у любого объектного литерала: обычная индексация вернула бы «запись»
    // с `label: undefined` в аватаре.
    for (const name of ["constructor", "__proto__", "valueOf", "toString"]) {
      const m = providerMeta(name);
      expect(m.api, name).toBe(false);
      expect(m.label, name).toBe(name);
      expect(m.icon, name).toBe(name[0].toUpperCase());
      expect(needsClientIp(name), name).toBe(false);
      expect(hasApi(name), name).toBe(false);
    }
  });

  it("имя вне BMP: буква — целая кодовая точка, а не половина суррогата", () => {
    expect(providerMeta("🚀Reg").icon).toBe("🚀");
  });
});

describe("registrarProviders — список для выпадашки", () => {
  it("сначала API-каталог, затем уникальные ручные из аккаунтов", () => {
    const list = buildProviderList([
      { provider: "GoDaddy" },
      { provider: "godaddy" }, // дубль по регистру — не повторяем
      { provider: "hostiq" },  // уже в каталоге — не повторяем
    ]);
    const keys = list.map((o) => o.key);
    expect(keys.slice(0, 2)).toEqual(["hostiq", "namecheap"]); // каталог первым
    expect(keys.filter((k) => k === "godaddy").length).toBe(1);
    expect(list.find((o) => o.key === "godaddy")?.api).toBe(false);
  });

  it("ноль аккаунтов: только API-каталог", () => {
    expect(buildProviderList([]).map((o) => o.key)).toEqual(["hostiq", "namecheap"]);
  });

  it("каталожная запись остаётся API-шной, даже если в аккаунтах она с пробелами", () => {
    // Дедуп идёт по нормализованному ключу, поэтому `" hostiq "` из аккаунта
    // схлопывается с каталожным `hostiq` и НЕ подменяет его ручной записью.
    const list = buildProviderList([{ provider: " hostiq " }, { provider: "HOSTIQ" }]);
    expect(list.map((o) => o.key)).toEqual(["hostiq", "namecheap"]);
    expect(list[0].api).toBe(true);
    expect(list[0].label).toBe("Hostiq");
  });

  it("битая запись в списке не роняет выпадашку и не заводит пункт-призрак", () => {
    // Единственное место модуля, куда терпимость сначала не дошла: карточка
    // такого аккаунта рисовалась, а клик по «+ Add Registrar» падал на
    // `normalizeProvider(null)` — форма добавления не открывалась вовсе. Путь
    // отказа новый: до фичи форма списка аккаунтов не получала вообще.
    const list = buildProviderList([{ provider: null }, { provider: undefined }, { provider: "" }]);
    expect(list.map((o) => o.key)).toEqual(["hostiq", "namecheap"]);
  });

  it("у ручного провайдера побеждает метка первого встреченного аккаунта", () => {
    // Написание в колонке произвольное; фиксируем правило, чтобы порядок списка
    // не менял подпись пункта молча.
    const list = buildProviderList([{ provider: "godaddy" }, { provider: "GoDaddy" }]);
    const manual = list.filter((o) => !o.api);
    expect(manual.map((o) => o.label)).toEqual(["godaddy"]);
  });
});
