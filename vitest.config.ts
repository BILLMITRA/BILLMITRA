import { transformWithOxc } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [{
    name: 'electron-commonjs-typescript',
    enforce: 'pre',
    async transform(code, id) {
      if (!id.endsWith('.cts')) return null
      return transformWithOxc(code, id, { lang: 'ts' })
    },
  }],
  test: {
    include: ['shared/**/*.test.ts', 'src/features/**/*.test.ts', 'electron/**/*.test.ts'],
  },
})
