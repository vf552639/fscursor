/**
 * Правила формы полной настройки домена — отдельно от самих форм.
 *
 * Форм две (мастер «Add Domain» и массовый диалог), правила у них общие, а
 * проверять их надо без DOM: «какой тумблер живой», «в каком порядке идут
 * серверы» и «что из формы вообще исполнимо» — это решения, а не разметка. Тот
 * же приём, что у `lib/cfZoneMatch.ts` и `lib/domainStatus.ts`.
 */

import { registrarSupportsNsApi } from "./registrarCaps";

/** Значения формы — строками, как их отдаёт `<select>`. Пусто = «не выбрано». */
export interface FullSetupForm {
  serverId: string;
  cloudflareAccountId: string;
  registrarId: string;
  /** Заводить ли зону в Cloudflare (и вообще запускать ли шаги десктопа). */
  createZone: boolean;
  pushNs: boolean;
}

export const EMPTY_FULL_SETUP_FORM: FullSetupForm = {
  serverId: "",
  cloudflareAccountId: "",
  registrarId: "",
  createZone: false,
  pushNs: false,
};

/**
 * Что реально будет сделано — форма, из которой уже вычтено невозможное.
 *
 * Отдельный тип от `FullSetupForm`, потому что дизейбл тумблера в разметке —
 * это про UX, а не про факт. Пользователь мог включить «Прописать NS», а потом
 * сменить регистратора на того, у кого нет API: тумблер погас, но значение
 * `true` осталось бы лежать в стейте и уехало бы в команду. Правда о прогоне
 * собирается здесь, один раз, и оба входа берут её отсюда.
 */
export interface FullSetupPlan {
  /**
   * `null` — сервер не выбран. Допустимо только в мастере: массовому диалогу
   * сервер обязателен (его требует схема бэкенда).
   */
  serverId: number | null;
  cloudflareAccountId: number;
  registrarId: number | null;
  /** Идти ли в Cloudflare за зоной. `false` — прогон ограничен связками. */
  createZone: boolean;
  /** Прописывать ли NS зоны у регистратора. Возможен только вместе с зоной. */
  pushNs: boolean;
}

/** Состояние тумблера: живой ли он и что написано под ним. */
export interface ToggleRule {
  enabled: boolean;
  /** Подпись под тумблером — она же объяснение, почему он погас. */
  hint: string;
}

/**
 * Можно ли заводить зону.
 *
 * Зону заводит Tauri-команда: токен Cloudflare расшифровывается на клиенте, и
 * HTTP-роута под это нет и не будет. В вебе тумблер живым быть не может —
 * иначе он обещал бы работу, которой там не существует.
 */
export function zoneToggleRule(desktop: boolean, cloudflareAccountId: string): ToggleRule {
  if (!desktop) {
    return { enabled: false, hint: "Зону заводит десктоп — веб только показывает." };
  }
  if (!cloudflareAccountId) {
    return { enabled: false, hint: "Выберите аккаунт Cloudflare — зону нужно где-то заводить." };
  }
  // Про «не продублируем» сказано прямо: это первый вопрос человека, у которого
  // часть доменов уже заведена в Cloudflare руками.
  return {
    enabled: true,
    hint: "Домен заводится зоной в выбранном аккаунте. Если зона уже есть, вторая не создаётся.",
  };
}

/**
 * Можно ли прописать NS у регистратора.
 *
 * Порядок проверок повторяет порядок причин в десктопе (`ns_plan` в
 * `commands/full_setup.rs`): сперва то, что решил пользователь, потом то, чем
 * нечем работать. Иначе подпись называла бы причиной не то, что ею было.
 */
export function nsToggleRule(params: {
  desktop: boolean;
  createZone: boolean;
  registrarId: string;
  /** Провайдер ВЫБРАННОГО аккаунта регистратора; `null` — аккаунт не выбран. */
  registrarProvider: string | null;
}): ToggleRule {
  if (!params.desktop) {
    return { enabled: false, hint: "NS прописывает десктоп — веб только показывает." };
  }
  if (!params.createZone) {
    // NS берутся у зоны, а не из воздуха: без шага зоны прописывать нечего.
    // Ровно этим отвечает и десктоп — `zone_unavailable`.
    return { enabled: false, hint: "NS берутся у зоны Cloudflare — включите её создание." };
  }
  if (!params.registrarId) {
    return { enabled: false, hint: "Выберите регистратора — команду отдавать некому." };
  }
  if (!registrarSupportsNsApi(params.registrarProvider)) {
    return { enabled: false, hint: "У регистратора нет API — пропишите NS вручную." };
  }
  return { enabled: true, hint: "NS созданной зоны уедут регистратору: делегирование сменится сразу." };
}

