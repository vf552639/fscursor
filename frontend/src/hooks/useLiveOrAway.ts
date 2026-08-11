import { useCallback, useEffect, useRef } from "react";

/**
 * Развилка «страница ещё на экране → показать здесь; страницы уже нет → отдать
 * наверх».
 *
 * Существует потому, что результат операции переживает страницу: она
 * размонтируется на ЛЮБОЙ навигации (`<main key={page}>` в DesktopWorkspace), а
 * прогоны идут секундами и минутами (SSH, вычитка зон Cloudflare на двести
 * доменов). `setState` размонтированного компонента съедает текст молча, и
 * пользователь возвращается к обычному экрану в уверенности, что всё прошло, —
 * а прошло, например, «уже провижинится».
 *
 * Отдельный хук, а не два `mountedRef` по месту: развилка на вкладке Domains
 * встречалась дважды (отказ массового прогона и итог привязки к Cloudflare) и
 * различалась только адресом доставки.
 */
export function useLiveOrAway() {
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  /** Жив ли ЭТОТ экземпляр страницы прямо сейчас — там, где решение шире развилки. */
  const isLive = useCallback(() => liveRef.current, []);

  /** Выполнить `live()`, если экземпляр ещё на экране, иначе — `away()`. */
  const deliver = useCallback((live: () => void, away: () => void) => {
    if (liveRef.current) live();
    else away();
  }, []);

  return { isLive, deliver };
}
