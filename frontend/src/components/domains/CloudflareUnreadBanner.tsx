import React from "react";

import { CloudflareAccount } from "../../api/cloudflare";

/**
 * Аккаунты Cloudflare, чьи зоны прочитать не удалось, — строкой над таблицей.
 *
 * Существует ради честности прочерка: подсказка в колонке Cloudflare берётся из
 * живых зон, и аккаунт со сломанным токеном в сопоставлении не участвует. Без
 * этой строки «—» у домена, чья зона лежит именно там, читалось бы как
 * «Cloudflare нет» — то есть отсутствие измерения нарисовалось бы знанием.
 *
 * Тон намеренно тихий (`status`, а не `alert`, серым, без ✕): это не событие, а
 * состояние — оно исчезнет само, когда токен починят, и перебивать им чтение
 * списка не за что. Событийный отчёт о привязке рядом громче и со своим
 * крестиком — у него другой предмет (`CloudflareBindBanner`).
 */
export default function CloudflareUnreadBanner({ accounts }: { accounts: CloudflareAccount[] }) {
  return (
    <div
      role="status"
      style={{marginBottom:12,padding:"8px 12px",borderRadius:8,fontSize:12.5,background:"#f9fafb",color:"#6b7280",border:"1px solid #e5e7eb"}}
    >
      Cloudflare: {accounts.length} account(s) could not be read ({accounts.map((a) => a.name).join(", ")}) — matches from them are not shown.
    </div>
  );
}
