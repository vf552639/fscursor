/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        status: {
          online: "#10b981",
          offline: "#ef4444",
          pending: "#f59e0b",
          idle: "#6b7280",
        },
        brand: {
          primary: "#3b82f6",
          primaryDark: "#1d4ed8",
        },
      },
    },
  },
  plugins: [],
};
