import React from "react";

import { clip } from "../../../api/cfAutoBind";
import { Domain } from "../../../api/domains";
import { Zone } from "../../../api/cloudflare";
import { Server } from "../../../api/servers";
import { SslState } from "../../../lib/domainFacts";
import { NsDelegation } from "../../../lib/nsDelegation";
import { Badge, SectionCard } from "../../ui/Primitives";
import DomainLinks from "../DomainLinks";
import DomainNsPanel, { NsDelegationPill, NsDraft } from "../DomainNsPanel";
import DomainSslCard from "../DomainSslCard";

/**
 * `ssl_status` — НАША запись момента provision, и на карточке она печатается
 * только тогда, когда иначе экран об этом промолчит.
 *
 * Значений у колонки четыре (`SslStatus`, `backend/app/core/constants.py`):
 * `none`, `pending`, `active`, `error`; плюс `null` у строк, заведённых до
 * появления колонки. Здесь названы два, и вот почему остальные — нет.
 *
 * - **`error` — обязателен.** Сегодня это единственное состояние домена, которое
 *   ВИДНО В СПИСКЕ (красный бейдж «SSL error»), но на экране диагностики не
 *   упомянуто ни разу: `ssl_expires_at` и `ssl_issuer` у такого домена пусты,
 *   поэтому «Server state» о нём молчит; бейдж сводки считает `sslState` по
 *   снимку с сервера и у непроверенного домена говорит «Not checked»; а
 *   `last_provision_error` write-back провижининга в этот момент ЯВНО ГАСИТ в
 *   `null` и текст certbot на сервер не отправляет вовсе
 *   (`desktop/.../commands/provision.rs`, `domain_write_back_body`). То есть
 *   человек кликает по красной строке выяснить причину — и не находит даже
 *   упоминания провала.
 * - **`pending` — тоже.** Список красит его жёлтым, а значит он «выпуск идёт»;
 *   но завершать его после возврата команды некому (там же), то есть это
 *   застрявший прогон, а не процесс. Сегодня этого значения не пишет никто —
 *   оно достижимо из строк, заведённых прежними версиями, и через
 *   `PUT /domains/{id}`. Проглотить его молча значило бы повторить ровно тот
 *   дефект, который чинит эта строка.
 * - **`active` — нет.** Успех прошлого прогона уже представлен на карточке, и
 *   именно там, где ему место: `ssl_expires_at` и `ssl_issuer` стоят в «Server
 *   state» приглушёнными, с подписью «из provision, на сервере не проверено»
 *   (`lib/domainDrift`). Третье утверждение о том же успехе, да ещё рядом с
 *   серым бейджем сводки, ничего не добавляет — и уж точно не поднимает нашу
 *   запись до факта: зелёным на этой карточке отвечает только измерение.
 * - **`none` / `null` — нет.** Список говорит серое «— No SSL», карточка — серое
 *   «Not checked»; они согласны, объяснять нечего.
 *
 * Ярлык нарочно называет ИСТОЧНИК («at provision»), а не предмет: строкой выше
 * стоит `SSL:` сводки, и два ответа про сертификат рядом обязаны отличаться не
 * значением, а тем, кто их дал — сервер или наш прошлый прогон.
 */
const SSL_PROVISION_ALARM: Record<string, string> = {
  error: "the last provision run did not issue a certificate",
  pending: "issuance was started and never finished",
};

export interface DomainOverviewTabProps {
  domain: Domain;
  /** Сервер домена, найденный в списке страницы; `undefined` — не найден. */
  server: Server | undefined;
  /** Зона домена: `undefined` — зоны ещё не прочитаны, `null` — её нет. */
  zone: Zone | null | undefined;
  zones: Zone[] | undefined;
  zonesError: unknown;
  /** Состояние сертификата, посчитанное модалкой один раз на всю карточку. */
  ssl: SslState;
  /** «Сейчас» карточки: один раз на рендер, общее для всех её сроков. */
  now: number;
  delegation: NsDelegation;
  zoneNameservers: string[];
  /** Черновик поля NS: живёт в модалке, чтобы пережить переключение вкладок. */
  nsDraft: NsDraft;
  registrarProvider: string | null | undefined;
}

/**
 * Вкладка Overview — «куда домен привязан и куда он смотрит».
 *
 * Раскладка макета: ряд связей Registrar → Cloudflare → Server (путь запроса к
 * домену), под ним наша запись о прошлых прогонах, затем два ответа про
 * настоящее — сертификат и делегирование, — и заглушка DMCA.
 *
 * **Cloudflare и nameservers стоят на ОДНОЙ вкладке, и это не случайность
 * раскладки.** Аккаунт с зоной и поле NS — один вопрос («куда домен делегирован
 * и почему не туда»): пустое поле NS с погасшей кнопкой почти всегда следствие
 * нерезолвнутой зоны, и разведённые по двум экранам причина и следствие
 * читаются как две независимые поломки. Прежняя карточка вкладки потеряла в том
 * числе поэтому; новые их не возвращают.
 *
 * Своей логики у вкладки нет ни строчки — вся раскладка и ни одного расчёта:
 * состояние SSL считает модалка, делегирование — `lib/nsDelegation`, расхождения
 * — `lib/domainDrift`. Единственное её собственное знание — `SSL_PROVISION_ALARM`
 * выше: какой итог прошлого выпуска сертификата стоит называть словами.
 */
