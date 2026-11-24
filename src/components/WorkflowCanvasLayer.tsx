import { useEffect, useRef, useState } from 'react';
import { useStore, type Edge, type Node } from '@xyflow/react';
import { useUiStore } from '../store/uiStore';
import { useVectorPlugin } from '../plugins/vectorEditor';
import { boundaryLabel, nodePresentation } from '../nodes/presentation';

export const CANVAS_GRID_SIZE = 22;
const SOLID_MATERIAL_QUERY = '(prefers-reduced-transparency: reduce), (prefers-contrast: more)';

type Point = { x: number; y: number };
type NodeData = { boundary?: string; label?: string; status?: string; accent?: string; prompt?: string; goal?: string; subtitle?: string; filePath?: string; imagePath?: string; dataUrl?: string; width?: number; height?: number; fill?: string; opacity?: number; collapsed?: boolean; objectName?: string };

const iconPaths = new Map<string, Path2D>();

function iconPath(path: string): Path2D {
  const cached = iconPaths.get(path);
  if (cached) return cached;
  const drawing = new Path2D(path);
  iconPaths.set(path, drawing);
  return drawing;
}

const STATUS_LABEL: Record<string, string> = { pending: '待执行', running: '执行中', done: '已完成', failed: '失败', blocked: '阻塞' };

function size(node: Node): { width: number; height: number } {
  const data = node.data as NodeData;
  return {
    width: Number(node.measured?.width) || Number(data.width) || (node.type === 'scope' ? 320 : node.type === 'vector' ? 1040 : node.type === 'image' ? 320 : 176),
    height: Number(node.measured?.height) || Number(data.height) || (node.type === 'scope' ? 220 : node.type === 'vector' ? 640 : node.type === 'image' ? 224 : 100),
  };
}

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

function text(ctx: CanvasRenderingContext2D, value: unknown, x: number, y: number, maxWidth: number): void {
  const label = String(value || '');
  if (!label) return;
  if (ctx.measureText(label).width <= maxWidth) { ctx.fillText(label, x, y); return; }
  let end = label.length;
  while (end > 1 && ctx.measureText(label.slice(0, end) + '…').width > maxWidth) end--;
  ctx.fillText(label.slice(0, end) + '…', x, y);
}

function edgePath(ctx: CanvasRenderingContext2D, points: Point[]): void {
  if (points.length < 2) return;
  const a = points[0];
  const b = points[points.length - 1];
  ctx.moveTo(a.x, a.y);
  if (points.length === 2) {
    const direction = b.x >= a.x ? 1 : -1;
    const bend = Math.max(32, Math.min(180, Math.abs(b.x - a.x) * .5));
    ctx.bezierCurveTo(a.x + bend * direction, a.y, b.x - bend * direction, b.y, b.x, b.y);
    return;
  }
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const next = points[i + 1];
    ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
  }
  ctx.lineTo(b.x, b.y);
}

