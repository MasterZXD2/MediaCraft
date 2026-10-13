import { resolve } from 'node:path'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

function pdfAssets(): Plugin {
  const source = resolve('node_modules/pdfjs-dist')
  let output = ''
  return {
    name: 'pdf-offline-assets',
    configResolved(config) { output = resolve(config.root, config.build.outDir, 'pdf-assets') },
    configureServer(server) {
      server.middlewares.use('/pdf-assets', async (request, response, next) => {
        try {
          const asset = decodeURIComponent((request.url ?? '').split('?')[0]).replace(/^\//, '')
          if (!/^(cmaps|standard_fonts|wasm)\/[^/\\]+$/.test(asset) || asset.includes('..')) return next()
          const bytes = await readFile(resolve(source, asset))
          response.setHeader('Content-Type', asset.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
          response.end(request.method === 'HEAD' ? undefined : bytes)
        } catch { next() }
      })
    },
    async closeBundle() {
      await mkdir(output, { recursive: true })
      await Promise.all(['cmaps', 'standard_fonts', 'wasm'].map((directory) =>
        cp(resolve(source, directory), resolve(output, directory), { recursive: true })
      ))
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react(), pdfAssets()]
  }
})
