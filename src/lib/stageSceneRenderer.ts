import type { ComponentKind, SceneComponent } from './stageScene';

type Point = [number, number, number];
type Projected = { x: number; y: number; depth: number };
type ScreenPoint = { x: number; y: number };
type Face = { points: Projected[]; depth: number; fill: string | CanvasGradient; kind?: ComponentKind };
type View = { azimuth: number; elevation: number };
export type StageSceneTarget = { kind: ComponentKind; type: 'component' | 'connection' };
type HitRegion = StageSceneTarget & { points: ScreenPoint[] };

function hits(region: HitRegion, x: number, y: number) {
  let inside = false;
  for (let index = 0; index < region.points.length; index++) {
    const a = region.points[index];
    const b = region.points[(index + 1) % region.points.length];
    if (region.type === 'component') {
      if ((a.y > y) !== (b.y > y) && x < a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y)) inside = !inside;
    } else if (index < region.points.length - 1) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      if ((x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2 <= 25) return true;
    }
  }
  return inside;
}

export const initialStageView: View = { azimuth: .25, elevation: .57 };
const positions: Record<ComponentKind, [number, number]> = {
  frontend: [-2.65, .38], api: [-.4, -.36], database: [1.91, -1.26],
  cache: [1.9, 1.13], config: [-.36, -1.77], tests: [-.83, 1.58], files: [-2.62, -1.43],
};

const colors = { light: '#fff', shadow: '#4a5668', neutral: '#a4aebc', trim: '#748193', active: '#78a4ec', accent: '#246bdb' };

