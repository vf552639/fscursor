import { useCallback, useMemo, useRef, useState } from "react";

import { putSecretBlob, type BlobKind } from "../lib/secretBlob";

/**
 * Форма, которая сохраняет секрет. Одна на все пять полей спринта
 * (SSH-пароль, пароль FastPanel, `api_key`/`api_secret` регистратора,
 * `api_token` Cloudflare): порядок «блоб → сущность», флаг «сохраняю», текст
 * ошибки и момент стирания плейнтекста должны быть в ОДНОМ месте. Двух копий
 * хватило, чтобы три из четырёх разъехались, а автор пятой формы читает только
 * свою.
 *
 * Плейнтекст живёт здесь, а не в стейте страницы, и это главное: хук — это
 * единственный, кто знает, когда его стереть. Хук react-query для этого не
 * годится в принципе — `useMutation` кладёт аргументы в `variables`, откуда их
 * не убирает даже `reset()` (см. JSDoc `putSecretBlob` и `useInstallFastPanel`).
 *
 * Полей у формы может быть больше одного: у регистратора это `api_key` и
 * `api_secret`, которые сохраняются одним POST. Для них — `useMultiSecretSave`;
 * `useSecretSave` это тот же хук на одном поле, чтобы порядок и стирание жили
 * в единственном экземпляре.
 */

/** Куда пишем секрет: вид блоба и, при правке, id перезаписываемого блоба. */
export interface SecretTarget {
  blobKind: BlobKind;
  /** `null` — новый секрет; при правке ОБЯЗАТЕЛЬНО текущий `*_blob_id`. */
  existingBlobId: string | null;
}

export interface SecretSave {
  /** Плейнтекст для `value`/`onChange` поля ввода. Наружу не отдавать. */
  value: string;
  /** Заодно гасит показанную ошибку: она была про прошлый ввод. */
  setValue: (v: string) => void;
  /** Идёт запись блоба ИЛИ сохранение сущности — кнопку держать выключенной. */
  saving: boolean;
  /** Готовый текст для `role="alert"`; `null` — показывать нечего. */
  error: string | null;
  /** Забыть набранное: отмена, закрытие формы, смена вкладки. */
  reset: () => void;
  save: (
    args: SecretTarget & {
      /**
       * Сохранение самой сущности с полученным `blobId`. Обязано вернуть промис,
       * который резолвится ПОСЛЕ ответа сервера (`mutateAsync`, не `mutate`):
       * `saving` держится по нему. С `mutate` промис резолвился бы сразу, а
       * `isPending` react-query поднимает через `notifyManager` уже следующим
       * макротаском — оставался бы кадр, где кнопка снова живая.
       *
       * Тип именно `Promise<void>`, и сузить его пришлось не ради чистоты.
       * `Promise<unknown>` принимал сюда вложенный `save` второго секрета —
       * очевидную композицию для формы регистратора, — и она молча ломалась:
       * внутренний `save` на ошибке ВОЗВРАЩАЕТ `false`, а не бросает, так что
       * внешний видел успешный промис, стирал свой плейнтекст и рапортовал
       * форме успех, не сохранив ничего. Расширишь тип обратно — вернёшь этот
       * зелёный путь без записанного секрета.
       *
       * Но закрывает сужение ровно одну запись — короткую стрелку
       * `persist: (id) => inner.save(…)`. Блочное тело
       * (`async (id) => { await inner.save(…); }`), брошенный промис и
       * `.then(() => {})` типом не ловятся в принципе: `async`-функция
       * возвращает `Promise<void>`, что бы внутри ни было. Их добивает
       * рантайм-гвард на переиспользование (`saveInFlight` ниже), а
       * правильный инструмент для нескольких секретов — `saveAll`.
       *
       * Вызов платит за сужение одной строкой: `async (id) => { await m(id); }`,
       * где `m` — мутация СУЩНОСТИ, а не ещё один `save`.
       */
      persist: (blobId: string) => Promise<void>;
    },
  ) => Promise<boolean>;
}

