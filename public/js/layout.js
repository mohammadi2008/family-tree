/**
 * layout.js — family graph + automatic tree layout.
 *
 * Model
 *  - Every person is ONE record. A person can APPEAR several times in the drawing:
 *      * once as a "blood" node (under their parents, or as a root), and
 *      * once as a "spouse" node next to each blood partner.
 *    Example (cousin marriage): Sara is drawn as a daughter in her father's family
 *    AND as Ahmad's wife in his family. Both appearances share the same record and
 *    are linked through `layout.appearances`.
 *  - Children of a couple hang under ONE of the parents' units (the "host"):
 *    the father when he is a blood member, otherwise the mother.
 *
 * Geometry is computed left-to-right and then mirrored for RTL, so the
 * blood member sits at the right, spouses to his/her left and the eldest
 * child is the right-most one (Arabic reading order).
 *
 * Iterative construction/measurement avoids JS call-stack overflow for deep
 * trees. Partner/child grouping is cached; timings depend on graph shape.
 */
import { isoToJdn } from './calendar.js';

export const G = {
  R: 34,            // node circle radius
  SLOT: 124,        // horizontal slot per node
  SPOUSE_GAP: 26,   // gap between a person and spouses in the same row
  SIB_GAP: 26,      // gap between sibling subtrees
  GROUP_GAP: 54,    // gap between children of different spouses
  TREE_GAP: 200,    // gap between unconnected trees
  LEVEL: 214,       // vertical distance between generations
  NAME_DY1: 56,     // baseline of first name line (from center)
  NAME_DY2: 76,     // baseline of family name line
  TOGGLE_DY: 98,    // collapse toggle center (from center)
  BUS_DY: 132,      // horizontal "bus" line to children (from parent center)
};

/** Branch colours for men with several wives (1st = blue, 2nd = red, ...). Index-based, so they are stable across re-renders. */
export const BRANCH_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#65a30d'];

const add = (map, k, v) => { let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(v); };

/* ------------------------------------------------------------------ */
/* Graph                                                               */
/* ------------------------------------------------------------------ */
/**
 * A marriage only adds a spouse link. If a husband's parent link points at a parent of
 * his own wife, the two would be siblings (such a marriage is rejected by the server),
 * so that link is a leftover of a wrong "marriage = child of her parents" record and is
 * ignored for display. Stored data is not modified here.
 */
function withoutSpouseParentage(persons, marriages) {
  const byId = new Map(persons.map((p) => [p.id, p]));
  const patch = new Map();
  for (const m of marriages) {
    const h = byId.get(m.husband_id), w = byId.get(m.wife_id);
    if (!h || !w || h === w || h.gender !== 'm' || w.gender !== 'f') continue;
    for (const slot of ['father_id', 'mother_id']) {
      const cur = patch.get(h.id) || h;
      if (cur[slot] != null && cur[slot] === w[slot]) patch.set(h.id, { ...cur, [slot]: null });
    }
  }
  return patch.size ? persons.map((p) => patch.get(p.id) || p) : persons;
}

