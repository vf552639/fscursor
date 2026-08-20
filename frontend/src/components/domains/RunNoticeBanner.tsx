import React from "react";

/**
 * Итог сообщения о прогоне: `warn` — сделано не всё, о чём просили; `info` —
 * сделано всё либо делать было нечего.
 *
 * Объявлен здесь, а не берётся из `api/*`: баннер рисует итоги двух разных
 * прогонов (привязка к зонам и полная настройка), и общим у них должен быть
 * ровно этот тон, а не чужой тип отчёта.
 */
export interface RunNotice {
  kind: "info" | "warn";
  text: string;
}

/**
 * Итог прогона над таблицей доменов.
 *
 * Один компонент на привязку к Cloudflare и на полную настройку: у них
 * одинаковый предмет (что сделал прогон, которого пользователь дождался) и
 * одинаковые правила показа. Две копии этой разметки отличались бы только
 * `aria-label`, а разъезжались бы — тоном.
 *
 * `alert` только у полууспеха (тот же порог, что у тостов воркспейса):
 * «привязано 3 из 3» перебивать чтение экрана незачем, а «одно совпало в двух
 * аккаунтах» или «зона есть, а SDMP о ней не знает» — это то, ради чего человек
 * и читает эту строку.
 *
 * Гасится кнопкой, а не таймером и не сменой выделения: при создании домена
 * выделение вообще ни при чём, а исчезнувшая через две секунды строка с пятью
 * числами — это строка, которую не успели прочитать.
 */
export default function RunNoticeBanner({
  notice,
  dismissLabel,
  onDismiss,
}: {
  notice: RunNotice;
  /** Что именно гасит крестик: баннеров над таблицей бывает два сразу. */
  dismissLabel: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role={notice.kind === "warn" ? "alert" : "status"}
      style={{padding:"10px 12px",borderRadius:8,fontSize:13,display:"flex",alignItems:"flex-start",gap:10,background:notice.kind === "warn" ? "#fffbeb" : "#eff4ff",color:notice.kind === "warn" ? "#92400e" : "#1e40af"}}
    >
      <span style={{flex:1}}>{notice.kind === "warn" ? "⚠" : "✓"} {notice.text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={dismissLabel}
        style={{background:"none",border:"none",padding:0,cursor:"pointer",color:"inherit",font:"inherit",lineHeight:1}}
      >
        ✕
      </button>
    </div>
  );
}
