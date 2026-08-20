import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./api/queryClient";
import App from "./App";

/*
 * Шрифты подключены пакетами, а НЕ ссылкой на Google Fonts, и это не вкусовщина.
 * CSP десктопной оболочки (`desktop/src-tauri/tauri.conf.json`) — `default-src
 * 'self'; style-src 'self' 'unsafe-inline'`: ни `font-src`, ни домена
 * googleapis там нет, поэтому ссылка на CDN была бы просто заблокирована в
 * основном продукте, а вид приложения молча зависел бы ещё и от наличия сети.
 * `@fontsource/*` кладёт woff2 в бандл, и десктоп остаётся офлайновым.
 *
 * Весов ровно столько, сколько использует макет (400/500/600/700 Sans,
 * 400/500 Mono). Каждый лишний вес — это ещё около десятка файлов в бандле ради
 * начертания, которое никто не просит.
 *
 * Импорты стоят ДО `index.css` по конвенции «вендорный слой раньше своего»:
 * так свой CSS всегда лежит последним и может переопределить чужой. На выбор
 * начертания порядок НЕ влияет, и обратного тут писать не надо: `@font-face` не
 * участвует в каскаде с `body{font-family}` — браузер подбирает лицо среди всех
 * объявленных к моменту раскладки, где бы они ни стояли.
 */
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
