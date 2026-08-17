import { describe, expect, it } from "vitest";
import { ENCRYPTION_BANNER, ENCRYPTION_INFO } from "./settingsEncryptionInfo";

describe("ENCRYPTION_INFO", () => {
  const flat = JSON.stringify([ENCRYPTION_BANNER, ...ENCRYPTION_INFO]);

  it("describes the real zero-knowledge model", () => {
    expect(flat).toContain("Argon2id");
    // The desktop (crypto/aead.rs) and browser (lib/crypto.ts) implementations both
    // call libsodium's `crypto_secretbox_easy`, i.e. the classic NaCl secretbox
    // construction — XSalsa20-Poly1305, NOT the XChaCha20-Poly1305 AEAD construction.
    expect(flat).toContain("XSalsa20-Poly1305");
    expect(flat).toContain("secretbox");
  });

  it("does not mention the obsolete AES/ENCRYPTION_KEY model", () => {
    expect(flat).not.toContain("AES-256-GCM");
    expect(flat).not.toContain("ENCRYPTION_KEY");
    expect(flat).not.toContain("SHA-256");
  });

  it("does not misname the AEAD construction as XChaCha20-Poly1305", () => {
    // secretbox (XSalsa20-Poly1305) and the XChaCha20-Poly1305 AEAD are related but
    // distinct constructions; the codebase uses the former, so the copy must not claim
    // the latter.
    expect(flat).not.toContain("XChaCha20-Poly1305");
  });

  it("names the vault key as what encrypts the secrets, and says the password wraps it", () => {
    expect(flat).toMatch(/vault key/i);
    expect(flat).toMatch(/wrap/i);
  });

  it("does not claim the browser encrypts anything — it cannot", () => {
    // `encryptBlob` помечен `@internal` и вне тестов не вызывается, а формы с секретами
    // в вебе заменены на `DesktopOnlyNote`: записать секрет из браузера невозможно.
    // Обещание «оба шифруют» звучит безобиднее, чем есть: оно ровно про ту способность,
    // отсутствие которой и объясняет, почему полей в вебе нет вовсе.
    //
    // Граница класса — `[^".;]`, а не `[^"]`: иначе «…the web panel only decrypts. Your
    // password encrypts nothing…» ловится как обещание через точку.
    expect(flat).not.toMatch(/(browser|web panel|web)[^".;]*\bencrypts?\b/i);
    expect(flat).not.toMatch(/\bboth\b[^".;]*\bencrypt/i);
  });

  it("promises what the vault key is actually for: a password change keeps the secrets", () => {
    // Ради этого весь переход и делался. Экран, умолчавший об этом, оставил бы
    // пользователя с прежним страхом «сменю пароль — потеряю секреты».
    expect(flat).toMatch(/chang(e|ing)[^"]*password|password[^"]*chang(e|ing)/i);
    expect(flat).toMatch(/stay readable|re-encrypted/i);
  });

  it("no longer claims the key that encrypts secrets comes from the password", () => {
    // Ровно то, что было неправдой после фазы 1: из пароля выводится KEK, и он только
    // разворачивает обёртку.
    //
    // Запрещено не слово, а утверждение. Прямой `/master key/i` заворачивал бы и
    // опровержение («your password is not the master key…») — то есть блокировал бы
    // правильную копию; ловить надо связку «master key» с шифрованием или выводом
    // из пароля, и в пределах одного предложения.
    expect(flat).not.toMatch(/master key[^".;]*(encrypts?|derived|derives)/i);
    expect(flat).not.toMatch(/(encrypted|derived)[^".;]*\bmaster key\b/i);
    expect(flat).not.toMatch(/(key is|key,) derived from your password/i);
  });

  it("never promises the secrets get re-encrypted when the password changes", () => {
    // Это и есть дефект, ради которого делалась фаза: перешифровки нет и быть не должно,
    // а копия, пообещавшая её, описывала бы прежнюю — сломанную — модель.
    expect(flat).not.toMatch(/re-?encrypts?[^".;]*(secret|blob)/i);
    expect(flat).not.toMatch(/(secret|blob)[^".;]*\bare re-?encrypted/i);
  });

  it("does not describe a password change as rewriting the secrets", () => {
    // Сервер при `password/change` пишет ровно три колонки пользователя, а `BlobStorage`
    // не трогает ни строкой (см. доккомментарий к модулю). Копия обязана обещать то же.
    expect(flat).not.toMatch(/\ball (your )?secrets are (re-?written|re-?encrypted|rotated)/i);
  });
});
