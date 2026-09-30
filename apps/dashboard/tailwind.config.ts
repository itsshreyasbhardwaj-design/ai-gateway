import type { Config } from 'tailwindcss';

/**
 * Infrastructure-console palette: near-black surfaces, one cyan accent, and
 * semantic colours reserved for status. Nothing here is decorative.
 */
const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#09090b',
          raised: '#111113',
          overlay: '#18181b',
          border: '#27272a',
        },
        accent: {
          DEFAULT: '#22d3ee',
          muted: '#0e7490',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      fontSize: {
        // A denser default than Tailwind's, appropriate for tabular data.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
      },
      animation: { 'fade-in': 'fade-in 120ms ease-out' },
    },
  },
  plugins: [],
};

export default config;
