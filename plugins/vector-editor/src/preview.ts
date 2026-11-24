import { getVectorStore } from './vectorStore';
import type { VecObject } from './types';

export function vectorPreview(ctx: CanvasRenderingContext2D, nodeId: string, x: number, y: number, width: number, height: number): void {
  const objects = getVectorStore(nodeId).getState().objects.filter((item) => item.visible);
  if (!objects.length) return;
  const frame = { x: x + 10, y: y + 36, width: width - 20, height: Math.max(20, height - 72) };
  ctx.save();
  ctx.beginPath(); ctx.rect(frame.x, frame.y, frame.width, frame.height); ctx.clip();
  const bounds = objects.reduce((result, item) => ({
    x0: Math.min(result.x0, item.x), y0: Math.min(result.y0, item.y),
    x1: Math.max(result.x1, item.x + item.width), y1: Math.max(result.y1, item.y + item.height),
  }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  const { x0, y0, x1, y1 } = bounds;
  const scale = Math.min((frame.width - 36) / Math.max(1, x1 - x0), (frame.height - 36) / Math.max(1, y1 - y0), 2);
  ctx.translate(frame.x + (frame.width - (x1 - x0) * scale) / 2, frame.y + (frame.height - (y1 - y0) * scale) / 2);
  ctx.scale(scale, scale); ctx.translate(-x0, -y0);
  for (const item of objects) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, item.opacity / 100));
    ctx.translate(item.x + item.width / 2, item.y + item.height / 2);
    ctx.rotate(item.rotation * Math.PI / 180);
    ctx.translate(-item.width / 2, -item.height / 2);
    ctx.fillStyle = item.fill === 'none' ? 'transparent' : item.fill;
    ctx.strokeStyle = item.stroke === 'none' ? 'transparent' : item.stroke;
    ctx.lineWidth = item.strokeWidth || 1;
    ctx.setLineDash(item.strokeStyle === 'dashed' ? [8, 5] : item.strokeStyle === 'dotted' ? [2, 4] : []);
    drawVectorObject(ctx, item);
    ctx.restore();
  }
  ctx.restore();
}

function drawVectorObject(ctx: CanvasRenderingContext2D, item: VecObject): void {
  ctx.beginPath();
  if (item.type === 'ellipse') ctx.ellipse(item.width / 2, item.height / 2, Math.max(1, item.width / 2), Math.max(1, item.height / 2), 0, 0, Math.PI * 2);
  else if (item.type === 'arrow') { ctx.moveTo(0, item.height / 2); ctx.lineTo(item.width, item.height / 2); ctx.moveTo(item.width - 14, item.height / 2 - 9); ctx.lineTo(item.width, item.height / 2); ctx.lineTo(item.width - 14, item.height / 2 + 9); }
  else if (item.type === 'bezier' && item.anchors?.length) {
    const anchors = item.anchors;
    ctx.moveTo(anchors[0].x, anchors[0].y);
    for (let i = 1; i < anchors.length; i++) {
      const previous = anchors[i - 1]; const current = anchors[i];
      ctx.bezierCurveTo(previous.hOut?.x ?? previous.x, previous.hOut?.y ?? previous.y, current.hIn?.x ?? current.x, current.hIn?.y ?? current.y, current.x, current.y);
    }
    if (item.closed) ctx.closePath();
  } else if (item.type !== 'text') ctx.roundRect(0, 0, item.width, item.height, item.type === 'rounded' ? item.radius : 0);
  if (item.fill !== 'none' && item.type !== 'arrow' && item.type !== 'text') ctx.fill();
  if (item.stroke !== 'none' && item.type !== 'text') ctx.stroke();
  if (item.text) {
    ctx.fillStyle = item.textColor || '#f8fafc';
    ctx.font = `${item.fontWeight || 400} ${item.fontSize || 16}px ${item.fontFamily || 'sans-serif'}`;
    ctx.textAlign = item.textAlign || 'left';
    const textX = item.textAlign === 'center' ? item.width / 2 : item.textAlign === 'right' ? item.width : 0;
    ctx.fillText(item.text.split('\n')[0], textX, item.type === 'text' ? (item.fontSize || 16) : item.height / 2 + (item.fontSize || 16) / 3, item.width);
    ctx.textAlign = 'left';
  }
}
