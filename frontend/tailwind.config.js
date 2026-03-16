/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Dark theme centrado em verde neon — identidade pump
        surface: {
          900: '#0a0a0f',
          800: '#111118',
          700: '#1a1a24',
          600: '#22222f',
        },
        brand: {
          DEFAULT: '#00ff88',
          dim: '#00cc6e',
          dark: '#004422',
        },
        danger: '#ff4444',
        warning: '#ffaa00',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
}
