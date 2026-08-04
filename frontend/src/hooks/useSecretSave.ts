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

/** Общее у одиночной и многополевой формы. */
interface SecretFormState {
  /** Идёт запись блобов ИЛИ сохранение сущности — кнопку держать выключенной. */
  saving: boolean;
  /** Готовый текст для `role="alert"`; `null` — показывать нечего. */
  error: string | null;
  /** Забыть набранное: отмена, закрытие формы, смена вкладки. */
  reset: () => void;
}

export interface SecretSave extends SecretFormState {
  /** Плейнтекст для `value`/`onChange` поля ввода. Наружу не отдавать. */
  value: string;
  /** Заодно гасит показанную ошибку: она была про прошлый ввод. */
  setValue: (v: string) => void;
  save: (
    args: SecretTarget & {
      /**
       * Сохранение самой сущности с полученным `blobId`. Обязано вернуть промис,
       * который резолвится ПОСЛЕ ответа сервера (`mutateAsync`, не `mutate`):
       * `saving` держится по нему. С `mutate` промис резолвился бы сразу, а
       * `isPending` react-query поднимает через `notifyManager` уже следующим
       * макротаском — оставался бы кадр, где кнопка снова живая.
       *
       * Инвариант: сюда передают сохранение СУЩНОСТИ и ничего больше. Вложить
       * `save` второго секрета нельзя — чем это кончается и чем ловится, см.
       * `saveInFlight`; `Promise<void>` — половина той защиты, он отбивает
       * короткую стрелку `persist: (id) => inner.save(…)` на компиляции.
       * Вызов платит за это одной строкой: `async (id) => { await m(id); }`,
       * где `m` — мутация сущности.
       */
      persist: (blobId: string) => Promise<void>;
    },
  ) => Promise<boolean>;
}

export interface MultiSecretSave<K extends string> extends SecretFormState {
  /** Плейнтексты по ключам полей. Наружу не отдавать. */
  values: Record<K, string>;
  /** Заодно гасит показанную ошибку: она была про прошлый ввод. */
  setValue: (key: K, v: string) => void;
  /**
   * Записать все блобы и только потом сохранить сущность разом.
   *
   * В `secrets` кладут ТОЛЬКО меняемые поля: ключ есть — секрет перезаписываем,
   * и пустым он быть не может; ключа нет (или он `undefined`) — поле не
   * трогаем, у сущности остаётся прежний `*_blob_id`, а в `blobIds` его не
   * будет. Иначе правка имени аккаунта требовала бы перенабрать API-токен —
   * аффорданс «оставь пустым, чтобы сохранить текущий» есть в формах сегодня.
   *
   * `persist` не вызывается, если хоть одна запись блоба упала; уже записанные
   * блобы НЕ откатываются (`deleteSecretBlob` на правке снёс бы живой секрет —
   * JSDoc `putSecretBlob`), осиротевший блоб безвреден, а повтор перезапишет те
   * же id; плейнтексты стираются только на полном успехе.
   */
  saveAll: (args: {
    secrets: Partial<Record<K, SecretTarget>>;
    persist: (blobIds: Partial<Record<K, string>>) => Promise<void>;
  }) => Promise<boolean>;
}

function blanked<K extends string>(keyed: Record<K, unknown>): Record<K, string> {
  return Object.fromEntries(Object.keys(keyed).map((k) => [k, ""])) as Record<K, string>;
}

/**
 * Идёт `persist`, то есть сохранение сущности. Ловим этим ровно одно: `save`,
 * начатый ИЗНУТРИ `persist`, — попытку сохранить второй секрет вложением.
 * Она компилируется (`async`-тело возвращает `Promise<void>`, что бы внутри ни
 * было) и проваливается тихо: внутренний `save` на ошибке ВОЗВРАЩАЕТ `false`, а
 * не бросает, поэтому внешний видит успешный промис, стирает плейнтекст и
 * рапортует форме успех, не сохранив второй секрет. Правильный инструмент —
 * `saveAll`.
 *
 * Флаг модульный, а не по инстансу: вложенность — это всегда два РАЗНЫХ
 * инстанса хука. И окно — только `persist`: взведи его на всю операцию, и он
 * заодно накрыл бы запись блобов (Tauri-IPC, самая долгая часть), то есть
 * срабатывал бы на честных параллельных формах.
 */
let saveInFlight = false;

