import React from "react";

import { Btn } from "../ui/Primitives";
import { CF_SYNC_TITLE, CF_SYNC_VERB } from "../../lib/cfZoneMatch";
import { tokens } from "../../lib/designTokens";
import { isTauri } from "../../lib/runtime";

/**
 * Вид кнопок шапки в палитре макета — поверх общего `Btn`, а не вместо него.
 *
 * `Btn` рисуют Servers, Cloudflare, Settings и ещё полдесятка экранов, и
 * перекрасить сам примитив значило бы протащить редизайн Domains на всё
 * приложение заодно — правку вида в местах, которых никто не смотрел. Поэтому
 * геометрия и цвет приезжают пропом `style`, а примитив остаётся общим.
 *
 * Две константы, а не общая база с переопределениями: совпадают у них четыре
 * свойства из пяти, но совпадают СЛУЧАЙНО — первичная кнопка тут одна, и
 * стоит макету сделать её крупнее соседей (обычная просьба), как «общая база»
 * начнёт вычитаться, а не складываться. Два честных объекта читаются целиком,
 * каждый на своём месте.
 */
const SECONDARY_BTN: React.CSSProperties = {
  background: tokens.surface.base,
  color: tokens.text.body,
  border: `1px solid ${tokens.border.control}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
  fontWeight: 500,
};

const PRIMARY_BTN: React.CSSProperties = {
  background: tokens.text.ink,
  color: tokens.surface.base,
  border: "1px solid transparent",
  borderRadius: tokens.radius.md,
  fontSize: 13,
  fontWeight: 600,
};

/**
 * Шапка вкладки: сколько всего доменов, синхрон с Cloudflare и три входа для их
 * заведения.
 *
 * Входы те же три, что предлагает `DomainsEmptyState`, и это не дублирование, а
 * одно правило: способов завести домен ровно три, и человек, увидевший их на
 * пустом экране, обязан найти их же на полном.
 *
 * Своего нижнего отступа компонент НЕ несёт, и это контракт, а не упущение:
 * расстояние до соседа держит колонка страницы (`gap` у контейнера в
 * `pages/Domains`). Вернуть сюда `marginBottom` — значит отдать блоку отступ,
 * который принадлежит промежутку: он останется висеть, когда блок окажется
 * последним или единственным на экране.
 */
export default function DomainsHeader({
  total,
  onSyncCloudflare,
  syncPending,
  onFileImport,
  onBulkAdd,
  onAddDomain,
}: {
  total: number;
  /**
   * Привязать к зонам Cloudflare весь список. Обязателен, хотя кнопка рисуется
   * только в десктопе (см. ниже): кнопка без обработчика молчит, а такую от
   * сломанной не отличить.
   */
  onSyncCloudflare: () => void;
  /**
   * Идёт ли прогон привязки — тот же признак, что гасит кнопку по выделенным.
   *
   * Обязателен по той же причине, что и обработчик: забытый означает бодрую
   * кнопку на все десятки секунд прогона, то есть человека, который жмёт её
   * второй раз, решив, что первый клик не сработал. Прогон гейт остановит, но
   * молча — а видит пользователь только неотвечающую кнопку.
   */
  syncPending: boolean;
  onFileImport: () => void;
  onBulkAdd: () => void;
  onAddDomain: () => void;
}) {
  return <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
    <div>
      <h1 style={{fontSize:22,fontWeight:700,color:tokens.text.ink,marginBottom:2}}>Domains</h1>
      <div style={{fontSize:13,color:tokens.text.muted}}>{total} domains total</div>
    </div>
    <div style={{display:"flex",gap:8}}>
      {/* Вход, на который ссылается подсказка в строке (`CF_HINT_TITLE`): он
          обязан быть виден всегда, а не только при выделении, — иначе человек,
          прочитавший подсказку, ищет на экране то, чего там нет. Кнопка по
          выделенным (`BulkActionToolbar`) — то же действие с меньшей областью,
          и подпись у обеих собрана из одного `CF_SYNC_VERB`.

          Глиф `⟳` перед подписью убран по макету — вместе с `⇪` и `⊕` у
          соседей. Сам `CF_SYNC_VERB` при этом трогать нельзя: он держит связку
          с подсказкой в строке и кнопкой в тулбаре, а разъехавшись, они назовут
          одно действие тремя словами.

          Только десктоп: зоны в базе не лежат вовсе — их вживую читает
          Tauri-команда `cf_list_zones`, — почему в вебе действие невозможно
          даже теоретически, разобрано у самого прогона (`api/cfAutoBind.ts`,
          «ТОЛЬКО десктоп»). */}
      {isTauri() ? (
        <Btn
          variant="secondary"
          onClick={onSyncCloudflare}
          disabled={syncPending}
          title={CF_SYNC_TITLE}
          style={SECONDARY_BTN}
        >
          {syncPending ? "Синхронизация…" : `${CF_SYNC_VERB} с Cloudflare`}
        </Btn>
      ) : null}
      <Btn variant="secondary" onClick={onFileImport} style={SECONDARY_BTN}>File Import</Btn>
      <Btn variant="secondary" onClick={onBulkAdd} style={SECONDARY_BTN}>Bulk Add</Btn>
      {/* «+» остаётся: это не декоративный префикс, а единственный на шапке
          знак «здесь заводят новое», и макет его сохраняет. */}
      <Btn variant="primary" onClick={onAddDomain} style={PRIMARY_BTN}>+ Add Domain</Btn>
    </div>
  </div>;
}
