import { useCallback, useState } from "react";

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
 */
export interface SecretSave {
  /** Плейнтекст для `value`/`onChange` поля ввода. Наружу не отдавать. */
  value: string;
  setValue: (v: string) => void;
  /** Идёт запись блоба ИЛИ сохранение сущности — кнопку держать выключенной. */
  saving: boolean;
  /** Готовый текст для `role="alert"`; `null` — показывать нечего. */
  error: string | null;
  /** Забыть набранное: отмена, закрытие формы, смена вкладки. */
  reset: () => void;
  save: (args: {
    blobKind: BlobKind;
    /** `null` — новый секрет; при правке ОБЯЗАТЕЛЬНО текущий `*_blob_id`. */
    existingBlobId: string | null;
    /**
     * Сохранение самой сущности с полученным `blobId`. Обязано вернуть промис,
     * который резолвится ПОСЛЕ ответа сервера (`mutateAsync`, не `mutate`):
     * `saving` держится по нему. С `mutate` промис резолвился бы сразу, а
     * `isPending` react-query поднимает через `notifyManager` уже следующим
     * макротаском — оставался бы кадр, где кнопка снова живая.
     */
    persist: (blobId: string) => Promise<unknown>;
  }) => Promise<boolean>;
}

/**
 * `secretLabel` — как секрет называется пользователю («SSH password»): из него
 * собираются оба сообщения хука, чтобы формы не выдумывали свои формулировки.
 */
export function useSecretSave(secretLabel: string): SecretSave {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setValue("");
    setError(null);
  }, []);

  const save = useCallback<SecretSave["save"]>(
    async ({ blobKind, existingBlobId, persist }) => {
      setError(null);
      // Пустой плейнтекст дал бы блоб из нуля байт, а у сущности — заполненный
      // `*_blob_id`: сервер считает секрет настроенным, и падает уже живое
      // SSH-соединение, а не форма.
      if (!value) {
        setError(`${secretLabel} is required`);
        return false;
      }
      setSaving(true);
      try {
        // Сначала блоб, потом сущность. Наоборот — это сущность со ссылкой
        // NULL: «сохранено» и неработающие команды. Порядок и запрет отката
        // блоба в `catch` — в JSDoc `putSecretBlob`, здесь они исполняются.
        const blobId = await putSecretBlob({ plaintext: value, blobKind, existingBlobId });
        await persist(blobId);
        // Плейнтекст стираем только здесь — на успехе. На ошибке он нужен для
        // повтора, а на отмене его стирает `reset`.
        setValue("");
        return true;
      } catch (e: unknown) {
        // `message` содержательный у обоих источников: `putSecretBlob` бросает
        // Error, а axios-интерцептор сворачивает `detail` ответа в `ApiError`.
        setError(e instanceof Error && e.message ? e.message : `Could not save ${secretLabel}`);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [secretLabel, value],
  );

  return { value, setValue, saving, error, reset, save };
}
