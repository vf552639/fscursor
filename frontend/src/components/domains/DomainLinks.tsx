import React from "react";

import { Domain } from "../../api/domains";
import { Zone } from "../../api/cloudflare";
import { Server } from "../../api/servers";
import DomainCloudflareField from "./DomainCloudflareField";
import DomainRegistrarField from "./DomainRegistrarField";
import { SectionCard } from "../ui/Primitives";
import { CardRow } from "./tabs/TabLayout";

/** Приглушённый текст пояснения — тот же тон, что у подписей внутри карточек. */
const NOTE_TEXT = "#6b7280";
/** «Требует внимания, но не отказ» — тот же янтарь, что у соседних полей карточки. */
const WARN_TEXT = "#b45309";

/**
 * Сервер домена — read-only, и это решение, а не недоделка: сервер домену
 * назначает развёртывание, а не карточка. Селект здесь обещал бы, что сайт
 * переедет от выбора в выпадашке, тогда как переехало бы только поле в базе.
 *
 * Три состояния, и все три названы:
 *
 * - сервера нет вовсе (`server_id === null`) — домен ещё не разворачивали;
 * - сервер есть в списке — имя и адрес (тот же адрес показан как FTP Host в
 *   карточке FTP на вкладке Server, и берётся он из того же объекта, а не из
 *   второго чтения);
 * - `server_id` стоит, а сервера в списке нет — печатаем сырой id и говорим об
 *   этом. Молчаливый прочерк на его месте выдавал бы существующую связь за её
 *   отсутствие (то же правило, что у поля регистратора).
 */
function ServerLink({ serverId, server }: { serverId: number | null; server: Server | undefined }) {
  const note = (color: string, text: string) => (
    <div style={{ fontSize: 12, color, marginTop: 3, overflowWrap: "anywhere" }}>{text}</div>
  );
  return (
    <div>
      {/* Значение — своим узлом, а не голым текстом в теле карточки, по двум
          причинам сразу. `overflowWrap` ему нужен так же, как ноте под ним:
          имя сервера пишет пользователь, и «prod-cluster-eu-central-1-web-07»
          без единого пробела вылезло бы из карточки шириной в треть модалки. А
          отдельный узел даёт спросить ЗНАЧЕНИЕ отдельно от подписи — иначе
          проверка «печатаем сырой id вместо молчаливого прочерка» читает весь
          `textContent` строки вместе с нотой, где тот же id уже назван, и
          проходит, даже если значение подменить прочерком. */}
      <span style={{ overflowWrap: "anywhere", fontSize: 14, fontWeight: 600, color: "#0f172a" }}>
        {serverId == null ? "— Not assigned —" : (server?.name ?? serverId)}
      </span>
      {serverId == null
        ? note(NOTE_TEXT, "A domain gets its server when it is deployed.")
        : server
          ? server.ip_address
            ? note(NOTE_TEXT, server.ip_address)
            : null
          : note(WARN_TEXT, `Server #${serverId} is not in the loaded list.`)}
    </div>
  );
}

export interface DomainLinksProps {
  domain: Domain;
  /** Сервер домена, найденный в списке страницы; `undefined` — не найден. */
  server: Server | undefined;
  /** Зона домена: `undefined` — зоны ещё не прочитаны, `null` — её нет. */
  zone: Zone | null | undefined;
  /** Все зоны выбранного аккаунта Cloudflare — по ним идёт дорезолв по имени. */
  zones: Zone[] | undefined;
  zonesError: unknown;
}

/**
 * Ряд связей домена: Registrar → Cloudflare → Server.
 *
 * Порядок не декоративный — это путь запроса к домену: у регистратора прописаны
 * nameservers, они ведут в зону Cloudflare, зона ведёт на сервер. Прежний верх
 * карточки был двумя колонками «слева про домен, справа про сервер», то есть
 * просто переносом строки посреди списка, и разорванная на них цепочка
 * заставляла собирать ответ «почему домен не открывается» из двух мест.
 *
 * Три равные колонки (`minmax(0, 1fr)`, а не `1fr`) — потому что внутри стоят
 * селекты и чужие имена аккаунтов: у `1fr` минимум равен ширине содержимого, и
 * самая длинная строка растащила бы ряд.
 *
 * Своей логики у ряда ровно столько, сколько её у сервера (read-only три
 * состояния): регистратор и Cloudflare — готовые поля, каждое со своим
 * селектом, своей записью и своей строкой-подписью.
 *
 * Плашка связи стала `SectionCard` — общим паттерном карточки макета, — и
 * `Plate` вместе с ней исчез. Заголовок у карточки теперь ВИДИМЫЙ
 * (шапка-полоска `REGISTRAR` / `CLOUDFLARE` / `SERVER`), и это единственная
 * причина, по которой из полей ушло первое слово содержимого (`Registrar:` /
 * `Cloudflare:` / `Server:`): рядом с титулом оно печатало бы одно слово дважды
 * в каждой из трёх карточек — ровно тот дубль, ради снятия которого карточка
 * домена и пересобрана. Никакой другой правки поля не получили: селект,
 * дорезолв зоны, строка-диагноз и ошибка записи остались чем были.
 *
 * `role="group"` с именем карточки при этом не потерян — его даёт сам
 * `SectionCard` через `aria-labelledby` на свой `<h3>`, и причина та же, что
 * была у плашки: без ролей ряд читается скринридером сплошной лентой из трёх
 * селектов и пяти подписей, в которой не понять, к какой связи относится
 * строка-диагноз под селектом.
 */
export default function DomainLinks({ domain, server, zone, zones, zonesError }: DomainLinksProps) {
  return (
    // Ряд вкладки, а не свой грид: зазор и дисциплина `minmax(0, 1fr)` живут в
    // `tabs/TabLayout` вместе с объяснением, зачем они нужны.
    <CardRow columns={3}>
      <SectionCard title="Registrar">
        <DomainRegistrarField domain={domain} />
      </SectionCard>
      <SectionCard title="Cloudflare">
        <DomainCloudflareField domain={domain} zone={zone} zones={zones} zonesError={zonesError} />
      </SectionCard>
      <SectionCard title="Server">
        <ServerLink serverId={domain.server_id} server={server} />
      </SectionCard>
    </CardRow>
  );
}
