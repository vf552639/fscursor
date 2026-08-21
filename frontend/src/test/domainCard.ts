import { fireEvent, screen, within } from "@testing-library/react";

import { openTab } from "./tabs";

/**
 * Дорога до единственного входа в одиночный provision: строка списка доменов →
 * карточка → вкладка Server → «Provision» → диалог с галочкой «создать БД».
 *
 * Общий модуль, а не по копии в каждом файле, ровно по той причине, по которой
 * заведены `tabs` и `secretBlobKit`. Копий было три (`Domains.provision`,
 * `Domains.bulkprovision`, `DesktopWorkspace.provision`), и дублировалось в них
 * самое хрупкое: `.parentElement` у соседней кнопки и
 * `closest("label")!.parentElement` у чекбокса — то есть два места, где тест
 * знает не про роли, а про вложенность вёрстки. Расхождение уже началось: две
 * копии искали кнопку по `/^Provision(ing…)?$/`, третья — по точному
 * `"Provision"`.
 *
 * **Разошлись они случайно, и сведены к состояние-независимой форме.** Кнопка в
 * правом слоте `SnapshotLine` — один узел, и от того, что на нём написано, он
 * другим узлом не становится; менять подпись — его работа. Ищи мы его по
 * точному «Provision», смена подписи на «Provisioning…» превращалась бы в
 * «unable to find button» — то есть в сообщение о пропавшей кнопке вместо
 * сообщения о её состоянии. Тесты, которым важна именно подпись (гейт на время
 * прогона), утверждают её отдельно и явно: `expect(btn.textContent).toBe(…)`.
 */

/** Доступное имя ряда вкладок карточки — по нему же карточка находится целиком (`closeDomainCard`). */
const CARD_TABLIST = "Domain card sections";

/** Карточка домена: клик по имени в строке. Ждём вкладки — карточка приезжает не в том же тике. */
export async function openDomainCard(domain: string) {
  fireEvent.click(await screen.findByRole("button", { name: domain }));
  await screen.findByRole("tablist", { name: CARD_TABLIST });
}

/** Карточка домена, открытая на вкладке Server. */
export async function openServerTab(domain: string) {
  await openDomainCard(domain);
  openTab("Server");
}

/**
 * Кнопка «Provision» на открытой вкладке Server — в любом состоянии.
 *
 * Скоуп от «Check on server»: обе кнопки стоят в правом слоте одной
 * `SnapshotLine`, и это единственный способ отличить её от кнопки диалога,
 * который открывается ПОВЕРХ карточки и своей кнопки «Provision» не прячет.
 */
export function serverTabProvisionButton(): HTMLButtonElement {
  const line = screen.getByRole("button", { name: "Check on server" }).parentElement as HTMLElement;
  return within(line).getByRole("button", { name: /^Provision(ing…)?$/ }) as HTMLButtonElement;
}

/**
 * Закрыть карточку домена: без этого до строки соседнего домена не добраться.
 *
 * Крестик ищется ВНУТРИ карточки, а не по всему экрану: «Close» на странице
 * доменов не один (крестики баннеров), и глобальный поиск нашёл бы их все.
 */
export function closeDomainCard() {
  const card = screen.getByRole("tablist", { name: CARD_TABLIST }).closest('[style*="z-index"]') as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "Close" }));
}

/** Открыть диалог provision у домена. Возвращает чекбокс «создать БД» — им же диалог и скоупится. */
export async function openProvisionDialog(domain: string): Promise<HTMLInputElement> {
  await openServerTab(domain);
  fireEvent.click(serverTabProvisionButton());
  return (await screen.findByLabelText(/Also create a database/i)) as HTMLInputElement;
}

/**
 * Панель открытого диалога provision.
 *
 * Скоуп обязателен, и это не придирка к тесту, а прямое следствие переезда
 * кнопки в карточку: диалог открывается ПОВЕРХ карточки, кнопка «Provision»
 * вкладки Server остаётся в DOM, и `getByRole` без скоупа нашёл бы две кнопки с
 * этим именем. Панель берётся от чекбокса «создать БД» — он живёт только в
 * диалоге, а `Modal` кладёт детей прямо в панель, так что родитель его `label`
 * и есть она.
 */
export function provisionDialogPanel(cb: HTMLElement): HTMLElement {
  return cb.closest("label")!.parentElement as HTMLElement;
}

/** Нажать «Provision» именно в диалоге. */
export function confirmProvision(cb: HTMLElement) {
  fireEvent.click(within(provisionDialogPanel(cb)).getByRole("button", { name: "Provision" }));
}