export default function DomainOverviewTab({
  domain,
  server,
  zone,
  zones,
  zonesError,
  ssl,
  now,
  delegation,
  zoneNameservers,
  nsDraft,
  registrarProvider,
}: DomainOverviewTabProps) {
  return (
    // Отступ панели по макету — `24px 28px 28px`; горизонтальные 28 и нижние 28
    // уже даёт `Modal` своим `padding`, поэтому здесь остаётся только верхний.
    <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 24 }}>
      <DomainLinks
        domain={domain}
        server={server}
        zone={zone}
        zones={zones}
        zonesError={zonesError}
      />

      <div style={{ fontSize: 13, color: "#374151", display: "grid", gap: 6 }}>
        {/* Наша запись о последней попытке смены NS — не то же самое, что
            живая сверка делегирования ниже: одна говорит, что мы делали,
            вторая — что там на самом деле. Поэтому она и осталась строкой, а
            не пилюлей: пилюль делегирования на одном экране может быть только
            одна. */}
        <div>
          <b>NS:</b> {`${domain.ns_status ?? "pending"} (${domain.ns_check_mode ?? "auto"})`}
        </div>
        {/* Итог выпуска сертификата по НАШЕЙ записи — и только тревожный (см.
            `SSL_PROVISION_ALARM`). Без этой строки список и карточка отвечали
            про SSL по-разному: строка таблицы красила домен красным «SSL
            error», а открытая с неё карточка про провал не говорила вовсе. */}
        {domain.ssl_status && SSL_PROVISION_ALARM[domain.ssl_status] ? (
          <div>
            <b>SSL at provision:</b> {domain.ssl_status} —{" "}
            {SSL_PROVISION_ALARM[domain.ssl_status]}
          </div>
        ) : null}
        {/* Только когда он есть. Пустая строка «Last error: —» обещает
            поломку, которой нет, — а прочерк здесь ещё и не отличить от
            «ошибку мы потеряли».

            `clip` и перенос по любому месту — потому что текст тут ЧУЖОЙ: это
            ответ FastPanel или трассировка, осевшая в колонке домена. Без
            обрезки одна такая строка вытесняет карточку вниз, без
            `overflowWrap` длинный путь или URL без пробелов уезжает за край
            (тот же приём, что у ошибок записи в полях ряда связей). */}
        {domain.last_provision_error ? (
          <div style={{ overflowWrap: "anywhere" }}>
            <b>Last error:</b> {clip(domain.last_provision_error)}
          </div>
        ) : null}
      </div>

      {/* `minmax(0, 1fr)`, а не `1fr`: голый `1fr` — это `minmax(auto, 1fr)`, и
          минимум трека равен ширине содержимого, поэтому один неразрывный токен
          (имя издателя, чужая ошибка, длинный nameserver) распирает колонку за
          ширину модалки. У `Modal` стоит `overflowY: auto`, из-за чего
          `overflow-x` вычисляется в `auto` — распёртая колонка даёт КАРТОЧКЕ
          горизонтальную полосу, запрещённую `design-brief.md` §11. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14 }}>
        <DomainSslCard domain={domain} ssl={ssl} now={now} />
        <SectionCard title="Nameservers" right={<NsDelegationPill delegation={delegation} />}>
          <DomainNsPanel
            domain={domain}
            draft={nsDraft}
            zoneNameservers={zoneNameservers}
            zonesError={zonesError}
            delegation={delegation}
            registrarProvider={registrarProvider}
          />
        </SectionCard>
      </div>

      {/* DMCA — заглушка из самого макета, и единственная честная её форма:
          жалоб DMCA продукт сегодня не знает вовсе — ни модели, ни поля, ни
          команды. Пилюля `COMING SOON` и одна фраза вместо выдуманного списка:
          мёртвая таблица с кнопкой «Submit» обещала бы функцию, которой нет
          (принцип №6 CLAUDE.md — незнание называется словом). */}
      <SectionCard title="DMCA" right={<Badge variant="gray">COMING SOON</Badge>}>
        <div style={{ fontSize: 13, color: "#94a3b8" }}>
          DMCA complaints and takedown status for this domain will appear here in a future update.
        </div>
      </SectionCard>
    </div>
  );
}
