import React from "react";

import { CfBindNotice } from "../../api/cfAutoBind";

/**
 * Итог привязки к зонам Cloudflare над таблицей.
 *
 * `alert` только у полууспеха (тот же порог, что у тостов воркспейса):
 * «привязано 3 из 3» перебивать чтение экрана незачем, а «одно совпало в двух
 * аккаунтах» — это то, ради чего человек и читает эту строку.
 *
 * Гасится кнопкой, а не таймером и не сменой выделения: при создании домена
 * выделение вообще ни при чём, а исчезнувшая через две секунды строка с пятью
 * числами — это строка, которую не успели прочитать.
 */
export default function CloudflareBindBanner({
  notice,
  onDismiss,
}: {
  notice: CfBindNotice;
  onDismiss: () => void;
}) {
  return (
    <div
      role={notice.kind === "warn" ? "alert" : "status"}
      style={{marginBottom:12,padding:"10px 12px",borderRadius:8,fontSize:13,display:"flex",alignItems:"flex-start",gap:10,background:notice.kind === "warn" ? "#fffbeb" : "#eff4ff",color:notice.kind === "warn" ? "#92400e" : "#1e40af"}}
    >
      <span style={{flex:1}}>{notice.kind === "warn" ? "⚠" : "✓"} {notice.text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss Cloudflare match result"
        style={{background:"none",border:"none",padding:0,cursor:"pointer",color:"inherit",font:"inherit",lineHeight:1}}
      >
        ✕
      </button>
    </div>
  );
}