/**
 * Значение `<select>` → id. `null` — не выбрано ИЛИ выбрано нечисловое.
 *
 * Одна воронка на все три поля, потому что дальше по пути их различают только
 * по `== null`: и отказ запуска в `Domains.tsx`, и решение «идти ли к
 * регистратору». Голый `Number("")` даёт `0`, `Number("x")` — `NaN`, и NaN
 * проверку на `null` проходит, а в теле запроса становится `null`
 * (`JSON.stringify`) — то есть 422 на всю пачку без единого слова о причине.
 * Сегодня из `<select>` такое не приходит; воронка стоит затем, чтобы это
 * оставалось правдой и после первого поля, набираемого руками.
 */
function numericId(raw: string): number | null {
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

/**
 * Форма → план прогона. `null` — исполнять нечего: аккаунт Cloudflare не
 * выбран, а без него не сделать ни связку, ни зону.
 *
 * Тумблеры здесь ещё раз проходят через те же правила, что гасят их в
 * разметке, — см. `FullSetupPlan`: погасший тумблер значения не сбрасывает.
 */
export function planFromForm(
  form: FullSetupForm,
  ctx: { desktop: boolean; registrarProvider: string | null },
): FullSetupPlan | null {
  const cloudflareAccountId = numericId(form.cloudflareAccountId);
  if (cloudflareAccountId == null) return null;
  const registrarId = numericId(form.registrarId);
  const createZone = form.createZone && zoneToggleRule(ctx.desktop, form.cloudflareAccountId).enabled;
  const pushNs =
    form.pushNs &&
    nsToggleRule({
      desktop: ctx.desktop,
      createZone,
      registrarId: form.registrarId,
      registrarProvider: ctx.registrarProvider,
    }).enabled;
  return {
    serverId: numericId(form.serverId),
    cloudflareAccountId,
    registrarId,
    createZone,
    pushNs,
  };
}

/** Пункт выпадашки: сколько доменов уже на этом сервере / в этом аккаунте. */
export interface LoadedOption {
  id: number;
  name: string;
  count: number;
  /** Готовая подпись пункта: имя плюс нагрузка. */
  label: string;
}

/**
 * Русское склонение для счётчика. «1 доменов» в подписи, которую человек читает
 * каждый раз, выбирая сервер, — это опечатка, живущая вечно.
 */
function domainWord(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 14) return "доменов";
  const ones = n % 10;
  if (ones === 1) return "домен";
  if (ones >= 2 && ones <= 4) return "домена";
  return "доменов";
}

/**
 * Сервера (или аккаунты Cloudflare) в порядке «наименее загруженные сверху».
 *
 * Считаем домены ИЗ СПИСКА SDMP, а не живые зоны/сайты: список уже в руках
 * (`useDomains`), стоит ноль запросов и одинаково работает в вебе. Это оценка
 * нагрузки, а не инвентаризация чужой машины, — и в подписи она названа
 * доменами, а не сайтами.
 *
 * При равной нагрузке — по имени: порядок пунктов не должен зависеть от того,
 * в каком порядке их вернул API, иначе список прыгает между открытиями формы.
 */
export function optionsByLoad<T extends { id: number; name: string }, D>(
  items: ReadonlyArray<T>,
  domains: ReadonlyArray<D>,
  pick: (domain: D) => number | null | undefined,
): LoadedOption[] {
  const counts = new Map<number, number>();
  for (const domain of domains) {
    const id = pick(domain);
    if (id == null) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return items
    .map((item) => {
      const count = counts.get(item.id) ?? 0;
      return { id: item.id, name: item.name, count, label: `${item.name} — ${count} ${domainWord(count)}` };
    })
    .sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
}
