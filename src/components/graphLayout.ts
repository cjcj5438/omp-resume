/**
 * 引用关系图的确定性力导向布局（无依赖，SVG 直绘用）。
 * 固定种子 + 固定 tick 数同步跑完：同样输入恒得同样坐标（单测锁定）。
 */
export interface GraphLayoutPoint {
  x: number;
  y: number;
}

export interface GraphLayoutEdge {
  source: string;
  target: string;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function layoutGraph(
  ids: string[],
  edges: GraphLayoutEdge[],
  opts: { width?: number; height?: number; ticks?: number } = {},
): Map<string, GraphLayoutPoint> {
  const width = opts.width ?? 640;
  const height = opts.height ?? 420;
  const ticks = opts.ticks ?? 140;
  const order = [...ids].sort();
  const out = new Map<string, GraphLayoutPoint>();
  if (order.length === 0) return out;
  const rand = mulberry32(0x9e3779b9);
  const pos = new Map<string, GraphLayoutPoint>();
  order.forEach((id, i) => {
    const angle = (i / order.length) * Math.PI * 2 + rand() * 0.5;
    const radius = Math.min(width, height) * 0.28 * (0.5 + rand() * 0.5);
    pos.set(id, {
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
    });
  });
  const links = edges
    .filter((e) => e.source !== e.target && pos.has(e.source) && pos.has(e.target))
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  const k = Math.sqrt((width * height) / order.length);
  let temperature = k * 0.2;
  const disp = new Map<string, GraphLayoutPoint>();
  for (let t = 0; t < ticks; t++) {
    for (const id of order) disp.set(id, { x: 0, y: 0 });
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const a = pos.get(order[i]);
        const b = pos.get(order[j]);
        if (!a || !b) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.1) {
          dx = (i % 7) - 3;
          dy = (j % 5) - 2;
          dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
        }
        const force = (k * k) / dist / dist;
        const ax = (dx / dist) * force;
        const ay = (dy / dist) * force;
        const da = disp.get(order[i]);
        const db = disp.get(order[j]);
        if (da && db) {
          da.x += ax;
          da.y += ay;
          db.x -= ax;
          db.y -= ay;
        }
      }
    }
    for (const e of links) {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      const da = disp.get(e.source);
      const db = disp.get(e.target);
      if (!a || !b || !da || !db) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
      const force = ((dist - k) / k) * 0.6;
      const ax = (dx / dist) * force;
      const ay = (dy / dist) * force;
      da.x += ax;
      da.y += ay;
      db.x -= ax;
      db.y -= ay;
    }
    for (const id of order) {
      const p = pos.get(id);
      const d = disp.get(id);
      if (!p || !d) continue;
      const len = Math.sqrt(d.x * d.x + d.y * d.y) || 1;
      const step = Math.min(len, temperature);
      p.x += (d.x / len) * step;
      p.y += (d.y / len) * step;
      p.x += (width / 2 - p.x) * 0.01;
      p.y += (height / 2 - p.y) * 0.01;
      p.x = Math.min(width - 24, Math.max(24, p.x));
      p.y = Math.min(height - 24, Math.max(24, p.y));
    }
    temperature *= 1 - 1 / Math.max(1, ticks);
  }
  for (const [id, p] of pos) out.set(id, { x: p.x, y: p.y });
  return out;
}
