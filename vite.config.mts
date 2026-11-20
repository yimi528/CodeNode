import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const pdfRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

export default defineConfig({
  plugins: [react(), {
    name: 'pdf-preview-assets',
    apply: 'build',
    buildStart() {
      this.emitFile({ type: 'asset', fileName: 'pdf-assets/LICENSE', source: readFileSync(join(pdfRoot, 'LICENSE')) });
      for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
        const sourceDirectory = join(pdfRoot, directory);
        for (const name of readdirSync(sourceDirectory)) {
          if (directory === 'wasm' && !name.endsWith('_nowasm_fallback.js') && !name.startsWith('LICENSE')) continue;
          this.emitFile({ type: 'asset', fileName: `pdf-assets/${directory}/${name}`, source: readFileSync(join(sourceDirectory, name)) });
        }
      }
    },
  }],
  base: './',
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
