import { useState, useRef, useEffect } from "react";

import { runBulkProvisionDomains, BulkProvisionOutcome } from "../api/domains";
import { describeBulkProvision } from "../components/domains/describeBulkProvision";
import { DomainUI } from "../components/domains/types";
import { confirmAction } from "../lib/confirmDialog";
import { useAuthStore } from "../store/auth";
import { useLiveOrAway } from "./useLiveOrAway";

export interface BulkProvision {
  /**
   * Причина, по которой прогон не начался. Живёт ровно столько, сколько живёт
   * набор, на котором случился отказ (см. эффект по `selected`), — а не 2200 мс
   * и не до следующего рендера.
   */
  error: string | null;
  /** Запустить прогон по текущему выделению. Ничего не бросает наружу. */
  run: () => Promise<void>;
}

/**
 * Массовый provision выделенных доменов: подтверждение, запуск и доставка того,
 * что вернулось.
 *
 * Свой хук по той же причине, что и `useCloudflareBind`: операция идёт минутами
 * и переживает страницу, поэтому «куда показать результат» здесь — не деталь
 * реализации, а часть правила.
 *
 * Гейт «идёт ли прогон» сюда НЕ переехал: он читается из `MutationCache` одной
 * подпиской вместе с подоменным признаком (`isProvisioning`), и вторая подписка
 * с тем же фильтром пересчитывала бы по два снимка на каждое изменение кэша.
 */
export function useBulkProvision({
  domains,
  selected,
  onResult,
  onErrorAway,
  onSetSpent,
}: {
  /** Весь список — из него берутся ИМЕНА доменов для текста подтверждения. */
  domains: DomainUI[];
  selected: Set<number>;
  /**
   * Куда отдать отчёт. Всегда наверх: в нём лежит пароль FTP каждого
   * отработавшего домена, и показывает их воркспейс, переживающий уход со
   * страницы.
   */
  onResult: (outcome: BulkProvisionOutcome) => void;
  /** Куда отдать причину отказа, если страницы к её возврату уже нет. */
  onErrorAway: (message: string) => void;
  /** Прогон удался целиком — набор больше не нужен. */
  onSetSpent: () => void;
}): BulkProvision {
  // Отказ запуска обязан быть виден: «уже провижинится», «только десктоп» и
  // отказ самой команды — это ответ на вопрос «почему ничего не произошло».
  const [error, setError] = useState<string | null>(null);
  // Жива ли ещё страница к моменту, когда вернулся отказ. Отказ приходит через
  // секунды после клика, а страница размонтируется на любой навигации — без
  // этой развилки текст уходил бы в стейт мёртвого компонента, то есть в
  // никуда (см. проп `onBulkProvisionError` страницы).
  const { deliver } = useLiveOrAway();
  // Открыт ли диалог подтверждения массового прогона. Первое, что делает клик, —
  // это `await` (загрузка чанка плагина плюс сам диалог), поэтому до ответа
  // пользователя кнопка ничем не занята и выглядит незалипшей: второй клик по
  // «неотзывчивой» кнопке открывал второй диалог. Подтвердив оба, пользователь
  // получал запущенный прогон И красный баннер «уже провижинится» над ним —
  // выполнялся набор при этом ровно один раз (подоменный гейт), врал только UI.
  const confirmingRef = useRef(false);

  // Причина отказа привязана к набору, на котором он случился: «Provisioning of
  // #1, #2 is already running» после снятия галочек с #1 и #2 говорит уже не про
  // то, что пользователь видит перед собой.
  useEffect(() => {
    setError(null);
  }, [selected]);

  /**
   * Массовый provision — через Tauri-команду `provision_bulk`, тем же путём,
   * что и ссылка `sdmp://bulk-provision` (см. `lib/deepLink.ts`). Прежний
   * `POST /domains/bulk-provision` на бэкенде не существует: кнопка всегда
   * давала 404, то есть обещала функцию, которой нет.
   *
   * Не прямой `invokeSynced`, а `runBulkProvisionDomains` — по тем же двум
   * причинам, что и у ссылки: только он отдаёт наружу результат КАЖДОГО домена
   * (пароль FTP существует только там) и только он занимает подоменный гейт в
   * `MutationCache`, из-за чего ⚙ строки и ссылка не откроют вторую SSH-сессию
   * по домену из набора.
   *
   * Результат не через `mutate`: возврат `mutationFn` react-query кладёт в
   * `data` `MutationCache`, откуда его не убирает даже `reset()`. Паролям там
   * не место, поэтому отчёт уезжает прямым вызовом пропа.
   */
  const run = async () => {
    // Тот же источник, что у `useSetNameservers`: id пользователя нужен команде,
    // чтобы расшифровать креды сервера.
    const userId = useAuthStore.getState().userId;
    setError(null);
    if (!userId) {
      setError("Not signed in — sign in again to run provisioning.");
      return;
    }
    const targets = Array.from(selected);
    // Спрашиваем, как спрашивают массовое удаление и как спрашивает
    // `sdmp://bulk-provision`: один клик запускает часы необратимой работы на
    // чужих машинах (site + FTP-аккаунт + certbot на каждом домене), остановить
    // прогон нечем, а идемпотентность после него пометит набор отработавшим —
    // то есть промах по «Assign Server» стоил бы и лишнего прогона, и
    // возможности повторить правильный.
    //
    // Домены названы ИМЕНАМИ, а не id, как в тексте ссылки: имя — это то, чем
    // пользователь их выбирал. Длинный список урезаем: диалог, который нельзя
    // прочитать, закрывают не читая.
    //
    // Второй клик, пока висит диалог, — это тот же клик, а не второй запуск:
    // спрашивать одно и то же дважды не о чем.
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    let confirmed: boolean;
    try {
      confirmed = await confirmAction(describeBulkProvision(domains, targets));
    } finally {
      confirmingRef.current = false;
    }
    if (!confirmed) return;
    // Команда адресует домены строками.
    const ids = targets.map(String);
    try {
      const outcome = await runBulkProvisionDomains(userId, ids);
      // Отчёт отдаём ПЕРВЫМ действием после ответа: всё остальное здесь —
      // косметика стейта, а он существует в единственном экземпляре.
      onResult(outcome);
      // Снимаем выделение только с полностью удавшегося прогона. У оборвавшегося
      // хвост (`skipped`) назван поимённо ровно затем, чтобы повторить прогон по
      // нему, — а повторять его пользователю пришлось бы, заново разыскивая
      // домены в списке на двести строк.
      if (outcome.status === "ok") onSetSpent();
    } catch (e) {
      // «Provisioning of #N is already running.», «только десктоп» и отказ самой
      // команды — всё это обязано доехать до пользователя: молчащая кнопка
      // неотличима от сломанной. Куда именно — зависит от того, жива ли ещё
      // страница: в стейте размонтированной текст умирает так же молча.
      const message = e instanceof Error ? e.message : String(e);
      deliver(
        () => setError(message),
        () => onErrorAway(message),
      );
    }
  };

  return { error, run };
}
