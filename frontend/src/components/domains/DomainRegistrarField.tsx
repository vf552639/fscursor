import React, { ChangeEvent } from "react";

import { clip, errorText } from "../../api/cfAutoBind";
import { Domain, useUpdateDomain } from "../../api/domains";
import { RegistrarAccount, useRegistrarAccounts } from "../../api/registrars";
import { providerMeta } from "../../lib/registrarProviders";
import { ProviderAvatar, ProviderLabel } from "../settings/ProviderVisuals";
import { Sel } from "../ui/Primitives";

/** Приглушённый текст пояснения — тот же тон, что у прочих подписей карточки. */
const NOTE_TEXT = "#6b7280";
/** «Требует внимания, но не отказ» — тот же янтарь, что у соседних полей карточки. */
const WARN_TEXT = "#b45309";
const ERROR_TEXT = "#991b1b";

export interface DomainRegistrarFieldProps {
  domain: Domain;
}

/**
 * Аккаунт регистратора домена: выбор по имени и метка провайдера.
 *
 * Младший брат `DomainCloudflareField` — тот же селект по тем же правилам, но без
 * дорезолва: у регистратора нет второй половины привязки (аналога зоны), и
 * зависимых полей в строке домена у него тоже нет, поэтому смена аккаунта пишет
 * ровно одно поле и ничего не обнуляет.
 *
 * Заведено ради одного разрыва: панель NS внизу той же карточки печатает «Assign
 * a registrar account to this domain first», а назначить его было негде — в поле
 * стояло сырое `registrar_id`. Диагноз без лекарства отправлял человека на
 * другой экран искать, чем починить то, что он видит здесь.
 *
 * Работает и в вебе, и это не нарушение принципа 3 (CLAUDE.md): назначение
 * аккаунта — метаданные (`PUT /domains/{id}`), ровно как у селекта Cloudflare.
 * Десктопным остаётся ИСПОЛНЕНИЕ — пуш NS через API регистратора, и живёт оно в
 * панели ниже. Гейта на Tauri здесь нет намеренно.
 *
 * Чего здесь НЕТ намеренно: бейджа «API/manual», кнопки Test connection и ссылки
 * в настройки регистраторов. Ответ «умеет ли этот регистратор писать NS» даёт
 * панель NS (`registrarSupportsNsApi`) — там, где стоит кнопка, которую он
 * включает. Второй такой ответ в двух сантиметрах выше означал бы два источника
 * правды на одном экране, а они уже расходились (см. `hasApi` в
 * `lib/registrarProviders`).
 */
