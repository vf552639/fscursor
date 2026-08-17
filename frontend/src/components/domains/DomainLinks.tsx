import React from "react";

import { Domain } from "../../api/domains";
import { Zone } from "../../api/cloudflare";
import { Server } from "../../api/servers";
import DomainCloudflareField from "./DomainCloudflareField";
import DomainRegistrarField from "./DomainRegistrarField";

/** Приглушённый текст пояснения — тот же тон, что у подписей внутри плашек. */
const NOTE_TEXT = "#6b7280";
/** «Требует внимания, но не отказ» — тот же янтарь, что у соседних полей карточки. */
const WARN_TEXT = "#b45309";

/**
 * Плашка одной связи. Фон, рамка и радиус — те же, что у прочих врезок продукта
 * (`DesktopOnlyNote`, `CloudflareUnreadBanner`, списки id в отчёте прогона):
 * своя четвёртая редакция «серого прямоугольника» отличалась бы от них ровно
 * настолько, чтобы это читалось как недосмотр.
 *
 * `minWidth: 0` — плашка это grid-элемент, а его минимальная ширина по
 * умолчанию равна ширине содержимого: без этого длинное имя аккаунта в селекте
 * распирало бы колонку, а не упиралось в неё.
 *
 * Своего ВИДИМОГО заголовка у плашки нет намеренно. Заголовок ей уже даёт первое
 * слово содержимого — `Registrar:` / `Cloudflare:` / `Server:`, — и второй такой
 * же над ним печатал бы одно слово дважды в каждой из трёх плашек. Ровно тот
 * дубль, ради снятия которого карточка и пересобрана.
 *
 * А вот `role="group"` с тем же именем плашка получает: глазами границу задаёт
 * фон с рамкой, для скринридера же ряд без ролей — сплошная лента из трёх
 * селектов и пяти подписей, по которой нельзя ни перескочить связь целиком, ни
 * понять, к какой из них относится строка-диагноз под селектом. Имя здесь
 * ДУБЛИРУЕТ видимый ярлык намеренно: это не вторая подпись на экране, а та же
 * самая, поднятая до имени группы.
 */
function Plate({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        minWidth: 0,
        background: "#f9fafb",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: "10px 12px",
        fontSize: 13,
        color: "#374151",
      }}
    >
      {children}
    </div>
  );
}

/**
 * Сервер домена — read-only, и это решение, а не недоделка: сервер домену
 * назначает развёртывание, а не карточка. Селект здесь обещал бы, что сайт
 * переедет от выбора в выпадашке, тогда как переехало бы только поле в базе.
 *
 * Три состояния, и все три названы:
 *
 * - сервера нет вовсе (`server_id === null`) — домен ещё не разворачивали;
 * - сервер есть в списке — имя и адрес (тот же адрес показан как FTP Host в
 *   «Server state», и берётся он из того же объекта, а не из второго чтения);
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
      {/* Значение — своим узлом, а не голым текстом рядом с ярлыком, по двум
          причинам сразу. `overflowWrap` ему нужен так же, как ноте под ним:
          имя сервера пишет пользователь, и «prod-cluster-eu-central-1-web-07»
          без единого пробела вылезло бы из плашки шириной в треть модалки. А
          отдельный узел даёт спросить ЗНАЧЕНИЕ отдельно от подписи — иначе
          проверка «печатаем сырой id вместо молчаливого прочерка» читает весь
          `textContent` строки вместе с нотой, где тот же id уже назван, и
          проходит, даже если значение подменить прочерком. */}
      <b>Server:</b>{" "}
      <span style={{ overflowWrap: "anywhere" }}>
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
 */
export default function DomainLinks({ domain, server, zone, zones, zonesError }: DomainLinksProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: 12,
        marginTop: 14,
      }}
    >
      <Plate label="Registrar">
        <DomainRegistrarField domain={domain} />
      </Plate>
      <Plate label="Cloudflare">
        <DomainCloudflareField domain={domain} zone={zone} zones={zones} zonesError={zonesError} />
      </Plate>
      <Plate label="Server">
        <ServerLink serverId={domain.server_id} server={server} />
      </Plate>
    </div>
  );
}
