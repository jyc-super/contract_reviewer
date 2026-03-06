import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        "bg-primary": "#0F1117",
        "bg-secondary": "#161821",
        "bg-tertiary": "#1C1F2E",
        "bg-card": "#1A1D2B",
        "bg-hover": "#222539",
        "border-muted": "#2A2D3E",
        "border-light": "#353850",
        "text-primary": "#E8E9ED",
        "text-secondary": "#9496A8",
        "text-muted": "#6B6E82",
        "accent-blue": "#4C8BF5",
        "accent-blue-dim": "rgba(76,139,245,0.15)",
        "accent-green": "#34D399",
        "accent-green-dim": "rgba(52,211,153,0.12)",
        "accent-yellow": "#FBBF24",
        "accent-yellow-dim": "rgba(251,191,36,0.12)",
        "accent-red": "#F87171",
        "accent-red-dim": "rgba(248,113,113,0.12)",
        "accent-purple": "#A78BFA",
        "accent-purple-dim": "rgba(167,139,250,0.12)",
      },
      boxShadow: {
        card: "0 2px 8px rgba(0,0,0,0.3)",
        "card-lg": "0 8px 32px rgba(0,0,0,0.4)",
      },
      borderRadius: {
        lg: "12px",
      },
    },
  },
  plugins: [],
};

export default config;
