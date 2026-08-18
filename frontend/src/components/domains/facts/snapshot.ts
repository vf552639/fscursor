import { Domain } from "../../../api/domains";
import { DomainFacts, isFactsStale } from "../../../lib/domainFacts";
import { formatAgoStale } from "../../ui/Primitives";

/** Снимок сервера, разобранный на то, что о нём спрашивают экраны. */
export interface Snapshot {
  /**
   * Факты снимка либо `null`. Читаются ТОЛЬКО вместе со своей отметкой времени:
   * «когда сняли» — часть самого снимка, а не украшение. Бэкенд пишет обе
   * колонки одной транзакцией (`domain_service.record_facts`), так что пара
   * «факты есть, отметки нет» не должна возникать; гейт — чтобы, если она
   * возникнет, экран не сказал «Сервер ещё не читали» и тут же не напечатал эти
   * факты списком аккаунтов. Одна истина вместо двух независимых.
   */
  facts: DomainFacts | null;
  /** Удачного снимка не было ни разу. */
  noSnapshot: boolean;
  /** Снимок есть, но он старше порога `lib/domainFacts`. */
  stale: boolean;
  /** Готовая подпись возраста: «Checked 4h ago · stale» либо «Never checked». */
  freshness: string;
}

/**
 * Разбор снимка — ОДНО правило на все экраны, которые его показывают.
 *
 * Копий было две (вкладка Server и `DomainSslCard`) и стало бы три, когда
 * вкладка Logs попросит ту же тройку. Четыре строки выглядят слишком мелкими,
 * чтобы их собирать, но собраны они как раз потому, что мелкие: в них сидят два
 * решения, которые нельзя принять по-разному дважды — гейт `fp_facts_at` над
 * `fp_facts` (см. `facts`) и то, что свежесть считается от `fp_facts_at` (когда
 * снят снимок), а НЕ от `fp_checked_at` (когда была последняя попытка): иначе
 * протухший снимок молодел бы от проваленной проверки. Ровно так же и по той же
 * причине сюда собран показ полей (`fields.tsx`), а правило расхождения — в
 * `lib/domainDrift`.
 *
 * Живёт здесь, а не в `lib/domainFacts` рядом с `isFactsStale`, по одной
 * механической причине: подпись возраста набирает `formatAgoStale` из
 * `ui/Primitives`, то есть из слоя компонентов, — а `lib` на компоненты не
 * ссылается нигде и не должен начать ради одной строки.
 */
export function snapshotOf(domain: Domain, now: number): Snapshot {
  const noSnapshot = !domain.fp_facts_at;
  const stale = isFactsStale(domain.fp_facts_at, now);
  return {
    facts: noSnapshot ? null : domain.fp_facts ?? null,
    noSnapshot,
    stale,
    freshness: domain.fp_facts_at
      ? `Checked ${formatAgoStale(domain.fp_facts_at, stale, now)}`
      : "Never checked",
  };
}