export default function DomainRegistrarField({ domain }: DomainRegistrarFieldProps) {
  const accountsQ = useRegistrarAccounts();
  /**
   * `undefined` — списка нет: он ещё грузится либо не прочитался. Это ТРЕТЬЕ
   * состояние, а не пустой список: по пустому мы вправе сказать «такого аккаунта
   * больше нет», по отсутствующему — нет.
   */
  const accounts: RegistrarAccount[] | undefined = accountsQ.data;
  const update = useUpdateDomain(domain.id);
  const registrarId = domain.registrar_id;
  const account = accounts?.find((a) => a.id === registrarId);

  /**
   * У домена стоит `registrar_id`, а аккаунта под ним в списке нет — потому ли,
   * что список ещё не прочитан, или потому, что аккаунт удалили.
   *
   * Селект обязан остаться В ЭТОМ ЗНАЧЕНИИ: встав в «— No registrar account —»,
   * он утверждал бы, что связи нет, тогда как в БД она есть. Человек, поверивший
   * пустому селекту, «назначает» регистратора заново и не меняет ничего — либо,
   * наоборот, не замечает, что домен привязан к исчезнувшей учётке.
   */
  const unresolved = registrarId != null && !account;

  function pickAccount(value: string) {
    const next = value ? Number(value) : null;
    if (next === registrarId) return;
    // Одно поле и никаких побочных сбросов: у Cloudflare смена аккаунта обнуляет
    // зону, потому что зона принадлежала старому аккаунту, — у регистратора
    // подобного поля в строке домена нет.
    update.mutate({ registrar_id: next });
  }

  return (
    <div>
      <b>Registrar:</b>{" "}
      <Sel
        id="registrar-account"
        aria-label="Registrar account"
        value={registrarId == null ? "" : String(registrarId)}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => pickAccount(e.target.value)}
        // Списка нет — выбирать не из чего: единственным живым пунктом остался бы
        // «— No registrar account —», то есть выключенный селект честнее, чем
        // селект, умеющий только снять привязку.
        disabled={update.isPending || !accounts}
        style={{ padding: "4px 8px", fontSize: 12.5 }}
      >
        <option value="">— No registrar account —</option>
        {/* Пункт под сохранённый id, которого нет в списке. Без него React не
            смог бы поставить селект в это значение (опции с таким `value` нет),
            и браузер показал бы пустое поле — то самое «связи нет». */}
        {unresolved ? (
          <option value={String(registrarId)}>
            {accounts ? `#${registrarId} · account not found` : `#${registrarId}`}
          </option>
        ) : null}
        {(accounts ?? []).map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Sel>
      {update.isError ? (
        <div role="alert" style={{ fontSize: 12, color: ERROR_TEXT, marginTop: 4 }}>
          Could not save: {clip(errorText(update.error))}
        </div>
      ) : null}
      <AccountNote
        registrarId={registrarId}
        account={account}
        accountsKnown={!!accounts}
        accountsError={accountsQ.error}
      />
    </div>
  );
}

/**
 * Строка под селектом. Отвечает ровно на «какая учётка тут стоит и в каком она
 * состоянии» — по тому же правилу, что и `ZoneNote` у Cloudflare: у каждого
 * исхода своё имя, молчания нет ни в одном.
 */
function AccountNote({
  registrarId,
  account,
  accountsKnown,
  accountsError,
}: {
  registrarId: number | null;
  account: RegistrarAccount | undefined;
  accountsKnown: boolean;
  accountsError: unknown;
}) {
  const note = (color: string, text: React.ReactNode) => (
    <div style={{ fontSize: 12, color, marginTop: 3 }}>{text}</div>
  );

  if (registrarId == null) {
    // Первым, ДО состояния списка: «регистратора нет» читается из самой строки
    // домена и от чужого запроса не зависит — ждать ради этого ответа список
    // значило бы держать на экране «загрузка» вместо готового диагноза. Тот же
    // диагноз печатает выключенная кнопка в панели NS внизу, но здесь он назван
    // вместе с лекарством, которое стоит строкой выше.
    return note(WARN_TEXT, "Not assigned — there is nowhere to push nameservers.");
  }

  if (!accountsKnown) {
    // Отказ чтения списка — это «не знаем», а не «аккаунта нет»: причина
    // называется его же словами, иначе выключенный селект выглядит поломкой
    // карточки.
    if (accountsError) {
      return note(WARN_TEXT, `Registrar accounts could not be read: ${clip(errorText(accountsError))}`);
    }
    return note(NOTE_TEXT, "Loading accounts…");
  }

  if (!account) {
    return note(
      WARN_TEXT,
      `Account #${registrarId} is not in the list — it was probably deleted. Pick another one.`,
    );
  }

  // Провайдер — через общий `providerMeta`, а не своей табличкой: как выглядит
  // Hostiq или ручной ярлык, решено один раз на все экраны (`ProviderVisuals`).
  // `ProviderLabel` при этом покажет строку с пробелами по краям как есть — она
  // и есть причина, по которой такой аккаунт считается ручным.
  const meta = providerMeta(account.provider);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 12, color: NOTE_TEXT }}>
      <ProviderAvatar m={meta} size={18} />
      <ProviderLabel m={meta} />
    </div>
  );
}
