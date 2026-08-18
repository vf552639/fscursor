import React from "react";

import { Domain } from "../../api/domains";
import { sslExpiresSource, sslIssuerSource } from "../../lib/domainDrift";
import { formatExpiryDate } from "../../lib/domainExpiry";
import { SSL_BADGE, SslState } from "../../lib/domainFacts";
import { Badge, SectionCard } from "../ui/Primitives";
import { FactRow, HasSnapshot, KEY_WIDTH, MUTED, RecordedNoteInLegend } from "./facts/fields";
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
 * **Про непрочитанный сервер карточка говорит ОДИН раз — легендой под полями.**
 * Смысл приглушённого значения обязан держаться на словах, а не на сером цвете
 * (его ещё переназначит миграция на токены), но подпись под КАЖДОЙ строкой была
 * бы ровно тем же дефектом с другой стороны: у только что развёрнутого домена
 * — самый частый экран продукта — из provision приезжают и срок, и издатель, то
 * есть одна и та же фраза печаталась бы дважды в десяти пикселях друг от друга,
 * в карточке шириной 389px, под шапкой, где уже стоит «Never checked». Это
 * читается поломкой вёрстки, а не настойчивостью. Поэтому здесь тот же приём,
 * что в секции сервера, только в масштабе карточки: приписки у полей гасятся
 * (`RecordedNoteInLegend`), а сказано всё одной строкой внизу.
 *
 * Легенда — ПО-АНГЛИЙСКИ, в отличие от русской легенды секции сервера, и
 * «выравнивать» её обратно не надо. Правило плана однозначно: новые строки
 * английские, а двуязычие существующих («Проверить на сервере», «Задать
 * пароль», та самая легенда) — отдельный записанный долг, который эта работа не
 * лечит. Overview англоязычна целиком («Never checked», «No certificate on the
 * server.», заглушка DMCA); русская строка на ней углубила бы долг на самом
 * видимом экране, вместо того чтобы удержать его на месте.
 *
 * Пустые поля при этом всё равно прячутся целиком — это `HasSnapshot`, и он про
 * домен, а не про место показа.
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

  /**
   * Печатать ли легенду — и ОДНО выражение на два решения: саму легенду и
   * гашение приписок под полями. Разведи их на два условия, и они разъедутся в
   * одну из двух сторон: легенда без единой приглушённой строки под ней либо
   * приписка у поля вдобавок к легенде, говорящей то же самое.
   *
   * Условие не сводится к `noSnapshot`: у домена, которого мы не читали и про
   * который ничего не записали, обе строки прячутся целиком (`HasSnapshot`), и
   * легенда обещала бы приглушённые значения, которых на экране нет.
   */
  const legend =
    noSnapshot && (src.expires.kind === "recorded-only" || src.issuer.kind === "recorded-only");

  return (
    <SectionCard
      title="SSL"
      right={
        <span style={{ fontSize: 12, color: factsStale ? "#8a8580" : "#6b7280" }}>{freshness}</span>
      }
    >
      <HasSnapshot.Provider value={!noSnapshot}>
        <RecordedNoteInLegend.Provider value={legend}>
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
            {legend ? (
              <div style={{ fontSize: 12, color: MUTED }}>
                Muted values come from provision, not read from the server.
              </div>
            ) : null}
          </div>
        </RecordedNoteInLegend.Provider>
      </HasSnapshot.Provider>
    </SectionCard>
  );
}