/** Только для тестов: флаг переживает `cleanup()` и упал бы в следующем тесте. */
export function resetSecretSaveGuardForTests(): void {
  saveInFlight = false;
}

/** Сообщение разработчику: диагноз, лечение и файл, в который идти. */
const NESTED_SAVE =
  "nested secret save (hooks/useSecretSave.ts): do not call save() inside persist() — " +
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

  // Ref, а не замыкание: иначе `saveAll` пересоздавался бы на каждое нажатие
  // клавиши, а форма держит его в обработчике, который живёт дольше рендера.
  // Пишем прямо в рендере, а не в effect: тот отстал бы на кадр — сохранился бы
  // плейнтекст без последнего символа. Безопасно, пока рендеры формы не
  // отбрасываются: переведёшь её на `startTransition`/`useDeferredValue` — в
  // ref осядет значение из незакоммиченного рендера.
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
    // Отсутствующий ключ и явный `undefined` значат одно и то же — «не меняем»:
    // форма пишет `apiKey: touched ? target : undefined`, и разбирать эти два
    // случая по-разному значило бы наказывать за стиль записи.
    const changing = (Object.keys(secrets) as K[])
      .map((k) => [k, secrets[k]] as const)
      .filter((pair): pair is readonly [K, SecretTarget] => pair[1] !== undefined);

    // Пустые поля собираем ВСЕ и до первой записи. Пустой плейнтекст дал бы
    // блоб из нуля байт при заполненном `*_blob_id`: сервер считает секрет
    // настроенным, и падает уже живое соединение, а не форма. Проверка после
    // первой записи оставила бы такой блоб от соседнего поля, а сообщение про
    // одно поле гоняло бы по кругу форму, где пустые оба.
    const missing = changing.filter(([k]) => !values[k]).map(([k]) => labels[k]);
    if (missing.length > 0) {
      setError(`${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} required`);
      return false;
    }

    setSaving(true);
    try {
      // Сначала все блобы, потом сущность. Наоборот — это сущность со ссылкой
      // NULL: «сохранено» и неработающие команды. Порядок и запрет отката
      // блоба в `catch` — в JSDoc `putSecretBlob`, здесь они исполняются.
      const blobIds: Partial<Record<K, string>> = {};
      for (const [k, target] of changing) {
        blobIds[k] = await putSecretBlob({ plaintext: values[k], ...target });
      }
      saveInFlight = true;
      try {
        await persist(blobIds);
      } finally {
        // Снимаем на всех путях: иначе упавшее сохранение сущности заблокировало
        // бы формы до перезагрузки приложения.
        saveInFlight = false;
      }
      // Плейнтексты стираем только здесь — на успехе. На ошибке они нужны для
      // повтора, а на отмене их стирает `reset`.
      setValues(blanked);
      return true;
    } catch (e: unknown) {
      // `message` содержательный у обоих источников: `putSecretBlob` бросает
      // Error, а axios-интерцептор сворачивает `detail` ответа в `ApiError`.
      // Наружу НЕ пробрасываем: форма показала бы вторую копию из своего catch.
      const what = changing.map(([k]) => labels[k]).join(" and ") || "secrets";
      setError(e instanceof Error && e.message ? e.message : `Could not save ${what}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const saveAll = useCallback<MultiSecretSave<K>["saveAll"]>(
    (args) => {
      if (saveInFlight) {
        // СИНХРОННО, а не отклонённым промисом: вложенный вызов часто роняют на
        // пол (`inner.save(…)` без `await`), и его отказ до внешнего не долетел
        // бы. И громко: вызовы делают `await save(…)` без `try/catch`, так что
        // молчащий бросок выглядел бы как клик в пустоту.
        console.error(NESTED_SAVE);
        setError(NESTED_SAVE);
        throw new Error(NESTED_SAVE);
      }
      return run(args);
    },
    [run],
  );

  return useMemo(
    () => ({ values, setValue, saving, error, reset, saveAll }),
    [values, setValue, saving, error, reset, saveAll],
  );
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
        // Ключ всегда в `secrets`, значит и id всегда есть: одиночная форма не
        // может «не менять» свой единственный секрет.
        persist: (blobIds) => persist(blobIds.secret as string),
      }),
    [saveAll],
  );

  return useMemo(
    () => ({ value: values.secret, setValue: setOne, saving, error, reset, save }),
    [values.secret, setOne, saving, error, reset, save],
  );
}