export interface MultiSecretSave<K extends string> {
  /** Плейнтексты по ключам полей. Наружу не отдавать. */
  values: Record<K, string>;
  /** Заодно гасит показанную ошибку: она была про прошлый ввод. */
  setValue: (key: K, v: string) => void;
  /** Идёт запись блобов ИЛИ сохранение сущности — кнопку держать выключенной. */
  saving: boolean;
  /** Одна ошибка на всю форму: секреты сохраняются одним действием. */
  error: string | null;
  /** Забыть набранное: отмена, закрытие формы, смена вкладки. */
  reset: () => void;
  /**
   * Записать все блобы и только потом сохранить сущность разом.
   *
   * Альтернатива — вложить `save` одного секрета в `persist` другого — тихо
   * ломается (см. `SecretSave["save"]`): очевидная короткая запись не
   * компилируется, любая другая падает рантайм-гвардом на первом же прогоне.
   *
   * Правила те же, что у одиночного пути, но на N полей: `persist` не
   * вызывается, если хоть одна запись блоба упала; уже записанные блобы НЕ
   * откатываются (`deleteSecretBlob` на правке снёс бы живой секрет — JSDoc
   * `putSecretBlob`), осиротевший блоб безвреден, а повтор перезапишет те же
   * id; плейнтексты стираются только на полном успехе.
   */
  saveAll: (args: {
    secrets: Record<K, SecretTarget>;
    persist: (blobIds: Record<K, string>) => Promise<void>;
  }) => Promise<boolean>;
}

function blanked<K extends string>(keyed: Record<K, unknown>): Record<K, string> {
  return Object.fromEntries(Object.keys(keyed).map((k) => [k, ""])) as Record<K, string>;
}

/**
 * Идёт сохранение секрета. Флаг МОДУЛЬНЫЙ, а не по инстансу, потому что
 * вложенность — это всегда два разных инстанса хука: форма регистратора,
 * попытавшаяся сохранить `api_secret` внутри `persist` от `api_key`.
 *
 * Тип такое не выразит: блочное тело `async` возвращает `Promise<void>`, что бы
 * внутри ни было. А повторный вход — выразим.
 *
 * Побочный эффект: два секрета нельзя сохранять и буквально параллельно
 * (`Promise.all` двух форм). Это осознанно — форма сохранения секрета в
 * продукте всегда одна модалка, и ложное срабатывание тут громкое и мгновенное,
 * тогда как пропущенная вложенность тихая и уносит секрет.
 */
let saveInFlight = false;

/**
 * Сообщение разработчику, а не пользователю: диагноз и лечение в одной строке.
 * По-английски, потому что через `catch` внешнего вызова оно попадает в тот же
 * `error`, что и остальные тексты хука.
 */
const NESTED_SAVE =
  "useSecretSave: another secret save is already in flight — do not nest save() inside persist(); " +
  "use useMultiSecretSave/saveAll to write several secrets before one entity save";

/**
 * `labels` — как поля называются пользователю (`{ apiKey: "API key" }`): из них
 * собираются оба сообщения хука, чтобы формы не выдумывали свои формулировки.
 * Набор ключей задаётся первым рендером и дальше не меняется — это поля формы.
 */
