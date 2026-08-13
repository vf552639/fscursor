import { describe, it, expect } from "vitest";

import {
  EMPTY_FULL_SETUP_FORM,
  FullSetupForm,
  nsToggleRule,
  optionsByLoad,
  planFromForm,
  zoneToggleRule,
} from "./fullSetupPlan";

/**
 * Правила формы полной настройки.
 *
 * Проверяются здесь, а не через DOM, ровно потому, что это решения: погасший
 * невпопад тумблер молча отменяет шаг, о котором пользователь просил, а
 * оставшийся живым — обещает работу, которой не будет.
 */

function form(patch: Partial<FullSetupForm> = {}): FullSetupForm {
  return { ...EMPTY_FULL_SETUP_FORM, ...patch };
}

describe("zoneToggleRule", () => {
  it("в вебе мёртв: зону заводит команда десктопа", () => {
    const rule = zoneToggleRule(false, "7");
    expect(rule.enabled).toBe(false);
    expect(rule.hint).toContain("десктоп");
  });

  it("без аккаунта Cloudflare мёртв: зону негде заводить", () => {
    expect(zoneToggleRule(true, "").enabled).toBe(false);
  });

  it("живой тумблер сразу отвечает на вопрос про дубль зоны", () => {
    const rule = zoneToggleRule(true, "7");
    expect(rule.enabled).toBe(true);
    expect(rule.hint).toContain("вторая не создаётся");
  });
});

describe("nsToggleRule", () => {
  const base = { desktop: true, createZone: true, registrarId: "3", registrarProvider: "hostiq" };

  it("умеющий провайдер — тумблер живой", () => {
    expect(nsToggleRule(base).enabled).toBe(true);
  });

  it("провайдер без NS-API — мёртв, и сказано, что делать руками", () => {
    const rule = nsToggleRule({ ...base, registrarProvider: "godaddy" });
    expect(rule.enabled).toBe(false);
    expect(rule.hint).toContain("вручную");
  });

  it("регистратор не выбран — мёртв: команду отдавать некому", () => {
    expect(nsToggleRule({ ...base, registrarId: "", registrarProvider: null }).enabled).toBe(false);
  });

  it("без шага зоны мёртв: NS берутся у неё, а не из воздуха", () => {
    const rule = nsToggleRule({ ...base, createZone: false });
    expect(rule.enabled).toBe(false);
    expect(rule.hint).toContain("зоны Cloudflare");
  });

  // Порядок причин повторяет `ns_plan` в десктопе: выключенный шаг зоны
  // объясняет пропуск полностью, и говорить поверх него про регистратора
  // значило бы называть причиной то, что причиной не было.
  it("причина называется одна — первая по порядку", () => {
    expect(nsToggleRule({ desktop: true, createZone: false, registrarId: "", registrarProvider: null }).hint)
      .toContain("зоны Cloudflare");
  });
});

describe("planFromForm", () => {
  it("без аккаунта Cloudflare исполнять нечего", () => {
    expect(planFromForm(form({ serverId: "1", createZone: true }), { desktop: true, registrarProvider: null }))
      .toBeNull();
  });

  it("собирает план из формы", () => {
    const plan = planFromForm(
      form({ serverId: "1", cloudflareAccountId: "7", registrarId: "3", createZone: true, pushNs: true }),
      { desktop: true, registrarProvider: "namecheap" },
    );
    expect(plan).toEqual({
      serverId: 1,
      cloudflareAccountId: 7,
      registrarId: 3,
      createZone: true,
      pushNs: true,
    });
  });

  // Главное, ради чего план вообще существует отдельно от формы: тумблер гаснет
  // в разметке, а значение `true` остаётся лежать в стейте. Пользователь
  // включил «Прописать NS» на hostiq, а потом переключил регистратора на того,
  // у кого API нет, — команда получила бы `pushNs: true` и упёрлась в
  // `unknown provider`, то есть в красную строку вместо честного пропуска.
  it("гасит шаг, который к моменту запуска стал невозможен", () => {
    const stale = form({
      serverId: "1",
      cloudflareAccountId: "7",
      registrarId: "3",
      createZone: true,
      pushNs: true,
    });
    expect(planFromForm(stale, { desktop: true, registrarProvider: "godaddy" })?.pushNs).toBe(false);
    // Веб не умеет ни того, ни другого — и не выдаёт это за «сделаем».
    const web = planFromForm(stale, { desktop: false, registrarProvider: "hostiq" });
    expect(web?.createZone).toBe(false);
    expect(web?.pushNs).toBe(false);
  });

  it("NS без зоны не остаётся: их неоткуда взять", () => {
    const plan = planFromForm(
      form({ cloudflareAccountId: "7", registrarId: "3", createZone: false, pushNs: true }),
      { desktop: true, registrarProvider: "hostiq" },
    );
    expect(plan?.pushNs).toBe(false);
  });

  it("сервер необязателен: мастер заводит домен и без него", () => {
    expect(planFromForm(form({ cloudflareAccountId: "7" }), { desktop: true, registrarProvider: null })?.serverId)
      .toBeNull();
  });
});

describe("optionsByLoad", () => {
  const servers = [
    { id: 1, name: "beta" },
    { id: 2, name: "alpha" },
    { id: 3, name: "gamma" },
  ];
  const domains = [
    { server_id: 1 },
    { server_id: 1 },
    { server_id: 3 },
    { server_id: null },
  ];

  it("наименее загруженные сверху, при равенстве — по имени", () => {
    const options = optionsByLoad(servers, domains, (d) => d.server_id);
    expect(options.map((o) => o.name)).toEqual(["alpha", "gamma", "beta"]);
    expect(options.map((o) => o.count)).toEqual([0, 1, 2]);
  });

  it("подпись называет нагрузку и склоняет счётчик", () => {
    const options = optionsByLoad(servers, domains, (d) => d.server_id);
    expect(options.map((o) => o.label)).toEqual([
      "alpha — 0 доменов",
      "gamma — 1 домен",
      "beta — 2 домена",
    ]);
  });

  it("считает домены только по своему ключу", () => {
    const cf = optionsByLoad([{ id: 7, name: "main" }], [{ cloudflare_account_id: 7 }, { cloudflare_account_id: null }], (d) => d.cloudflare_account_id);
    expect(cf[0].count).toBe(1);
  });
});