export default function WorkflowCanvasLayer({ nodes, edges, hoveredEdgeId, cutLine }: { nodes: Node[]; edges: Edge[]; hoveredEdgeId: string | null; cutLine: Point[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [bounds, setBounds] = useState({ width: 1, height: 1 });
  const transform = useStore((state) => state.transform);
  const theme = useUiStore((state) => state.theme);
  const hoverScopeId = useUiStore((state) => state.hoverScopeId);
  const images = useRef(new Map<string, HTMLImageElement>());
  const [vectorRevision, setVectorRevision] = useState(0);
  const [animationTick, setAnimationTick] = useState(0);
  const [solidMaterial, setSolidMaterial] = useState(() => window.matchMedia(SOLID_MATERIAL_QUERY).matches);
  const plugin = useVectorPlugin(s => s.plugin);
  const enabled = useUiStore(s => s.preferences.vectorEditorEnabled);
  const vectorIds = nodes.filter((node) => node.type === 'vector').map((node) => node.id).join('|');
  const animating = nodes.some((node) => node.type === 'scope' && (node.data as NodeData).status === 'running') || edges.some((edge) => edge.animated);

  useEffect(() => {
    const preference = window.matchMedia(SOLID_MATERIAL_QUERY);
    const update = () => setSolidMaterial(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!animating || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setAnimationTick((tick) => tick + 1), 80);
    return () => window.clearInterval(timer);
  }, [animating]);

  useEffect(() => {
    if (!enabled || !plugin) return;
    const unsubscribe = vectorIds.split('|').filter(Boolean).map((id) => plugin.getVectorStore(id).subscribe(() => setVectorRevision((revision) => revision + 1)));
    return () => unsubscribe.forEach((stop) => stop());
  }, [vectorIds, plugin, enabled]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas?.parentElement) return;
    const observer = new ResizeObserver(() => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      setBounds({ width: rect.width, height: rect.height });
    });
    observer.observe(canvas.parentElement);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || bounds.width < 1 || bounds.height < 1) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(bounds.width * ratio);
    canvas.height = Math.round(bounds.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, bounds.width, bounds.height);
    const style = getComputedStyle(canvas);
    const dot = token(style, '--canvas-dot', '#64748b');
    const surface = token(style, '--glass-surface', '#ffffff');
    const foreground = token(style, '--glass-text', '#172033');
    const muted = token(style, '--glass-muted', '#64748b');
    const border = token(style, '--glass-border', '#94a3b8');
    const edgeColor = token(style, '--edge-color', '#777777');
    const glass = {
      top: token(style, '--node-glass-top', surface),
      center: token(style, '--node-glass-center', surface),
      bottom: token(style, '--node-glass-bottom', surface),
      rim: token(style, '--node-glass-rim', border),
      border: token(style, '--node-glass-border', border),
      selection: token(style, '--node-glass-selection', foreground),
      shadow: token(style, '--node-glass-shadow', 'transparent'),
    };
    const statuses: Record<string, string> = {
      running: token(style, '--stage-running', '#f59e0b'),
      done: token(style, '--stage-done', '#22c55e'),
      failed: token(style, '--stage-failed', '#ef4444'),
      blocked: token(style, '--stage-blocked', '#8b5cf6'),
    };
    const [tx, ty, zoom] = transform;
    const gap = CANVAS_GRID_SIZE * zoom;
    if (gap >= 12) {
      ctx.fillStyle = dot;
      ctx.globalAlpha = .38;
      const x0 = ((tx % gap) + gap) % gap;
      const y0 = ((ty % gap) + gap) % gap;
      for (let x = x0; x < bounds.width; x += gap) for (let y = y0; y < bounds.height; y += gap) {
        ctx.beginPath(); ctx.arc(x, y, Math.max(.55, Math.min(1.1, zoom)), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(zoom, zoom);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const edge of edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) continue;
      const sourceSize = size(source);
      const targetSize = size(target);
      const waypoints = ((edge.data as { waypoints?: Point[] } | undefined)?.waypoints) || [];
      const points = [
        { x: source.position.x + sourceSize.width, y: source.position.y + sourceSize.height / 2 },
        ...waypoints,
        { x: target.position.x, y: target.position.y + targetSize.height / 2 },
      ];
      ctx.beginPath(); edgePath(ctx, points);
      ctx.strokeStyle = String(edge.style?.stroke || ((edge.selected || hoveredEdgeId === edge.id) ? token(style, '--glass-accent', '#66d9ff') : edgeColor));
      ctx.globalAlpha = Number(edge.style?.strokeOpacity ?? 1);
      ctx.lineWidth = Number(edge.style?.strokeWidth || ((edge.selected || hoveredEdgeId === edge.id) ? 3 : 2));
      if (edge.animated) { ctx.setLineDash([8, 6]); ctx.lineDashOffset = -animationTick * 2; }
      ctx.lineCap = 'round'; ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      for (const point of waypoints) { ctx.beginPath(); ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2); ctx.fillStyle = surface; ctx.fill(); ctx.strokeStyle = edgeColor; ctx.lineWidth = 1; ctx.stroke(); }
    }
    for (const node of [...nodes].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0))) {
      const data = node.data as NodeData;
      const { width, height } = size(node);
      const { x, y } = node.position;
      if ((x + width) * zoom + tx < -40 || x * zoom + tx > bounds.width + 40 || (y + height) * zoom + ty < -40 || y * zoom + ty > bounds.height + 40) continue;
      // Rich editors remain live DOM surfaces while selected; Canvas paints their inactive preview.
      if (node.selected && ['vector', 'image', 'scope', 'object'].includes(node.type || '')) continue;
      const accent = data.accent || token(style, '--canvas-node-accent', '#3b82f6');
      const activeStatus = statuses[data.status || ''];
      const statusColor = activeStatus || token(style, '--canvas-idle-text', muted);
      const isScope = node.type === 'scope';
      const radius = isScope ? 11 : 10;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, width, height, radius);
      if (isScope) {
        ctx.fillStyle = `${data.fill || '#3b2f6b'}${Math.round((data.opacity ?? .16) * 255).toString(16).padStart(2, '0')}`;
        ctx.setLineDash([7, 5]);
      } else if (solidMaterial) {
        ctx.fillStyle = glass.center;
      } else {
        const fill = ctx.createLinearGradient(x, y, x, y + height);
        fill.addColorStop(0, glass.top);
        fill.addColorStop(.35, glass.center);
        fill.addColorStop(1, glass.bottom);
        ctx.fillStyle = fill;
        ctx.shadowColor = glass.shadow;
        ctx.shadowBlur = 7 * ratio * zoom;
        ctx.shadowOffsetY = 3 * ratio * zoom;
      }
      ctx.fill();
      ctx.shadowOffsetY = 0;
      ctx.shadowBlur = 0;
      if (isScope) {
        ctx.strokeStyle = node.selected
          ? token(style, '--skin-selection-border', token(style, '--glass-accent', accent))
          : hoverScopeId === node.id ? accent : activeStatus || accent;
        ctx.lineWidth = node.selected ? 2.5 : 1.4;
        if (data.status === 'running' && !solidMaterial) {
          ctx.shadowColor = statusColor;
          ctx.shadowBlur = 7 + 3 * Math.sin(animationTick * .28);
        }
      } else {
        const rim = ctx.createLinearGradient(x, y, x, y + height);
        rim.addColorStop(0, glass.rim);
        rim.addColorStop(.6, glass.border);
        ctx.strokeStyle = node.selected ? glass.selection : solidMaterial ? glass.border : rim;
        ctx.lineWidth = node.selected ? 1.6 : 1;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      const icon = nodePresentation(node.type);
      ctx.save();
      ctx.translate(x + 10, y + 8);
      ctx.scale(.8, .8);
      ctx.strokeStyle = icon.color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.stroke(iconPath(icon.path));
      ctx.restore();
      if (isScope) {
        ctx.fillStyle = foreground; ctx.font = '600 13px sans-serif'; text(ctx, `${data.collapsed ? '▸' : '▾'} ${data.label || '分组'}`, x + 34, y + 24, width - 46);
        ctx.fillStyle = muted; ctx.font = '11px sans-serif'; text(ctx, data.collapsed ? '已折叠' : '分组', x + 12, y + 43, width - 24);
      } else {
        ctx.fillStyle = foreground; ctx.font = '600 13px sans-serif'; text(ctx, data.label || node.id, x + 33, y + 23, width - 45);
        const detail = data.goal || data.prompt || data.filePath || data.imagePath || data.objectName || data.subtitle || (node.type === 'vector' ? '点击节点编辑矢量画布' : '');
        ctx.fillStyle = muted; ctx.font = '11px sans-serif'; text(ctx, detail, x + 12, y + Math.min(47, height - 28), width - 24);
        if (node.type === 'image' && data.dataUrl) {
          let image = images.current.get(data.dataUrl);
          if (!image) {
            image = new Image(); image.src = data.dataUrl; image.onload = () => setBounds((previous) => ({ ...previous }));
            images.current.set(data.dataUrl, image);
          }
          if (image.complete && image.naturalWidth) {
            const box = { x: x + 12, y: y + 54, width: width - 24, height: Math.max(16, height - 80) };
            const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
            ctx.drawImage(image, box.x + (box.width - image.naturalWidth * scale) / 2, box.y + (box.height - image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
          }
        }
        if (node.type === 'vector' && enabled && plugin) plugin.vectorPreview(ctx, node.id, x, y, width, height);
        ctx.strokeStyle = border; ctx.lineWidth = .8; ctx.beginPath(); ctx.moveTo(x, y + height - 27); ctx.lineTo(x + width, y + height - 27); ctx.stroke();
        ctx.fillStyle = statusColor; ctx.beginPath(); ctx.arc(x + 13, y + height - 14, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = activeStatus ? foreground : muted;
        ctx.font = '10px sans-serif'; text(ctx, [STATUS_LABEL[data.status || 'pending'] || data.status, boundaryLabel(data.boundary)].filter(Boolean).join(' · '), x + 22, y + height - 10, width - 32);
        if (node.type !== 'start') { ctx.beginPath(); ctx.arc(x, y + height / 2, 4, 0, Math.PI * 2); ctx.fillStyle = accent; ctx.fill(); }
        if (node.type !== 'end') { ctx.beginPath(); ctx.arc(x + width, y + height / 2, 4, 0, Math.PI * 2); ctx.fillStyle = accent; ctx.fill(); }
      }
      ctx.restore();
    }
    ctx.restore();
    if (cutLine.length > 1) {
      ctx.beginPath(); ctx.moveTo(cutLine[0].x, cutLine[0].y);
      for (const point of cutLine.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.strokeStyle = '#f43f5e'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
  }, [nodes, edges, bounds, transform, theme, hoverScopeId, hoveredEdgeId, cutLine, vectorRevision, animationTick, plugin, enabled, solidMaterial]);

  return <canvas ref={ref} className="workflow-canvas-layer" aria-hidden="true" />;
}
