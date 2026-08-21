import React from "react";

import { OpenInDesktop } from "./OpenInDesktop";
import { Btn } from "./ui/Primitives";
import { CF_SYNC_TITLE, CF_SYNC_VERB } from "../lib/cfZoneMatch";
import { isTauri } from "../lib/runtime";
import { tokens } from "../lib/designTokens";

function idsQuery(ids: number[]): string {
  return ids.length ? `?ids=${ids.map((n) => String(n)).join(",")}` : "";
}

/**
 * Полоса действий над выделенными строками: появляется вместе с выделением и
 * исчезает вместе с ним.
 *
 * Своего нижнего отступа компонент НЕ несёт, и это контракт, а не упущение:
 * расстояние до соседа держит колонка страницы (`gap` у контейнера в
 * `pages/Domains`). Здесь `marginBottom: 12` пережил переход на `gap` и давал
 * под выделением 28px там, где у шапки, чипов, фильтров и трёх баннеров ровно
 * 16 — то есть ритм страницы менялся от того, выделена строка или нет. Вернуть
 * отступ сюда — значит отдать блоку расстояние, которое принадлежит промежутку:
 * оно останется висеть, когда блок окажется последним или единственным на
 * экране.
 */
export default function BulkActionToolbar({
  selectedCount,
  selectedDomainIds = [],
  onAssignServer,
  onAssignCF,
  onSyncCloudflare,
  onFullSetup,
  onProvision,
  onDelete,
  syncPending,
  fullSetupPending,
  provisionPending,
}: {
  selectedCount: number;
  /** Selected domain IDs for `sdmp://…?ids=` deep links on web. */
  selectedDomainIds?: number[];
  onAssignServer: () => void;
  onAssignCF: () => void;
  /**
   * Найти зоны Cloudflare по именам выделенных доменов и проставить привязку.
   * Обязателен, хотя кнопка рисуется только в десктопе: кнопка без обработчика
   * — это кнопка, которая молчит, а такую от сломанной не отличить.
   */
  onSyncCloudflare: () => void;
  /**
   * Открыть диалог полной настройки выделенных. Обязателен по той же причине,
   * что и `onSyncCloudflare`: кнопка без обработчика неотличима от сломанной.
   */
  onFullSetup: () => void;
  onProvision: () => void;
  onDelete: () => void;
  /**
   * Идёт ли прогон привязки. Гасит ТОЛЬКО кнопку синхрона (здесь и в шапке
   * вкладки — прогон у них общий), но не соседей — см. `provisionPending`.
   *
   * Обязателен, в отличие от `provisionPending`: тот гасит кнопку, у которой
   * своя защита от второго клика видна пользователю (модалка запуска), а
   * забытый здесь означал бы живую кнопку на весь прогон — клик по ней гейт
   * остановит молча, и это неотличимо от сломанной кнопки.
   */
  syncPending: boolean;
  /**
   * Идёт ли полная настройка. Гасит ТОЛЬКО свою кнопку — как `provisionPending`
   * и по той же причине: соседние действия к чужому прогону отношения не имеют.
   *
   * Обязателен, в отличие от `provisionPending`: у полной настройки нет второго
   * барьера вроде модалки подтверждения, и забытый признак означал бы живую
   * кнопку на весь прогон — клик по ней гейт остановит молча.
   */
  fullSetupPending: boolean;
  /**
   * Идёт ли массовый provision. Гасит ТОЛЬКО свою кнопку.
   *
   * Раньше здесь был общий `pending`, гасивший заодно «Assign Server» и «Assign
   * CF». Пока он складывался из трёх HTTP-мутаций, которые отвечали 404 за
   * миллисекунды, этого никто не видел. Теперь признак живёт в `MutationCache`,
   * держится весь прогон (десятки минут), переживает навигацию и истинен даже
   * для прогона, запущенного ссылкой по СОВЕРШЕННО ДРУГИМ доменам, — то есть
   * пользователь вернулся бы на страницу, выделил три чужих домена и увидел две
   * мёртвые кнопки без единого объяснения рядом с живой «Delete».
   */
  provisionPending?: boolean;
}) {
  if (selectedCount <= 0) return null;

  const q = idsQuery(selectedDomainIds);
  const webBulkDisabled = !isTauri() && selectedDomainIds.length === 0;

  return (
    <div
      style={{
        background: tokens.surface.cardHeader,
        border: `1px solid ${tokens.border.card}`,
        borderRadius: 10,
        padding: "10px 16px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: tokens.text.ink }}>{selectedCount} selected</span>
      <OpenInDesktop
        action={`assign-server${q}`}
        label="Assign Server"
        desktopOnClick={onAssignServer}
      />
      <OpenInDesktop
        action={`assign-cf${q}`}
        label="Assign CF"
        desktopOnClick={onAssignCF}
      />
      {/* Не `OpenInDesktop`, и это выбор, а не пропущенная унификация: в вебе
          действие невозможно даже теоретически — почему, разобрано у самого
          прогона (`api/cfAutoBind.ts`, «ТОЛЬКО десктоп»).
          CTA «открыть в десктопе» под него потребовал бы нового хоста в
          `parseDeepLinkAction` (`lib/deepLink.ts`), а хост, которого там нет, —
          это ссылка в никуда: ровно те кнопки, которые на этой ветке удалены
          («Set NS», «Refresh SSL»). Поэтому в вебе кнопки просто нет — так же,
          как у «Full setup» ниже.

          Подпись — тот же глагол, что у кнопки в шапке вкладки (`CF_SYNC_VERB`,
          он же в подсказке строки), и разнится только областью. Действие за
          обеими одно (`useCloudflareBind`): два разных имени на одно действие
          означали бы, что прочитавший подсказку ищет на экране слово, которого
          там два — и ни одно не совпадает. */}
      {isTauri() ? (
        <Btn
          variant="secondary"
          size="sm"
          onClick={onSyncCloudflare}
          disabled={syncPending}
          title={CF_SYNC_TITLE}
        >
          {syncPending ? "Syncing…" : `${CF_SYNC_VERB} selected`}
        </Btn>
      ) : null}
      {/* Массового «Set NS» здесь намеренно нет: `POST /domains/bulk-set-ns` на
          бэкенде не существует, а `sdmp://set-ns` не разбирает
          parseDeepLinkAction — кнопка вела в никуда в обеих средах. Смена NS
          пачкой — это не проброс кнопки: команде `registrar_set_nameservers`
          нужен свой список NS на каждый домен (у каждого — своя зона
          Cloudflare, возможно в другом аккаунте) плюс отчёт по каждому. Это
          отдельная функция со своим планом, а не достижимость. NS одного домена
          ставятся на его карточке, рядом с аккаунтом Cloudflare. */}
      {/* «Check NS» и «Mark NS Set» удалены следом за «Set NS» и по той же
          причине: роутов `POST /domains/{id}/check-ns` и `/mark-ns-set` на
          бэкенде не существует. Массовый вариант был вдобавок хуже одиночного —
          `Promise.all(ids.map(mutateAsync))` без `catch` давал на 50 доменах 50
          штук 404 и unhandled rejection. */}
      {/* «Refresh SSL» удалён по той же причине, что и «Set NS» выше: роута
          `POST /domains/{id}/refresh-ssl` на бэкенде нет, а `sdmp://refresh-ssl`
          не разбирает `parseDeepLinkAction` — кнопка вела в никуда в обеих
          средах. Перевести её на Tauri сегодня нечем: SSL — это отдельная
          SSH-операция без своей команды. Функция со своим планом, а не проброс
          кнопки.

          «Full setup» ниже — вернувшаяся, а не та же самая: прежняя звала
          несуществующий `POST /domains/bulk-full-setup`. Теперь связки делает
          `POST /domains/full-setup`, а зону и NS — команда `domain_full_setup`
          в десктопе. Отсюда и десктоп-онли: в вебе выполнять шаги нечем, а
          CTA «открыть в десктопе» потребовал бы хоста в `parseDeepLinkAction`,
          которого там нет, — то есть ссылки в никуда (см. синхрон выше). */}
      {isTauri() ? (
        <Btn
          variant="secondary"
          size="sm"
          onClick={onFullSetup}
          disabled={fullSetupPending}
          title="Bind the selected domains to a server and a Cloudflare account, create the zone and (optionally) set NS"
        >
          {fullSetupPending ? "Setting up…" : "Full setup"}
        </Btn>
      ) : null}
      <OpenInDesktop
        action={`bulk-provision${q}`}
        label="Provision"
        desktopOnClick={onProvision}
        disabled={Boolean(provisionPending) || webBulkDisabled}
      />
      <div style={{ marginLeft: "auto" }}>
        <OpenInDesktop action={`bulk-delete${q}`} label="Delete" variant="danger" desktopOnClick={onDelete} />
      </div>
    </div>
  );
}
