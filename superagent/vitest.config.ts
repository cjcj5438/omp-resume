import { defineConfig } from 'vitest/config'
// Share one React instance across the panel and its tests.
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] }, test: { include: ['tests/**/*.spec.{ts,tsx}'] } })
