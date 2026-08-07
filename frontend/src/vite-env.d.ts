/// <reference types="vite/client" />

// Подставляются `define` в vite.config.ts на этапе сборки — это не переменные,
// а текстовая замена, поэтому объявлены как const, а не как поля объекта.
// Значение "unknown" здесь ожидаемо и обрабатывается в lib/buildInfo.ts.
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILT_AT__: string;
