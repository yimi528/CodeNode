import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url&no-inline';

GlobalWorkerOptions.workerSrc = new URL(workerUrl, document.baseURI).href;

function pdfAsset(directory: string) {
  const base = import.meta.env.DEV ? '/node_modules/pdfjs-dist/' : './pdf-assets/';
  return new URL(`${base}${directory}/`, document.baseURI).href;
}

export default function PdfPreview({ data }: { data: Uint8Array }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let loading: PDFDocumentLoadingTask | undefined;
    void (async () => {
      if (location.protocol === 'file:') {
        // PDF.js uses its in-process worker for the packaged file:// renderer.
        const scope = globalThis as typeof globalThis & { pdfjsWorker?: unknown };
        scope.pdfjsWorker ??= await import(/* @vite-ignore */ GlobalWorkerOptions.workerSrc);
      }
      if (!active) return;
      loading = getDocument({
        data: data.slice(),
        cMapUrl: pdfAsset('cmaps'),
        standardFontDataUrl: pdfAsset('standard_fonts'),
        wasmUrl: pdfAsset('wasm'),
        useWorkerFetch: false,
        useWasm: false,
        canvasMaxAreaInBytes: 32 * 1024 * 1024,
      });
      const document = await loading.promise;
      if (active) setPdf(document);
    })().catch(error => {
      if (active) {
        console.warn('PDF preview load failed', error);
        setError(error?.name === 'PasswordException' ? '该 PDF 需要密码才能预览' : '无法读取此 PDF');
      }
    });
    return () => { active = false; void loading?.destroy().catch(() => {}); };
  }, [data]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!pdf || !canvas) return;
    let active = true;
    let render: RenderTask | undefined;
    void (async () => {
      const pdfPage = await pdf.getPage(page);
      if (!active) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(2, 2400 / Math.max(base.width, base.height));
      const viewport = pdfPage.getViewport({ scale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `min(100%, ${base.width}px)`;
      render = pdfPage.render({ canvas, viewport });
      await render.promise;
      if (active) setReady(true);
    })().catch(error => {
      if (active) {
        console.warn('PDF preview render failed', error);
        setError('无法渲染此页 PDF');
      }
    });
    return () => { active = false; render?.cancel(); };
  }, [pdf, page]);

  function turnPage(next: number) {
    setReady(false);
    setError('');
    setPage(next);
  }

  return <>
    {pdf && pdf.numPages > 1 && <div className="fp-actions fp-pdf-controls" aria-label="PDF 翻页">
      <button type="button" onClick={() => turnPage(page - 1)} disabled={page === 1}>上一页</button>
      <span aria-live="polite">第 {page} / {pdf.numPages} 页</span>
      <button type="button" onClick={() => turnPage(page + 1)} disabled={page === pdf.numPages}>下一页</button>
    </div>}
    <div className="fp-media">
      {!ready && !error && <div className="pm-preview-empty" role="status">正在渲染 PDF…</div>}
      {error && <div role="alert" className="pm-preview-empty">{error}</div>}
      <canvas ref={canvasRef} hidden={!ready || !!error} aria-label={`PDF 第 ${page} 页`} />
    </div>
  </>;
}
