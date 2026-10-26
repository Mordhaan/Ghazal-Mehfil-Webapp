import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        nastaliq: ["var(--font-nastaliq)", "Noto Nastaliq Urdu", "serif"],
        editorial: ["var(--font-editorial)", "Georgia", "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      keyframes: {
        spinSlow: {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
        floatUp: {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-6px)" },
        },
        fadeSwap: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        breathe: {
          "0%,100%": { opacity: "0.5", transform: "scale(1)" },
          "50%": { opacity: "1", transform: "scale(1.35)" },
        },
      },
      animation: {
        "spin-slow": "spinSlow 9s linear infinite",
        "float-up": "floatUp 6s ease-in-out infinite",
        "fade-swap": "fadeSwap 700ms cubic-bezier(0.22,1,0.36,1) both",
        breathe: "breathe 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
