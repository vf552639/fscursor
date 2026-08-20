import React from "react";

import { Domain } from "../../api/domains";
import { Zone } from "../../api/cloudflare";
import DomainCloudflareField from "./DomainCloudflareField";
import DomainRegistrarField from "./DomainRegistrarField";
import DomainServerField from "./DomainServerField";
import { SectionCard } from "../ui/Primitives";
import { CardRow } from "./tabs/TabLayout";

export interface DomainLinksProps {
  domain: Domain;
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
 * Своей логики у ряда не осталось нисколько: все три связи — готовые поля,
 * каждое со своим селектом, своей записью и своей строкой-подписью. Сервер был
 * последним read-only полем ряда, и его read-only отменено: решение плана
 * 2026-08-17 («сервер домену назначает развёртывание») стояло на неверном
 * факте — provision `server_id` не ставит, а ЧИТАЕТ и без него падает, то есть
 * связка обязана существовать ДО развёртывания. Разбор — в шапке
 * `DomainServerField`.
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
export default function DomainLinks({ domain, zone, zones, zonesError }: DomainLinksProps) {
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
        <DomainServerField domain={domain} />
      </SectionCard>
    </CardRow>
  );
}