export function useMultiSecretSave<K extends string>(labels: Record<K, string>): MultiSecretSave<K> {
  const [values, setValues] = useState<Record<K, string>>(() => blanked(labels));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Плейнтексты и подписи `saveAll` читает из ref'ов, а не из замыкания: иначе
  // он пересоздавался бы на каждое нажатие клавиши, а форма держит его в
  // обработчике, который живёт дольше рендера.
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  const setValue = useCallback((key: K, v: string) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    // Ошибка была про прошлый ввод: пока человек перенабирает секрет, красный
    // блок над полем противоречит тому, что он делает прямо сейчас.
    setError(null);
  }, []);

  const reset = useCallback(() => {
    setValues(blanked);
    setError(null);
  }, []);

  const run = useCallback<MultiSecretSave<K>["saveAll"]>(async ({ secrets, persist }) => {
    setError(null);
    const labels = labelsRef.current;
    const values = valuesRef.current;
    const keys = Object.keys(secrets) as K[];
    // Пустые поля проверяем ВСЕ и до первой записи. Пустой плейнтекст дал бы
    // блоб из нуля байт при заполненном `*_blob_id`: сервер считает секрет
    // настроенным, и падает уже живое соединение, а не форма. Проверка после
    // первой записи оставила бы такой блоб от соседнего поля.
    for (const k of keys) {
      if (!values[k]) {
        setError(`${labels[k]} is required`);
        return false;
      }
    }
    setSaving(true);
    try {
      // Сначала все блобы, потом сущность. Наоборот — это сущность со ссылкой
      // NULL: «сохранено» и неработающие команды. Порядок и запрет отката
      // блоба в `catch` — в JSDoc `putSecretBlob`, здесь они исполняются.
      const blobIds = {} as Record<K, string>;
      for (const k of keys) {
        blobIds[k] = await putSecretBlob({ plaintext: values[k], ...secrets[k] });
      }
      await persist(blobIds);
      // Плейнтексты стираем только здесь — на успехе. На ошибке они нужны для
      // повтора, а на отмене их стирает `reset`.
      setValues(blanked);
      return true;
    } catch (e: unknown) {
      // `message` содержательный у обоих источников: `putSecretBlob` бросает
      // Error, а axios-интерцептор сворачивает `detail` ответа в `ApiError`.
      // Наружу НЕ пробрасываем: форма показала бы вторую копию из своего catch.
      const what = keys.map((k) => labels[k]).join(" and ");
      setError(e instanceof Error && e.message ? e.message : `Could not save ${what}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const saveAll = useCallback<MultiSecretSave<K>["saveAll"]>(
    (args) => {
      // Бросаем СИНХРОННО, а не отдаём отклонённый промис. Вложенный вызов
      // часто роняют на пол (`inner.save(…)` без `await`) — отказ промиса до
      // внешнего вызова тогда не долетит, он досидит до конца и отрапортует
      // успех, стерев плейнтекст. Синхронное исключение вылетает из тела
      // `persist` при ЛЮБОЙ форме записи (await, брошенный промис, `void`,
      // `.then`) и роняет внешний `saveAll` в его собственный catch.
      //
      // Именно исключение, а не `return false`: это ошибка разработчика на
      // этапе сборки формы, а не отказ пользователю, и молчать о ней нельзя.
      if (saveInFlight) throw new Error(NESTED_SAVE);
      saveInFlight = true;
      // Снимаем на ВСЕХ путях, включая исключения: иначе одна упавшая запись
      // заблокировала бы формы до перезагрузки приложения.
      return run(args).finally(() => {
        saveInFlight = false;
      });
    },
    [run],
  );

  return { values, setValue, saving, error, reset, saveAll };
}

/**
 * `secretLabel` — как секрет называется пользователю («SSH password»): из него
 * собираются оба сообщения хука, чтобы формы не выдумывали свои формулировки.
 */
export function useSecretSave(secretLabel: string): SecretSave {
  const { values, setValue, saving, error, reset, saveAll } = useMultiSecretSave({
    secret: secretLabel,
  });

  const setOne = useCallback((v: string) => setValue("secret", v), [setValue]);

  const save = useCallback<SecretSave["save"]>(
    ({ blobKind, existingBlobId, persist }) =>
      saveAll({
        secrets: { secret: { blobKind, existingBlobId } },
        persist: (blobIds) => persist(blobIds.secret),
      }),
    [saveAll],
  );

  return useMemo(
    () => ({ value: values.secret, setValue: setOne, saving, error, reset, save }),
    [values.secret, setOne, saving, error, reset, save],
  );
}
