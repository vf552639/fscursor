import { useState } from "react";

import {
  FullSetupNotice,
  FullSetupReport,
  FullSetupTarget,
  bulkFullSetup,
  newDomainFullSetup,
  summarizeFullSetup,
  summarizeFullSetupFailure,
} from "../api/fullSetup";
import { runExclusive, useRunPending } from "../api/runGate";
import { FullSetupPlan } from "../lib/fullSetupPlan";
import { useLiveOrAway } from "./useLiveOrAway";

/**
 * Ключ заявки «идёт полная настройка». Приём и его причины — в `runExclusive`.
 *
 * Ключ ОДИН на оба входа (массовое действие и мастер), но занимает его только
 * массовый: см. `runBulk`/`runForNewDomain`.
 */
const FULL_SETUP_KEY = ["domain-full-setup"] as const;

export interface FullSetup {
  /** Итог последнего прогона для баннера страницы; `null` — баннера нет. */
  notice: FullSetupNotice | null;
  dismiss: () => void;
  /** Идёт ли массовый прогон — то есть надо ли гасить его кнопку. */
  pending: boolean;
  /** Массовое действие по выделенным. Ничего не бросает наружу. */
  runBulk: (domainIds: number[], plan: FullSetupPlan & { serverId: number }) => Promise<void>;
  /** Мастер «Add Domain»: домен уже создан, остались шаги десктопа. */
  runForNewDomain: (target: FullSetupTarget, plan: FullSetupPlan) => Promise<void>;
}

/**
 * Полная настройка доменов: прогон, его гейт и итог в одном месте.
 *
 * Свой хук по той же причине, что и `useCloudflareBind`: прогон по сотне
 * доменов идёт минутами и переживает страницу, поэтому «куда показать
 * результат» здесь не деталь реализации, а часть правила. `onAway` — куда
 * отдать итог, если страницы к его появлению уже нет (тост воркспейса).
 */
export function useFullSetup(onAway: (notice: FullSetupNotice) => void): FullSetup {
  /**
   * Итог — на СТРАНИЦЕ, а не тостом наверху, ровно как у привязки: он называет
   * домены этого списка, а в пределе несёт до восьми чисел плюс оговорку про
   * незаписанные зоны — ту часть, которую пропустить нельзя. Тост живёт 2200 мс.
   */
  const [notice, setNotice] = useState<FullSetupNotice | null>(null);
  const { isLive } = useLiveOrAway();
  const pending = useRunPending(FULL_SETUP_KEY);

  const dismiss = () => setNotice(null);

  /**
   * Итог живому экземпляру — в баннер, мёртвому — наверх тостом.
   *
   * Правила «чей баннер важнее» здесь нет, в отличие от привязки, и это разница
   * по существу: там фоновая автопривязка могла затереть отчёт, которого
   * человек дождался, нажав кнопку. Здесь фоновых прогонов не бывает вовсе — оба
   * входа это явное действие пользователя, и последний отчёт отвечает на
   * последний заданный вопрос.
   */
  const deliver = (next: FullSetupNotice) => {
    if (isLive()) setNotice(next);
    else onAway(next);
  };

  /**
   * Прогнать и рассказать. Ничего не бросает наружу: оба входа зовутся через
   * `void`, то есть отказ стал бы unhandled rejection, а пользователь —
   * получил бы молчание вместо отчёта. Штатные полууспехи сюда не доходят: они
   * приезжают строками отчёта (см. `FullSetupReport`).
   */
  const report = async (produce: () => Promise<FullSetupReport>) => {
    // Гасим прежний итог сразу: числа предыдущей пачки над идущим прогоном
    // читаются как отчёт о нём.
    setNotice(null);
    try {
      deliver(summarizeFullSetup(await produce()));
    } catch (e) {
      deliver(summarizeFullSetupFailure(e));
    }
  };

  const runBulk = (domainIds: number[], plan: FullSetupPlan & { serverId: number }) =>
    // Гейт занимает ТОЛЬКО массовый прогон: он идёт минутами, а его кнопка —
    // единственный вход, который можно нажать дважды подряд.
    runExclusive(FULL_SETUP_KEY, () => report(() => bulkFullSetup(domainIds, plan)));

  /**
   * Мастер гейтом НЕ связан — та же причина, по которой им не связана
   * автопривязка (см. `useCloudflareBind`): домен, заведённый во время массовой
   * настройки, молча остался бы без зоны, то есть ровно тем доменом, ради
   * которого мастер и открывали. Прогоны друг другу не мешают: зона в
   * Cloudflare заводится по имени и не дублируется, а домены у них разные.
   */
  const runForNewDomain = (target: FullSetupTarget, plan: FullSetupPlan) =>
    report(() => newDomainFullSetup(target, plan));

  return { notice, dismiss, pending, runBulk, runForNewDomain };
}
