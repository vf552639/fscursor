import React from "react";

import { STATUS_PILL } from "../../lib/designTokens";
import { domainStatusLabel, domainStatusVariant } from "../../lib/domainStatus";

/**
 * Бейдж статуса домена. Своей карты статусов у него больше нет: она была одной
 * из двух копий лестницы, и обе разошлись с бэкендом на `ns_ok` — домен в
 * штатном статусе получал серый бейдж «мы такого не знаем». Список живёт в
 * `lib/domainStatus`, здесь остаётся только показ.
 *
 * Имя и место — доменные, а не общие: карта статусов у него ровно одна, из
 * `lib/domainStatus`. `StatusBadge` в общем `components/` звал повесить его на
 * сервер или на задачу, а там любой валидный статус получил бы серый бейдж «мы
 * такого не знаем» — то есть ту самую поломку, из-за которой лестница и
 * заведена.
 *
 * Рисует он теперь СВОЮ пилюлю, а не общий `Badge`, и это не дубль примитива.
 * `Badge` держит старую палитру приложения и остаётся на ней намеренно: его
 * рисуют Servers, Cloudflare, Settings и ещё полдесятка экранов, и перекрасить
 * его значило бы протащить редизайн вкладки Domains на всё приложение заодно.
 * Форма же у пилюли макета своя (радиус 99 против 6 у `Badge`, свой шрифт и
 * разрядка), и пропсом её в общий примитив не занести — это был бы `Badge` с
 * переключателем «выглядеть как другой Badge».
 *
 * Цвета — из `STATUS_PILL` (`lib/designTokens`), и ключи там выведены из самой
 * лестницы: добавят вариант — карта перестанет собираться, пока в неё не
 * допишут цвета. Восемь статусов продукта раскладываются по пяти вариантам, и
 * все восемь пилюлю получают — макет назвал цветом три, но домен, чей статус
 * макет не нарисовал, не перестаёт от этого существовать.
 */
export default function DomainStatusBadge({
  status,
  title,
}: {
  status: string;
  title?: string;
}) {
  const c = STATUS_PILL[domainStatusVariant(status)];
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 99,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: ".03em",
        whiteSpace: "nowrap",
        color: c.color,
        background: c.bg,
        border: `1px solid ${c.border}`,
      }}
    >
      {domainStatusLabel(status)}
    </span>
  );
}
