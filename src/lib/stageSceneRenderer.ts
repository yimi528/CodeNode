import type { ComponentKind, SceneComponent } from './stageScene';

type Point = [number, number, number];
type Projected = { x: number; y: number; depth: number };
type FaceDetail = () => void;
type Face = { points: Projected[]; depth: number; fill: CanvasGradient; detail?: FaceDetail; highlight: boolean };
type View = { azimuth: number; elevation: number; zoom: number };
export const initialStageView: View = { azimuth: -.14, elevation: .79, zoom: 1 };
const positions: Record<ComponentKind, [number, number]> = {
  frontend: [-3, 0], api: [3, 0], database: [0, -1.47],
  cache: [1.65, -1.4], config: [-1.65, -1.4], tests: [1.65, 1.4], files: [-1.65, 1.4],
};

const colors = {
  light: '#fff',
  shadow: '#20272e',
  neutral: '#555e65',
  trim: '#a0a5aa',
  accent: '#b5e0fa',
};

const activeMaterials: Record<ComponentKind, string> = {
  frontend: '#7192a9', api: '#7585a4', database: '#8295aa',
  cache: '#5b9892', config: '#8385ab', tests: '#7395ad', files: '#b29a6c',
};

export function drawStageScene(ctx: CanvasRenderingContext2D, width: number, height: number, view: View, components: SceneComponent[], entrance: number) {
  const faces: Face[] = [];
  const sin = Math.sin(view.azimuth), cos = Math.cos(view.azimuth);
  const rise = Math.sin(view.elevation), tilt = Math.cos(view.elevation);
  const projectedBoardWidth = 7.5 * Math.abs(cos) + 4.68 * Math.abs(sin);
  const unit = view.zoom * Math.min(Math.max(1, width - 24) / Math.max(7.8, projectedBoardWidth), Math.max(1, height - 22) / (3.85 + Math.abs(rise) * 2.2));
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
  const face = (vertices: Point[], fill: string, highlight = false, detail?: FaceDetail) => {
    const points = vertices.map(project);
    // Outward winding lets the camera discard surfaces on the back of the solid.
    const [a, b, c] = points;
    if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) >= 0) return;
    const min = Math.min(...points.map(point => point.y));
    const max = Math.max(...points.map(point => point.y));
    const lighting = ctx.createLinearGradient(0, min, 0, max + .1);
    lighting.addColorStop(0, shade(fill, 12));
    lighting.addColorStop(1, shade(fill, -19));
    faces.push({ points, fill: lighting, highlight, detail, depth: points.reduce((sum, point) => sum + point.depth, 0) / points.length });
  };
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, fill: string, highlight = false, marks?: { top?: FaceDetail; front?: FaceDetail }) => {
    const l = x - w / 2, r = x + w / 2, f = z + d / 2, b = z - d / 2, t = y + h;
    face([[l, y, b], [r, y, b], [r, y, f], [l, y, f]], shade(fill, -32));
    face([[l, t, f], [r, t, f], [r, t, b], [l, t, b]], shade(fill, 44), highlight, marks?.top);
    face([[l, y, f], [r, y, f], [r, t, f], [l, t, f]], fill, false, marks?.front);
    face([[r, y, b], [l, y, b], [l, t, b], [r, t, b]], shade(fill, -18));
    face([[r, y, f], [r, y, b], [r, t, b], [r, t, f]], shade(fill, -28));
    face([[l, y, b], [l, y, f], [l, t, f], [l, t, b]], shade(fill, 13));
  };
  const drum = (x: number, y: number, z: number, height: number, radius: number, fill: string, highlight = false) => {
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
    face(rim, shade(fill, -32));
    face(top.slice().reverse(), shade(fill, 48), highlight);
  };

  ctx.clearRect(0, 0, width, height);

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const paintFaces = () => {
    faces.sort((a, b) => a.depth - b.depth);
    faces.forEach(({ points, fill, highlight, detail }) => {
      polygon(points, fill);
      if (detail) {
        // Map the unit square onto the visible face so markings rotate and occlude with it.
        const [origin, right, , up] = points;
        ctx.save();
        ctx.transform(right.x - origin.x, right.y - origin.y, up.x - origin.x, up.y - origin.y, origin.x, origin.y);
        detail();
        ctx.restore();
      }
      if (highlight) {
        ctx.save();
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 1.25;
        ctx.shadowColor = 'rgb(166 219 250 / 55%)';
        ctx.shadowBlur = 7;
        ctx.stroke();
        ctx.restore();
      }
    });
    faces.length = 0;
  };
  const board: Point[] = [[-3.6, 0, 2.2], [3.6, 0, 2.2], [3.6, 0, -2.2], [-3.6, 0, -2.2]];
  polygon(board.map(project), '#7599b617');
  for (let x = -3.6; x <= 3.61; x += .4) line([[x, 0, -2.2], [x, 0, 2.2]], '#97b5cd26', .7);
  for (let z = -2.2; z <= 2.21; z += .4) line([[-3.6, 0, z], [3.6, 0, z]], '#97b5cd26', .7);

  function contact(x: number, z: number, radius: number) {
    const p = project([x + .28, .01, z - .15]);
    const shadow = ctx.createRadialGradient(0, 0, .12, 0, 0, 1);
    shadow.addColorStop(0, '#000b');
    shadow.addColorStop(.5, '#0005');
    shadow.addColorStop(1, '#0000');
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-.22);
    ctx.scale(unit * radius, unit * radius * (.30 + Math.abs(rise) * .38));
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
    ctx.lineWidth = active ? 1.7 : 1.1;
    ctx.strokeStyle = active ? colors.accent : '#888';
    ctx.stroke();
  };

  for (const { kind, change } of [...components].sort((a, b) => Number(Boolean(a.change)) - Number(Boolean(b.change)))) {
    connection(kind, Boolean(change));
  }
  if (!components.length) return;
  contact(0, .24, 1.4);
  box(0, .02, .24, 1.04, .21, .94, '#546576');
  box(0, .23, .24, .85, .12, .75, '#738998');
  components.forEach(component => {
    const [x, z] = positions[component.kind];
    const active = component.change !== null;
    const lift = component.change === 'added' ? (1 - entrance) * .32 : 0;
    const base = active ? activeMaterials[component.kind] : colors.neutral;
    const detail = active ? colors.accent : colors.trim;
    contact(x, z, component.kind === 'database' ? 1.45 : 1.18);
    if (component.kind === 'database') {
      drum(x, .014 + lift, z, .10, .64, base);
      for (let layer = 0; layer < 3; layer++) {
        drum(x, .105 + lift + layer * .405, z, .377, .56, base);
        drum(x, .482 + lift + layer * .405, z, .038, .581, shade(base, 22), active);
      }
      drum(x, 1.33 + lift, z, .045, .39, shade(base, 55));
    } else if (component.kind === 'frontend') {
      box(x, .02 + lift, z, 1.02, .10, .66, base);
      box(x, .12 + lift, z, .35, .27, .24, detail);
      box(x, .36 + lift, z, 1.38, .84, .22, base, active);
      box(x, .43 + lift, z + .119, 1.20, .67, .025, shade(base, 59));
      box(x, .97 + lift, z + .139, 1.01, .07, .017, detail);
      box(x - .35, .51 + lift, z + .139, .24, .34, .017, shade(base, 4));
      box(x + .15, .77 + lift, z + .139, .55, .052, .017, detail);
      box(x + .08, .63 + lift, z + .139, .42, .052, .017, detail);
    } else if (component.kind === 'api') {
      box(x, .02 + lift, z, 1.3, .10, .94, base);
      for (let layer = 0; layer < 3; layer++) {
        const y = .12 + lift + layer * .29;
        box(x, y, z, 1.15, .235, .88, base, active);
        box(x, y + .055, z + .448, .98, .13, .029, shade(base, -27));
        box(x - .13, y + .115, z + .468, .49, .034, .019, detail);
        box(x + .32, y + .102, z + .469, .11, .063, .019, detail);
      }
    } else if (component.kind === 'cache') {
      // Offset the three cache blocks to expose each layer and the fast-access mark.
      for (let layer = 0; layer < 3; layer++) {
        const offset = (layer - 1) * .12;
        box(x + offset, .025 + lift + layer * .26, z - offset, 1.05, .19, .82, base, active, {
          top: layer === 2 ? () => {
            ctx.fillStyle = detail;
            ctx.beginPath();
            ctx.moveTo(.59, .91);
            ctx.lineTo(.29, .43);
            ctx.lineTo(.48, .43);
            ctx.lineTo(.39, .09);
            ctx.lineTo(.74, .58);
            ctx.lineTo(.54, .58);
            ctx.closePath();
            ctx.fill();
          } : undefined,
        });
      }
    } else if (component.kind === 'config') {
      box(x, .025 + lift, z, 1.35, .23, 1.02, base, active, {
        top: () => {
          [.35, .68, .48].forEach((position, index) => {
            const track = .23 + index * .27;
            ctx.fillStyle = colors.shadow;
            ctx.fillRect(track - .025, .12, .05, .76);
            ctx.fillStyle = detail;
            ctx.fillRect(track - .085, position - .065, .17, .13);
          });
        },
      });
    } else if (component.kind === 'tests') {
      box(x, .025 + lift, z, .94, 1.15, .13, base, active, {
        front: () => {
          ctx.fillStyle = '#e1e5e8';
          ctx.fillRect(.07, .06, .86, .85);
          ctx.strokeStyle = colors.shadow;
          ctx.lineWidth = .043;
          for (const row of [.71, .48, .25]) {
            ctx.beginPath();
            ctx.moveTo(.15, row);
            ctx.lineTo(.22, row - .065);
            ctx.lineTo(.32, row + .085);
            ctx.stroke();
            ctx.fillStyle = base;
            ctx.fillRect(.41, row - .025, .39, .05);
          }
        },
      });
      box(x, 1.07 + lift, z + .035, .42, .19, .16, detail);
    } else if (component.kind === 'files') {
      box(x, .025 + lift, z - .22, 1.25, .86, .09, base);
      box(x - .37, .88 + lift, z - .22, .51, .16, .09, base);
      box(x, .025 + lift, z, 1.25, .09, .5, base);
      box(x, .12 + lift, z - .08, 1.11, .69, .05, '#e1e5e8');
      box(x + .025, .12 + lift, z + .055, 1.08, .62, .046, detail);
      box(x, .025 + lift, z + .23, 1.25, .59, .09, base, active);
    }
  });
  paintFaces();
}