export function drawStageScene(ctx: CanvasRenderingContext2D, width: number, height: number, view: View, components: SceneComponent[], entrance: number) {
  const faces: Face[] = [];
  const labels: { kind: ComponentKind; text: string; point: Projected; change: SceneComponent['change'] }[] = [];
  const regions: HitRegion[] = [];
  let drawingKind: ComponentKind | undefined;
  const sin = Math.sin(view.azimuth), cos = Math.cos(view.azimuth);
  const rise = Math.sin(view.elevation), tilt = Math.cos(view.elevation);
  const projectedBoardWidth = 7.5 * Math.abs(cos) + 4.68 * Math.abs(sin);
  const unit = Math.min(Math.max(1, width - 24) / Math.max(8.5, projectedBoardWidth), Math.max(1, height - 22) / (4.2 + rise * 3));
  const project = ([x, y, z]: Point): Projected => {
    const back = x * sin + z * cos;
    return { x: width / 2 + (x * cos - z * sin) * unit,
      y: height * .53 + (back * rise - y * tilt) * unit, depth: back * tilt + y * rise };
  };
  const path = (points: Projected[]) => {
    ctx.beginPath();
    points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  };
  const polygon = (points: Projected[], fill: string | CanvasGradient) => {
    path(points);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  const line = (points: Point[], stroke: string, lineWidth = 1) => {
    path(points.map(project));
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  };
  const shade = (base: string, light: number) => {
    const toward = light > 0 ? colors.light : colors.shadow;
    return `color-mix(in srgb, ${base} ${100 - Math.abs(light)}%, ${toward})`;
  };
  const face = (vertices: Point[], fill: string) => {
    const points = vertices.map(project);
    // Outward winding lets the camera discard surfaces on the back of the solid.
    const [a, b, c] = points;
    if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) >= 0) return;
    const min = Math.min(...points.map(point => point.y));
    const max = Math.max(...points.map(point => point.y));
    const lighting = ctx.createLinearGradient(0, min, 0, max + .1);
    lighting.addColorStop(0, shade(fill, 12));
    lighting.addColorStop(1, shade(fill, -19));
    faces.push({ points, fill: lighting, kind: drawingKind, depth: points.reduce((sum, point) => sum + point.depth, 0) / points.length });
  };
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, fill: string) => {
    const l = x - w / 2, r = x + w / 2, f = z + d / 2, b = z - d / 2, t = y + h;
    face([[l, t, f], [r, t, f], [r, t, b], [l, t, b]], shade(fill, 44));
    face([[l, y, f], [r, y, f], [r, t, f], [l, t, f]], fill);
    face([[r, y, b], [l, y, b], [l, t, b], [r, t, b]], shade(fill, -18));
    face([[r, y, f], [r, y, b], [r, t, b], [r, t, f]], shade(fill, -28));
    face([[l, y, b], [l, y, f], [l, t, f], [l, t, b]], shade(fill, 13));
  };
  const drum = (x: number, y: number, z: number, height: number, radius: number, fill: string) => {
    const rim = Array.from({ length: 36 }, (_, i): Point => {
      const angle = i / 36 * Math.PI * 2;
      return [x + Math.cos(angle) * radius, y, z + Math.sin(angle) * radius];
    });
    const top = rim.map(([px, py, pz]): Point => [px, py + height, pz]);
    rim.forEach((a, i) => {
      const next = (i + 1) % rim.length;
      const light = Math.cos(i / 36 * Math.PI * 2 + 1.8);
      face([rim[next], a, top[i], top[next]], shade(fill, Math.round(light * 26 + Math.max(0, light) ** 10 * 31)));
    });
    face(top.slice().reverse(), shade(fill, 48));
  };

  ctx.clearRect(0, 0, width, height);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const backdrop = ctx.createLinearGradient(0, 0, 0, height);
  backdrop.addColorStop(0, '#fcfdff');
  backdrop.addColorStop(1, '#eef2f8');
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, width, height);
  const paintFaces = () => {
    faces.sort((a, b) => a.depth - b.depth);
    faces.forEach(({ points, fill, kind }) => {
      polygon(points, fill);
      if (kind) regions.push({ kind, type: 'component', points });
    });
    faces.length = 0;
  };
  box(0, -.18, 0, 7.5, .18, 4.68, '#c6ceda');
  paintFaces();
  polygon(([[-3.75, .001, 2.34], [3.75, .001, 2.34], [3.75, .001, -2.34], [-3.75, .001, -2.34]] as Point[]).map(project), '#f9fafc');
  for (let x = -3.6; x <= 3.6; x += .4) line([[x, .004, -2.2], [x, .004, 2.2]], '#d8dfe9', .7);
  for (let z = -2.2; z <= 2.21; z += .4) line([[-3.6, .004, z], [3.6, .004, z]], '#d8dfe9', .7);

  function contact(x: number, z: number, radius: number) {
    const p = project([x + .28, .01, z - .15]);
    const shadow = ctx.createRadialGradient(0, 0, .12, 0, 0, 1);
    shadow.addColorStop(0, '#40557550');
    shadow.addColorStop(.5, '#40557529');
    shadow.addColorStop(1, '#40557500');
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-.22);
    ctx.scale(unit * radius, unit * radius * (.30 + rise * .38));
    ctx.fillStyle = shadow;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
  const connection = (kind: ComponentKind, active: boolean) => {
    const [x, z] = positions[kind];
    const start = project([x, .024, z]);
    const middle = project([x * .76, .024, .24]);
    const end = project([0, .024, .24]);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.bezierCurveTo(start.x, middle.y, middle.x, end.y, end.x, end.y);
    ctx.lineWidth = active ? 2.8 : 2;
    ctx.strokeStyle = active ? colors.accent : '#8291a4';
    ctx.stroke();
    const points = Array.from({ length: 21 }, (_, index) => {
      const t = index / 20, s = 1 - t;
      return {
        x: s ** 3 * start.x + 3 * s ** 2 * t * start.x + 3 * s * t ** 2 * middle.x + t ** 3 * end.x,
        y: s ** 3 * start.y + 3 * s ** 2 * t * middle.y + 3 * s * t ** 2 * end.y + t ** 3 * end.y,
      };
    });
    regions.push({ kind, type: 'connection', points });
  };

  for (const { kind, change } of [...components].sort((a, b) => Number(Boolean(a.change)) - Number(Boolean(b.change)))) {
    connection(kind, Boolean(change));
  }
  components.forEach(component => {
    drawingKind = component.kind;
    const [x, z] = positions[component.kind];
    const active = component.change !== null;
    const lift = component.change === 'added' ? (1 - entrance) * .32 : 0;
    const base = active ? colors.active : colors.neutral;
    const detail = active ? colors.accent : colors.trim;
    contact(x, z, component.kind === 'database' ? 1.45 : 1.18);
    let top = .81;
    if (component.kind === 'database') {
      drum(x, .014 + lift, z, .10, .64, base);
      for (let layer = 0; layer < 3; layer++) {
        drum(x, .105 + lift + layer * .405, z, .377, .56, base);
        drum(x, .482 + lift + layer * .405, z, .038, .581, shade(base, 22));
      }
      drum(x, 1.33 + lift, z, .045, .39, shade(base, 55));
      top = 1.42;
    } else if (component.kind === 'frontend') {
      box(x, .02 + lift, z, 1.02, .10, .66, base);
      box(x, .12 + lift, z, .35, .27, .24, detail);
      box(x, .36 + lift, z, 1.38, .84, .22, base);
      box(x, .43 + lift, z + .119, 1.20, .67, .025, shade(base, 59));
      box(x, .97 + lift, z + .139, 1.01, .07, .017, detail);
      box(x - .35, .51 + lift, z + .139, .24, .34, .017, shade(base, 4));
      box(x + .15, .77 + lift, z + .139, .55, .052, .017, detail);
      box(x + .08, .63 + lift, z + .139, .42, .052, .017, detail);
      top = 1.25;
    } else if (component.kind === 'api') {
      box(x, .02 + lift, z, 1.3, .10, .94, base);
      for (let layer = 0; layer < 3; layer++) {
        const y = .12 + lift + layer * .29;
        box(x, y, z, 1.15, .266, .88, base);
        box(x, y + .055, z + .448, .98, .15, .029, shade(base, 48));
        box(x - .13, y + .115, z + .468, .49, .034, .019, detail);
        box(x + .32, y + .102, z + .469, .11, .063, .019, detail);
      }
      box(x, .98 + lift, z, 1.24, .10, .94, base);
      top = 1.14;
    } else {
      box(x, .025 + lift, z, 1.25, .08, 1, base);
      box(x, .105 + lift, z, 1.10, .13, .84, base);
      box(x, .235 + lift, z, .91, .40, .66, shade(base, 16));
      box(x, .635 + lift, z, .75, .07, .53, detail);
      box(x, .705 + lift, z, .34, .055, .26, base);
      for (const offset of [-.39, -.23, -.07, .09, .25, .41]) {
        box(x + offset, .198 + lift, z + .397, .063, .09, .142, detail);
      }
    }
    const suffix = component.change === 'added' ? ' 新增' : component.change ? ' 修改' : '';
    labels.push({ kind: component.kind, text: component.label + suffix, point: project([x, top + lift, z]), change: component.change });
  });
  paintFaces();

  ctx.font = `500 ${width > 500 ? 13 : 11}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const placed: { x: number; y: number; width: number }[] = [];
  for (const { kind, text, point, change } of labels) {
    const size = Math.ceil(ctx.measureText(text).width) + 10;
    const x = Math.max(size / 2 + 2, Math.min(width - size / 2 - 2, point.x));
    let y = Math.max(12, point.y - 12);
    while (placed.some(label => Math.abs(label.y - y) < 18 && Math.abs(label.x - x) < (label.width + size) / 2 + 3)) y -= 19;
    if (y < 9) continue;
    placed.push({ x, y, width: size });
    ctx.beginPath();
    if (change) {
      ctx.roundRect(x - size / 2, y - 9, size, 18, 5);
      ctx.fillStyle = '#dce9ff';
      ctx.fill();
    }
    ctx.fillStyle = change ? '#174b9b' : '#293648';
    ctx.fillText(text, x, y);
    regions.push({ kind, type: 'component', points: [
      { x: x - size / 2, y: y - 9 }, { x: x + size / 2, y: y - 9 },
      { x: x + size / 2, y: y + 9 }, { x: x - size / 2, y: y + 9 },
    ] });
  }
  regions.reverse();
  return (x: number, y: number): StageSceneTarget | null => regions.find(region => hits(region, x, y)) ?? null;
}
