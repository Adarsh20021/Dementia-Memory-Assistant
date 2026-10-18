/** @type {import('tailwindcss').Config} */
// Colours are theme tokens defined as CSS variables in src/index.css:
//   light = "Quiet care" (stone + forest green, green sidebar)
//   dark  = "Midnight" (ink navy + mint-green buttons)
// All text/background pairs meet WCAG AA (most AAA).
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const names = [
  'bg',
  'surface',
  'line',
  'ink',
  'sub',
  'brand',
  'brand-hover',
  'on-brand',
  'soft',
  'soft-ink',
  'side',
  'side-ink',
  'side-active',
  'side-active-ink',
  'cam',
  'help',
  'help-hover',
  'on-help',
  'danger',
  'on-danger',
  'ok-bg',
  'ok-ink',
  'warn-bg',
  'warn-ink',
  'bad-bg',
  'bad-ink',
];

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: Object.fromEntries(names.map((n) => [n, token(n)])),
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        serif: ['"Source Serif 4 Variable"', 'Georgia', 'Cambria', 'serif'],
      },
      minHeight: { touch: '56px' },
      minWidth: { touch: '56px' },
    },
  },
  plugins: [],
};
