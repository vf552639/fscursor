/**
 * Тестовый вектор ключа хранилища — один на весь фронт.
 *
 * Форма ровно та, в которой сервер отдаёт `wrapped_vault_key_b64`:
 * `aead(VK, KEK)` = nonce (24) || secretbox (tag 16 + key 32) = 72 байта, выпущено
 * libsodium'ным `crypto_secretbox_easy` — тем же вызовом, что делает десктоп в
 * `desktop/src-tauri/src/crypto/aead.rs::encrypt`.
 *
 * KEK — тот же `hunter2` + нулевая соль, что и `master_key_fixture_for_browser_tests`
 * в `desktop/src-tauri/src/crypto/kdf.rs`; внутри обёртки лежит пробег байтов 00..1f,
 * выбранный так, чтобы неверный разворот был виден с одного взгляда.
 *
 * Зачем вектор вообще нужен: браузер, разворачивающий обёртку не так, как десктоп, не
 * падает громко — он отдаёт пользователю 32 байта мусора как ключ, а потом показывает
 * мусор на месте пароля. Ловит это только фиксированный вектор.
 *
 * Байты ниже проверены на открытие в тот же VK под `dryoc` 0.6 — тем самым крейтом,
 * которым пользуется `crypto/aead.rs`, — так что это согласие трёх реализаций
 * (libsodium C, libsodium-wasm в браузере, dryoc), а не браузера с самим собой.
 *
 * Дублирование с Rust здесь осознанное: в нём весь смысл вектора. А вот дублировать
 * его между TS-тестами нельзя — разъехавшись, копии дадут зелёный тест на неверном
 * векторе, то есть ровно ту ошибку, против которой вектор и заведён. Поэтому файл.
 *
 * Не `*.test.ts`, так что vitest его не подхватывает как набор тестов (`include`
 * в `vite.config.ts`), а как обычный модуль — импортируется он только из тестов.
 */

/** `deriveMasterKey("hunter2", new Uint8Array(16))` — байт в байт как у десктопа. */
export const FIXTURE_KEK_HEX = "cf3489cf8dfa53ec6604068c99f63760b1c8faa9772c0862c2acd81fac43a7a4";

/** Ключ хранилища внутри обёртки: 00..1f. */
export const FIXTURE_VK_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

/** `aead(VK 00..1f, KEK из hunter2 + нулевая соль)`, 72 байта. */
export const WRAPPED_VK_B64 =
  "EBESExQVFhcYGRobHB0eHyAhIiMkJSYnb9WWEYFBWfrgYxJ9rQHFkE767KJCJ2xANXgOb/E4NJIVRoY3l7yuEYBeZ8jWxQ7k";

/** hex-строка из байтов — та же трёхстрочная утилита была в каждом из тестов. */
export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Обратно: hex-фикстура в байты. */
export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
