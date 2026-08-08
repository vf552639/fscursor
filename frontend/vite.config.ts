import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import { execFileSync } from "child_process";

// Что именно записано в бандл про сборку — версия, коммит, время. Собирается
// здесь, потому что ни git, ни файловой системы у браузера в рантайме нет:
// узнать это можно только на этапе сборки и зашить константой.
//
// UNKNOWN — не заглушка «на всякий случай», а рабочее состояние: веб-панель
// собирается в контейнере, который монтирует только ./frontend, так что ни
// desktop/src-tauri/tauri.conf.json, ни .git там не существует. Подставлять
// вместо них правдоподобное число нельзя — выдуманная версия неотличима от
// настоящей и врёт ровно в тот момент, когда её читают, чтобы разобраться
// (см. принцип «не рисуй незнание здоровьем», CLAUDE.md).
const UNKNOWN = "unknown";

// Версия приложения живёт ровно в одном месте — tauri.conf.json. Именно её
// показывает macOS в «About» и по ней называется .dmg; заведи фронт свою — и
// на экране с именем файла окажутся разные числа. В frontend/package.json
// стоит 0.0.1 (версия npm-пакета) и версией продукта не является.
function appVersion(): string {
  try {
    const conf = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../desktop/src-tauri/tauri.conf.json"),
        "utf8"
      )
    );
    return typeof conf.version === "string" && conf.version ? conf.version : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

// Версии мало: она стоит на 0.1.0 месяцами, а пересборок за день несколько.
// Отличает сборки именно коммит — и признак того, что дерево было грязным:
// собранный из некоммиченных правок бинарник коммиту не соответствует, и
// голый SHA на нём был бы неправдой.
//
// stdio глушим на stderr: вне репозитория git пишет «not a git repository», и
// это не ошибка сборки, а ожидаемый случай (контейнер) — он обрабатывается
// возвратом UNKNOWN, а не паникой в логе.
function gitCommit(): string {
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

  try {
    const sha = run(["rev-parse", "--short=8", "HEAD"]);
    if (!sha) return UNKNOWN;
    return run(["status", "--porcelain"]) ? `${sha}+` : sha;
  } catch {
    return UNKNOWN;
  }
}

// argon2-browser's default entry imports argon2.wasm as an ESM module, which vite
// cannot serve (500 on `argon2.wasm?import`). The bundled build inlines the wasm.
// Under vitest crypto.ts loads the wasm from disk itself, so keep the default there.
const argon2Alias = process.env.VITEST
  ? {}
  : {
      "argon2-browser": path.resolve(
        __dirname,
        "./node_modules/argon2-browser/dist/argon2-bundled.min.js"
      ),
    };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
    __APP_COMMIT__: JSON.stringify(gitCommit()),
    __APP_BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src"), ...argon2Alias },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": { target: "http://backend:8000", changeOrigin: true },
    },
  },
});
