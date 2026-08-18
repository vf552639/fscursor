import React from "react";

import { Domain } from "../../api/domains";
import { sslExpiresSource, sslIssuerSource } from "../../lib/domainDrift";
import { formatExpiryDate } from "../../lib/domainExpiry";
import { SSL_BADGE, SslState } from "../../lib/domainFacts";
import { Badge, SectionCard } from "../ui/Primitives";
import { FactRow, HasSnapshot, KEY_WIDTH } from "./facts/fields";
import { snapshotOf } from "./facts/snapshot";

/**
 * Сертификат домена — карточка вкладки Overview, вынутая из секции «Server
 * state» вместе со всей её логикой расхождений.
 *
 * Значением поля остаётся ФАКТ с сервера, наша запись из provision всплывает
 * строкой «при развёртывании: X» ровно тогда, когда с ним расходится, и
 * становится приглушённым значением там, где факта нет вовсе. Правило считает
 * `lib/domainDrift`, рисует — общий `FactRow` (`facts/fields`), и обе половины
 * приехали сюда без правок: копия правила рядом с оригиналом разъехалась бы
 * молча.
 *
 * **Свежесть снимка печатается в шапке карточки, а КНОПКИ снятия здесь нет.**
 * Макет ставит «Checked 4h ago · Check on server» только на вкладку Server, а
 * карточку SSL кладёт на Overview — при том что читаются они из ОДНОГО снимка.
 * Кнопка осталась одна (там же, где и была), иначе на карточке домена стало бы
 * два места, снимающих одно и то же; а вот молчать про возраст здесь нельзя:
 * без подписи Overview выдавал бы протухшее измерение за свежее (принцип №6
 * CLAUDE.md).
 *
 * Легенды «Сервер ещё не читали. Приглушённые значения — из provision, на
 * сервере не проверено» на Overview нет, и это осознанно: она принадлежит
 * секции сервера, где над сеткой полей стоит одной строкой на всех. Здесь
 * легенды нет — поэтому подпись печатается У ПОЛЯ, под каждым из двух
 * (`RecordedNoteInLegend` карточка не ставит вовсе). Так смысл приглушённого
 * значения держится на СЛОВАХ, а не на сером цвете, который миграция на токены
 * ещё будет переназначать. Пустые поля при этом всё равно прячутся целиком —
 * это `HasSnapshot`, и он про домен, а не про место показа.
 */
export default function DomainSslCard({
  domain,
  ssl,
  now,
}: {
  domain: Domain;
  /**
   * Состояние сертификата, посчитанное МОДАЛКОЙ (`sslState`). Пропсом, а не
   * своим вызовом: тот же ответ печатает бейдж в шапке карточки, и две
   * независимые копии расчёта совпадали бы ровно до тех пор, пока совпадают
   * аргументы — то есть «сходились бы сами».
   */
  ssl: SslState;
  /** «Сейчас» карточки: один раз на рендер, общее для всех её сроков. */
  now: number;
}) {
  // Разбор снимка — общий (`facts/snapshot`): секция сервера и эта карточка
  // читают ОДИН снимок, и гейт `fp_facts_at` над `fp_facts` вместе с порогом
  // свежести обязаны быть у них одним правилом, а не двумя совпадающими.
  const { facts, noSnapshot, stale: factsStale, freshness } = snapshotOf(domain, now);

  const sslBadge = SSL_BADGE[ssl];
  const src = {
    expires: sslExpiresSource(domain.ssl_expires_at, facts),
    issuer: sslIssuerSource(domain.ssl_issuer, facts),
  };

  return (
    <SectionCard
      title="SSL"
      right={
        <span style={{ fontSize: 12, color: factsStale ? "#8a8580" : "#6b7280" }}>{freshness}</span>
      }
    >
      <HasSnapshot.Provider value={!noSnapshot}>
        {/* `minWidth: 0` — карточка стоит в двухколоночном гриде, а её тело
            печатает чужие строки (издатель сертификата, ответ openssl): без
            этого grid-элемент не сожмётся уже своего содержимого и распёртая
            колонка даст модалке горизонтальную полосу, запрещённую
            `design-brief.md` §11. */}
        <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
          {/* Ключ 84px, а не 80px макета: ширину колонки подписи задаёт общий
              `KEY_WIDTH`, по нему же выравнивается приписка `при
              развёртывании: X` под значением. Своё число здесь развалило бы это
              выравнивание ради четырёх пикселей. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <b style={{ color: "#6b7280", fontWeight: 600, minWidth: KEY_WIDTH }}>State</b>
            <Badge variant={sslBadge.variant}>{sslBadge.label}</Badge>
          </div>
          {/* «Сертификата нет» — отдельное слово, отличимое от «не проверяли». */}
          {ssl === "missing" ? (
            <div style={{ fontSize: 12.5, color: "#b91c1c" }}>No certificate on the server.</div>
          ) : null}
          {/* `overflowWrap` — текст ЧУЖОЙ (ответ openssl/FastPanel), и в нём
              сидит неразрывный токен: без переноса он распирает карточку. */}
          {facts?.ssl.error ? (
            <div style={{ fontSize: 12.5, color: "#b91c1c", overflowWrap: "anywhere" }}>{facts.ssl.error}</div>
          ) : null}
          {/* `ssl.expires_at` — полный datetime: печатаем в зоне ЧИТАТЕЛЯ
              (`formatExpiryDate` сам это решает по форме iso), не в UTC. Иначе
              далеко от UTC дата съедет на день и разойдётся с остальным кодом
              (правило в `domainExpiry.ts`). Наша запись — тем же
              `formatExpiryDate`: сырой ISO под человеческой датой читался бы
              расхождением там, где его нет. */}
          <FactRow
            k="Expires"
            fact={facts?.ssl.expires_at ? formatExpiryDate(facts.ssl.expires_at) : null}
            src={src.expires}
            showRecorded={formatExpiryDate}
          />
          <FactRow k="Issuer" fact={facts?.ssl.issuer} src={src.issuer} />
        </div>
      </HasSnapshot.Provider>
    </SectionCard>
  );
}