export function buildGraph(rawPersons, marriages) {
  const persons = withoutSpouseParentage(rawPersons, marriages);
  const byId = new Map(persons.map((p) => [p.id, p]));
  const valid = (id) => (id != null && byId.has(id) ? id : null);
  const kids = new Map();
  for (const p of persons) {
    const f = valid(p.father_id), m = valid(p.mother_id);
    if (f != null && f !== p.id) add(kids, f, p.id);
    if (m != null && m !== p.id && m !== f) add(kids, m, p.id);
  }
  const birthKey = (p) => (p.birth_date ? isoToJdn(p.birth_date) ?? Infinity : Infinity);
  const cmpPerson = (a, b) => {
    const ka = birthKey(a), kb = birthKey(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id;
  };
  for (const arr of kids.values()) arr.sort((x, y) => cmpPerson(byId.get(x), byId.get(y)));

  const marr = new Map();
  const validMarriages = [];
  for (const m of marriages) {
    if (!byId.has(m.husband_id) || !byId.has(m.wife_id) || m.husband_id === m.wife_id) continue;
    validMarriages.push(m);
    add(marr, m.husband_id, { spouseId: m.wife_id, marriage: m });
    add(marr, m.wife_id, { spouseId: m.husband_id, marriage: m });
  }
  const mKey = (m) => (m.marriage_date ? isoToJdn(m.marriage_date) ?? Infinity : Infinity);
  for (const arr of marr.values()) {
    arr.sort((a, b) => {
      const ka = mKey(a.marriage), kb = mKey(b.marriage);
      if ((a.marriage.sort_order || 0) !== (b.marriage.sort_order || 0)) return (a.marriage.sort_order || 0) - (b.marriage.sort_order || 0);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.marriage.id - b.marriage.id;
    });
  }
  const coupleKids = new Map();
  for (const [pid, children] of kids) {
    const groups = new Map();
    for (const cid of children) {
      const p = byId.get(cid);
      const other = valid(p.father_id === pid ? p.mother_id : p.father_id);
      add(groups,other,cid);
    }
    coupleKids.set(pid,groups);
  }
  return { byId, kids, marr, persons, marriages: validMarriages, valid, cmpPerson, coupleKids, partnerCache:new Map() };
}

export function parentsOf(g, id) {
  const p = g.byId.get(id);
  if (!p) return { father: null, mother: null };
  return { father: g.byId.get(g.valid(p.father_id)) || null, mother: g.byId.get(g.valid(p.mother_id)) || null };
}

/** Partners: married spouses (ordered), then co-parents without a marriage record. */
export function partnersOf(g, id) {
  if (g.partnerCache?.has(id)) return g.partnerCache.get(id);
  const out = [];
  const seen = new Set();
  for (const e of g.marr.get(id) || []) {
    if (seen.has(e.spouseId)) continue;
    seen.add(e.spouseId);
    out.push({ spouseId: e.spouseId, marriage: e.marriage, implicit: false });
  }
  for (const c of g.kids.get(id) || []) {
    const p = g.byId.get(c);
    const other = g.valid(p.father_id === id ? p.mother_id : p.father_id);
    if (other != null && other !== id && !seen.has(other)) {
      seen.add(other);
      out.push({ spouseId: other, marriage: null, implicit: true });
    }
  }
  g.partnerCache?.set(id,out);
  return out;
}

/** Children of `a` whose other parent is `b` (b = null → other parent unknown). */
export function childrenOfCouple(g, a, b) {
  if (g.coupleKids) return g.coupleKids.get(a)?.get(b ?? null) || [];
  return (g.kids.get(a) || []).filter((c) => {
    const p = g.byId.get(c);
    const other = g.valid(p.father_id === a ? p.mother_id : p.father_id);
    return (other ?? null) === (b ?? null);
  });
}

export function childrenOf(g, id) { return g.kids.get(id) || []; }

export function descendantsOf(g, id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    for (const c of g.kids.get(stack.pop()) || []) if (!out.has(c) && c !== id) { out.add(c); stack.push(c); }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Roots                                                               */
/* ------------------------------------------------------------------ */
function chooseRoots(g, hasParents) {
  const cand = g.persons.filter((p) => !hasParents(p.id) && partnersOf(g, p.id).every((s) => !hasParents(s.spouseId)));
  const candSet = new Set(cand.map((p) => p.id));
  // union-find over marriages/co-parenting between parentless candidates
  const parent = new Map(cand.map((p) => [p.id, p.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const p of cand) for (const s of partnersOf(g, p.id)) if (candSet.has(s.spouseId)) parent.set(find(p.id), find(s.spouseId));
  const best = new Map();
  const score = (p) => [partnersOf(g, p.id).length, p.gender === 'm' ? 1 : 0, -(p.birth_date ? isoToJdn(p.birth_date) : 1e9), -p.id];
  const better = (a, b) => { const sa = score(a), sb = score(b); for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] > sb[i]; return false; };
  for (const p of cand) {
    const r = find(p.id);
    if (!best.has(r) || better(p, best.get(r))) best.set(r, p);
  }
  return [...best.values()].map((p) => p.id);
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */
/**
 * @param g     graph from buildGraph
 * @param opts  { collapsed: Set<id>, rootId?: id (export a single branch) }
 */
export function computeLayout(g, opts = {}) {
  const collapsed = opts.collapsed || new Set();
  const hasParents = (id) => {
    const p = g.byId.get(id);
    return g.valid(p.father_id) != null || g.valid(p.mother_id) != null;
  };
  const branchMode = opts.rootId != null && g.byId.has(opts.rootId);
  const rootIds = branchMode ? [opts.rootId] : chooseRoots(g, hasParents);
  const rootSet = new Set(rootIds);
  const isBlood = (id) => hasParents(id) || rootSet.has(id);
  const hostOf = (cid) => {
    const p = g.byId.get(cid);
    if (!p) return null;
    const f = g.valid(p.father_id), m = g.valid(p.mother_id);
    if (f != null && isBlood(f)) return f;
    if (m != null && isBlood(m)) return m;
    return f ?? m;
  };
  const branchSet = branchMode ? new Set([opts.rootId, ...descendantsOf(g, opts.rootId)]) : null;

  const bloodPlaced = new Set();
  const spouseShown = new Set();
  const hidden = new Set();

  const hosts = (pid, spouseId, cid) => {
    if (bloodPlaced.has(cid)) return false;
    if (hostOf(cid) === pid) return true;
    // In branch export, the other parent's unit is not drawn: keep the children here.
    return branchMode && (spouseId == null || !branchSet.has(spouseId));
  };

  const markHidden = (cid) => {
    let n = 0;
    const stack = [cid];
    while (stack.length) {
      const id = stack.pop();
      if (bloodPlaced.has(id)) continue;
      bloodPlaced.add(id); hidden.add(id); n += 1;
      const partners = partnersOf(g,id);
      for (const s of partners) if (!bloodPlaced.has(s.spouseId)) hidden.add(s.spouseId);
      const slots=[{spouseId:null},...partners];
      for (let i=slots.length-1;i>=0;i--) {
        const slot=slots[i], kids=childrenOfCouple(g,id,slot.spouseId);
        for (let j=kids.length-1;j>=0;j--) if (hosts(id,slot.spouseId,kids[j])) stack.push(kids[j]);
      }
    }
    return n;
  };

  const buildUnit = (pid, depth) => {
    const frame = (id,level) => {
      bloodPlaced.add(id);
      // A husband who already belongs to the tree (has his own parents/branch) is NOT drawn
      // again inside his wife's family: she is drawn beside him in HIS branch instead.
      const me=g.byId.get(id);
      const partners=partnersOf(g,id).filter(pt=>!(me&&me.gender==='f'&&g.byId.get(pt.spouseId)?.gender==='m'
        &&hasParents(pt.spouseId)&&(!branchMode||branchSet.has(pt.spouseId))));
      for (const s of partners) spouseShown.add(s.spouseId);
      return {u:{pid:id,depth:level,partners,groups:[],collapsed:collapsed.has(id),
        hiddenCount:0,hasKids:false,size:1+partners.length},
        slots:[{spouseId:null,idx:-1},...partners.map((p,i)=>({...p,idx:i}))],
        si:0,kids:null,ki:0,group:null};
    };
    const root=frame(pid,depth), stack=[root];
    while (stack.length) {
      const f=stack[stack.length-1], u=f.u;
      if (f.kids && f.ki<f.kids.length) {
        const c=f.kids[f.ki++];
        if (bloodPlaced.has(c)) continue;
        if (u.collapsed) u.hiddenCount += markHidden(c);
        else {
          const child=frame(c,u.depth+1);
          f.group.units.push(child.u); stack.push(child);
        }
        continue;
      }
      if (f.si<f.slots.length) {
        const s=f.slots[f.si++];
        f.kids=childrenOfCouple(g,u.pid,s.spouseId).filter(c=>hosts(u.pid,s.spouseId,c));
        f.ki=0;
        if (!f.kids.length) continue;
        u.hasKids=true;
        f.group={idx:s.idx,spouseId:s.spouseId,units:[]};
        u.groups.push(f.group);
      } else {
        stack.pop();
        if (stack.length) stack[stack.length-1].u.size += u.size;
      }
    }
    return root.u;
  };

  const trees = [];
  for (const r of rootIds) if (!bloodPlaced.has(r)) trees.push(buildUnit(r, 0));

  // Fallback: anything not reachable from the main roots (e.g. an in-law's children
  // from a marriage outside the family) becomes an extra tree.
  if (!branchMode) {
    const climb = (id) => {
      const seen = new Set();
      let cur = id;
      for (;;) {
        seen.add(cur);
        const h = hostOf(cur);
        if (h == null || bloodPlaced.has(h) || seen.has(h)) return cur;
        cur = h;
      }
    };
    for (const p of g.persons) {
      if (bloodPlaced.has(p.id) || spouseShown.has(p.id) || hidden.has(p.id)) continue;
      const r = climb(p.id);
      if (!bloodPlaced.has(r)) trees.push(buildUnit(r, 0));
    }
  }

  // Largest tree first (right-most after mirroring).
  trees.sort((a, b) => b.size - a.size);

  /* ---------- measure ---------- */
  const measureOne = (u) => {
    const n = 1 + u.partners.length;
    u.rowW = n * G.SLOT + (n - 1) * G.SPOUSE_GAP;
    let kidsW = 0, groupsWithKids = 0;
    for (const gp of u.groups) {
      gp.w = 0;
      gp.units.forEach((cu, i) => { gp.w += cu.w + (i ? G.SIB_GAP : 0); });
      if (gp.units.length) { kidsW += gp.w + (groupsWithKids ? G.GROUP_GAP : 0); groupsWithKids += 1; }
    }
    u.kidsW = kidsW;
    u.w = Math.max(u.rowW, kidsW);
  };

  /* ---------- place ---------- */
  const nodes = [];
  const edges = [];
  const toggles = [];
  let maxDepth = 0;

  const placeOne = (u, left) => {
    const y = u.depth * G.LEVEL;
    maxDepth = Math.max(maxDepth, u.depth);
    const nonEmpty = u.groups.filter((gp) => gp.units.length);
    let kidsLeft = left;
    if (u.kidsW > 0) {
      kidsLeft = left + (u.w - u.kidsW) / 2;
      let x = kidsLeft;
      nonEmpty.forEach((gp) => {
        for (const cu of gp.units) { cu._left=x; x += cu.w + G.SIB_GAP; }
        x += G.GROUP_GAP - G.SIB_GAP;
      });
    }
    const center = u.kidsW > 0 ? kidsLeft + u.kidsW / 2 : left + u.w / 2;
    const rowLeft = Math.min(Math.max(center - u.rowW / 2, left), left + u.w - u.rowW);
    const px = rowLeft + G.SLOT / 2;
    u.px = px;
    nodes.push({ key: `b${u.pid}`, pid: u.pid, x: px, y, kind: 'blood', unit: u });
    const sx = u.partners.map((pt, i) => {
      const x = px + (i + 1) * (G.SLOT + G.SPOUSE_GAP);
      nodes.push({ key: `s${u.pid}_${pt.spouseId}`, pid: pt.spouseId, x, y, kind: 'spouse', partnerOf: u.pid, marriage: pt.marriage });
      return x;
    });
    // Each wife of a man with several wives gets her own colour, used only for her marriage line and the
    // lines down to HER children. Lines from the grandchildren onward use the default tree colour.
    const multiWives = u.partners.length > 1 && g.byId.get(u.pid)?.gender === 'm';
    const colorOf = (idx) => (multiWives && idx >= 0 ? BRANCH_COLORS[idx % BRANCH_COLORS.length] : null);
    // marriage lines (2nd+ spouses get a slightly lower line running behind the nearer spouses)
    u.partners.forEach((pt, i) => {
      const off = i * 8;
      const style = pt.implicit ? 'implicit' : pt.marriage && pt.marriage.status === 'divorced' ? 'divorced' : 'solid';
      edges.push({ style, color: colorOf(i), pts: [[px + G.R, y + off], [sx[i] - G.R, y + off]] });
    });
    u._nonEmpty=nonEmpty;
    u._colorOf=colorOf;
    u._sx=sx;
    u._y=y;
    if (u.hasKids) toggles.push({ pid: u.pid, x: px, y: y + G.TOGGLE_DY, collapsed: u.collapsed, count: u.hiddenCount });
  };
  const connectOne = (u) => {
    const y=u._y,px=u.px,sx=u._sx;
    const unionOf = (idx) => {
      if (idx < 0) return [px,y+G.NAME_DY2+8];
      const a=idx===0 ? px : sx[idx-1];
      return [(a+sx[idx])/2,y+idx*8];
    };
    u._nonEmpty.forEach((gp, gi) => {
      const [ux, uy] = unionOf(gp.idx);
      const busY = y + G.BUS_DY + Math.min(gi, 4) * 9;
      const childTop = (u.depth + 1) * G.LEVEL - G.R - 3;
      const color = u._colorOf(gp.idx);
      for (const cu of gp.units) {
        // Color applies to wives and their direct children only. Only from the root (depth 0) to children (depth 1).
        edges.push({ style: 'solid', color: color && u.depth === 0 ? color : null, pts: [[ux, uy], [ux, busY], [cu.px, busY], [cu.px, childTop]] });
      }
    });
    delete u._sx;delete u._y;delete u._nonEmpty;delete u._left;delete u._colorOf;
  };

  let cursor = 0;
  for (const t of trees) {
    const order=[], stack=[t];
    while (stack.length) {
      const u=stack.pop();order.push(u);
      for (let gi=u.groups.length-1;gi>=0;gi--) {
        const units=u.groups[gi].units;
        for (let i=units.length-1;i>=0;i--) stack.push(units[i]);
      }
    }
    for (let i=order.length-1;i>=0;i--) measureOne(order[i]);
    t._left=cursor;
    for (const u of order) placeOne(u,u._left);
    // Child positions are known before connecting generation edges.
    for (const u of order) connectOne(u);
    cursor += t.w + G.TREE_GAP;
  }

  /* ---------- mirror for RTL + bounds ---------- */
  let minX = Infinity, maxX = -Infinity;
  for (const n of nodes) { n.x = -n.x; minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); }
  for (const e of edges) {
    for (const p of e.pts) p[0] = -p[0];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of e.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    e.bbox = [x0, y0, x1, y1];
  }
  for (const t of toggles) t.x = -t.x;

  const appearances = new Map();
  const byKey = new Map();
  for (const n of nodes) { add(appearances, n.pid, n); byKey.set(n.key, n); }

  const bounds = nodes.length
    ? { minX: minX - G.SLOT / 2, maxX: maxX + G.SLOT / 2, minY: -G.R - 16, maxY: maxDepth * G.LEVEL + G.TOGGLE_DY + 24 }
    : { minX: -100, maxX: 100, minY: -100, maxY: 100 };

  const edgeColors = [...new Set(edges.map((e) => e.color || null))];
  return { graph: g, nodes, edges, edgeColors, toggles, appearances, byKey, bounds, hostOf, hidden, trees: trees.length };
}

/* ------------------------------------------------------------------ */
/* Hit testing                                                         */
/* ------------------------------------------------------------------ */
export function hitTest(layout, wx, wy, scale = 1) {
  const pad = Math.max(0, 10 / scale - 10);
  for (const t of layout.toggles) {
    if ((t.x - wx) ** 2 + (t.y - wy) ** 2 <= (14 + pad) ** 2) return { type: 'toggle', toggle: t };
  }
  let best = null, bestD = Infinity;
  for (const n of layout.nodes) {
    const dx = Math.abs(n.x - wx), dy = wy - n.y;
    if (dx <= G.SLOT / 2 - 4 + pad && dy >= -G.R - 8 - pad && dy <= G.NAME_DY2 + 8 + pad) {
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = n; }
    }
  }
  return best ? { type: 'node', node: best } : null;
}
