/* ============================================================================
   Tidal Hex — Map Editor
   ----------------------------------------------------------------------------
   Одностраничное приложение: HTML + CSS + Three.js (r158, UMD build).

   Возможности (по ТЗ):
     1) Карта игры: a) preview — упрощённая графика, top-down;
                    б) переход по кнопке в финальный изометрический вид
                       (плавный облёт карты в рамках изометрии);
     2) Открытие файла-изображения и превращение его в карту;
     3) Сохранение карты в файл (.hexmap.json);
     4) Счётчик FPS / draw calls / количество объектов — в углу экрана;
     5) Размещение острова указанием на тайл + панель свойств;
     6) Загрузка сохранённого файла для редактирования и визуализации;
     7) Совместимость с прототипом не требуется.

   Архитектура (разделы этого файла):
     §0  утилиты, PRNG, хеш-функции
     §1  HEX-геометрия (осевые координаты, точки, границы, пикселизация)
     §2  модель карты (MapDoc): острова, тайлы, сериализация, v1/v2 миграция
     §3  процедурная генерация ландшафта (terrain spec → вершины/цвета)
     §4  меши: low-poly (preview) и high-poly (iso), кэш геометрий
     §5  сцена Three.js, ортографическая камера (top-down / iso), свет, вода
     §6  режимы отображения и плавные переходы (облёт → изометрия)
     §7  frustum culling вручную (влияет на draw calls)
     §8  редактор: raycast тайлов, инструменты (paint/erase/select), гизмо
     §9  панель свойств (inspector)
     §10 изображение → карта (сэмплирование яркости, кластеризация blob)
     §11 импорт/экспорт файлов, drag&drop
     §12 счётчики (FPS/drawcalls/объекты), горячие клавиши, инициализация
   ==========================================================================*/

'use strict';

(function () {

/* ==========================================================================
   §0  УТИЛИТЫ
   ========================================================================== */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp  = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1); return t * t * (3 - 2 * t); };
const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const $ = id => document.getElementById(id);

/** Детерминированный PRNG (mulberry32) — одинаковый результат при одном seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Хеш целых чисел → [0,1). Используется для «шума» рельефа без библиотек. */
function hash2i(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Гладкий 2D-шум на целочисленной решётке (билинейная интерполяция hash). */
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const s = (t) => t * t * (3 - 2 * t);
  const a = hash2i(xi, yi, seed),     b = hash2i(xi + 1, yi, seed);
  const c = hash2i(xi, yi + 1, seed), d = hash2i(xi + 1, yi + 1, seed);
  const u = s(xf), v = s(yf);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function fmtInt(n) { return n.toLocaleString('ru-RU'); }

/* ==========================================================================
   §1  HEX-ГЕОМЕТРИЯ  (pointy-top, осевые координаты q,r)
   --------------------------------------------------------------------------
   Точка центра тайла:  x = R*√3*(q + r/2) ,  z = R*1.5*r
   Обратное преобразование — стандартное pixel→hex с округлением через cube.
   ========================================================================== */

const SQRT3 = Math.sqrt(3);

const Hex = {
  R: 1.0,                                   // масштаб (мировые единицы), задаётся сеткой
  corner(i, out) {                          // i = 0..5, pointy-top
    const a = Math.PI / 180 * (60 * i - 30);
    out.x = Math.cos(a); out.z = Math.sin(a);
    return out;
  },
  /** Вершины тайла (R=1) — переиспользуемый массив для границ/рейкаста. */
  unitCorners() {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i - 30);
      pts.push({ x: Math.cos(a), z: Math.sin(a) });
    }
    return pts;
  },
  toWorld(q, r, R) { return { x: R * SQRT3 * (q + r / 2), z: R * 1.5 * r }; },
  /** world → осевые координаты (без округления) */
  toAxial(x, z, R) {
    const q = (SQRT3 / 3 * x - 1 / 3 * z) / R;
    const r = (2 / 3 * z) / R;
    return { q, r };
  },
  round(q, r) {
    // cube round
    let x = q, z = r, y = -x - z;
    let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
    const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    return { q: rx, r: rz };
  },
  key(q, r) { return q + ',' + r; },
  neighbors(q, r) {
    const d = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    const out = [];
    for (let i = 0; i < 6; i++) out.push({ q: q + d[i][0], r: r + d[i][1] });
    return out;
  },
  distance(aq, ar, bq, br) {
    return (Math.abs(aq - bq) + Math.abs(aq + ar - bq - br) + Math.abs(ar - br)) / 2;
  },
};

/* Пиксельная маска одного тайла (для растеризации изображений в hex-сетку).
   Рисуем flat-top/pointy-top шестиугольник в булев массив side×side.        */
function makeHexMask(Rpx) {
  const size = Math.max(3, Math.round(Rpx * 2) | 1);
  const half = size / 2;
  const corners = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 30);
    corners.push([half + Math.cos(a) * Rpx, half + Math.sin(a) * Rpx]);
  }
  const mask = new Uint8Array(size * size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // point-in-polygon (ray casting)
      let inside = false;
      for (let i = 0, j = 5; i < 6; j = i++) {
        const [xi, yi] = corners[i], [xj, yj] = corners[j];
        if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi + 1e-9) + xi)) inside = !inside;
      }
      mask[py * size + px] = inside ? 1 : 0;
    }
  }
  return { mask, size, half };
}

/* ==========================================================================
   §2  МОДЕЛЬ КАРТЫ (MapDoc)
   --------------------------------------------------------------------------
   Карта = { meta, islands[], tiles{} }.
   tiles — производная от островов (пересчёт по требованию), НЕ сериализуется
   полностью: в файл пишутся только острова, что даёт компактный JSON и
   гарантированную консистентность. Формат v2.
   ========================================================================== */

/** Пресеты типов суши: цвета, форма рельефа, плотность деталей. */
const TERRAIN_TYPES = {
  jungle:   { label: 'Джунгли',       base: '#2e7d3f', sand: '#e8d9a8', rock: '#5a6b4c', peak: '#7cb26a', height: 1.05, rough: 0.55, beach: 0.34, veg: 0.9,  trees: 'palm',   swatches: ['#2e7d3f', '#1f5e33', '#418f52', '#6aa84f'] },
  savanna:  { label: 'Саванна',       base: '#c9a648', sand: '#ecd9a0', rock: '#8a7a55', peak: '#d8bc63', height: 0.6,  rough: 0.35, beach: 0.42, veg: 0.5,  trees: 'bush',   swatches: ['#c9a648', '#b8933c', '#d9bd6b', '#8fae52'] },
  arid:     { label: 'Аридный',       base: '#d8b06a', sand: '#f0e0ae', rock: '#a3764a', peak: '#e0c184', height: 0.8,  rough: 0.7,  beach: 0.25, veg: 0.15, trees: 'cactus', swatches: ['#d8b06a', '#c99b57', '#e3c98d', '#b07b4e'] },
  volcanic: { label: 'Вулканический', base: '#5d4037', sand: '#c9b28a', rock: '#3e2b26', peak: '#7a4a35', height: 1.5,  rough: 0.85, beach: 0.2,  veg: 0.2,  trees: 'none',   swatches: ['#5d4037', '#4a332c', '#6d4c41', '#8d6e63'] },
  coral:    { label: 'Коралловый',    base: '#ef9a9a', sand: '#ffe3d1', rock: '#c98f8f', peak: '#f8cfc0', height: 0.32, rough: 0.2,  beach: 0.6,  veg: 0.35, trees: 'palm',   swatches: ['#ef9a9a', '#e58aa0', '#f3b6ad', '#d98fae'] },
  mangrove: { label: 'Мангры',        base: '#4f7a56', sand: '#d9cf9e', rock: '#4c5f45', peak: '#6f9a6a', height: 0.42, rough: 0.3,  beach: 0.55, veg: 0.85, trees: 'mangrove', swatches: ['#4f7a56', '#3d6647', '#628f66', '#7ba05b'] },
  beach:    { label: 'Пляжный',       base: '#f2e3b2', sand: '#fff2c8', rock: '#d9c48f', peak: '#f7ecbe', height: 0.28, rough: 0.15, beach: 0.7,  veg: 0.3,  trees: 'palm',   swatches: ['#f2e3b2', '#e8d59a', '#fff0c0', '#dcc48a'] },
};
const TYPE_ORDER = Object.keys(TERRAIN_TYPES);

let uidCounter = 1;
const nextUid = () => 'isl_' + (uidCounter++).toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);

class Island {
  constructor(props) {
    this.uid = props.uid || nextUid();
    this.q = props.q | 0;                 // центр (осевые координаты)
    this.r = props.r | 0;
    this.type = TERRAIN_TYPES[props.type] ? props.type : 'jungle';
    this.radius = clamp(props.radius ?? 1.4, 0.4, 3.4);   // в радиусах гекса
    this.height = clamp(props.height ?? TERRAIN_TYPES[this.type].height, 0.1, 2.6);
    this.rough  = clamp(props.rough  ?? TERRAIN_TYPES[this.type].rough, 0, 1);
    this.beach  = clamp(props.beach  ?? TERRAIN_TYPES[this.type].beach, 0.05, 0.9);
    this.veg    = clamp(props.veg    ?? TERRAIN_TYPES[this.type].veg, 0, 1);
    this.north  = props.north ?? 0;                        // направление «вершины» (рад)
    this.boulder = !!props.boulder;
    this.peakOn  = props.peakOn !== false;
    this.seed    = props.seed ?? (Math.floor(Math.random() * 1e9) | 0);
    this.name    = props.name || '';
    this.color   = props.color || null;                    // override основного цвета
  }
  get preset() { return TERRAIN_TYPES[this.type]; }
  get mainColor() { return this.color || this.preset.base; }
  /** Максимальная дистанция (в гексах), которую остров может покрыть. */
  get reach() { return Math.ceil(this.radius) + 1; }
}

class MapDoc {
  constructor(meta) {
    this.meta = Object.assign({
      format: 'tidal-hex-map', version: 2, name: 'Без названия',
      cols: 26, rows: 16, hexSize: 1.0, created: Date.now(),
    }, meta || {});
    this.islands = [];
    this.tiles = new Map();          // "q,r" -> {land:boolean, island:Island|null, elev, color}
    this.bounds = { minQ: 0, maxQ: this.meta.cols - 1, minR: 0, maxR: this.meta.rows - 1 };
  }

  inBounds(q, r) {
    return q >= this.bounds.minQ && q <= this.bounds.maxQ && r >= this.bounds.minR && r <= this.bounds.maxR;
  }

  clearTiles() { this.tiles.clear(); }

  /** Пересчёт тайлов из островов. Тайл принадлежит тому острову, чей профиль
   *  высоты в этой точке больше (честное «разделение» берегов). */
  recomputeTiles() {
    this.tiles.clear();
    const { minQ, maxQ, minR, maxR } = this.bounds;
    for (const isl of this.islands) {
      const reach = isl.reach + 1;
      for (let dq = -reach; dq <= reach; dq++) {
        for (let dr = -reach; dr <= reach; dr++) {
          if (Math.abs(dq + dr) > reach) continue;
          const q = isl.q + dq, r = isl.r + dr;
          if (!this.inBounds(q, r)) continue;
          const d = Hex.distance(isl.q, isl.r, q, r);
          const shape = this.tileCoverage(isl, q, r, d);
          if (shape <= 0.001) continue;
          const key = Hex.key(q, r);
          const prev = this.tiles.get(key);
          if (!prev || shape > prev.coverage) {
            this.tiles.set(key, { q, r, land: true, island: isl, elev: shape, coverage: shape });
          }
        }
      }
    }
    for (const t of this.tiles.values()) t.elev = clamp(t.coverage, 0, 1);
  }

  /** Профиль «крышки» острова: 1 в центре → 0 на границе радиуса (+ пляжный спад). */
  tileCoverage(isl, q, r, dist) {
    const R = isl.radius;
    if (dist > R + 0.55) return 0;
    // лёгкая асимметрия формы по north+seed — острова не идеальные круги
    const ang = Math.atan2(r - isl.r + (q - isl.q) * 0.5, (q - isl.q) * SQRT3 / 2) + isl.north;
    const wob = 1 + isl.rough * 0.28 * (valueNoise(Math.cos(ang) * 2.2 + 8, Math.sin(ang) * 2.2 + 8, isl.seed) - 0.5) * 2;
    const rr = R * wob;
    const t = clamp(dist / rr, 0, 1.4);
    // береговая линия: резкость beach (0.05 плавно … 0.9 обрывисто)
    const edge = smoothstep(1.0, 1.0 - isl.beach * 0.9, t);
    return edge;
  }

  islandAtTile(q, r) { const t = this.tiles.get(Hex.key(q, r)); return t && t.land ? t.island : null; }

  /* ---- сериализация ---- */
  toJSON() {
    return {
      format: 'tidal-hex-map', version: 2,
      meta: this.meta,
      islands: this.islands.map(i => ({
        uid: i.uid, q: i.q, r: i.r, type: i.type, radius: +i.radius.toFixed(3),
        height: +i.height.toFixed(3), rough: +i.rough.toFixed(3), beach: +i.beach.toFixed(3),
        veg: +i.veg.toFixed(3), north: +i.north.toFixed(3), boulder: i.boulder, peakOn: i.peakOn,
        seed: i.seed, name: i.name, color: i.color,
      })),
    };
  }

  static fromJSON(obj) {
    // --- миграция формата v1 → v2 (защита от «чужих» файлов) ---
    if (obj && obj.format === 'tidal-hex-map' && obj.version === 1 && Array.isArray(obj.islands)) {
      obj.meta = obj.meta || {};
      obj.meta.hexSize = obj.meta.hexSize || 1;
      obj.version = 2;
    }
    if (!obj || obj.format !== 'tidal-hex-map') throw new Error('Не формат карты tidal-hex-map');
    const doc = new MapDoc(obj.meta || {});
    const list = Array.isArray(obj.islands) ? obj.islands : [];
    doc.islands = list.map(p => new Island(p));
    // максимальный uid, чтобы коллизии не ломали выделение
    let mx = 0;
    for (const i of doc.islands) {
      const m = /^isl_([0-9a-z]+)_/.exec(i.uid);
      if (m) mx = Math.max(mx, parseInt(m[1], 36) || 0);
    }
    uidCounter = Math.max(uidCounter, mx + 1);
    doc.recomputeTiles();
    return doc;
  }

  static blank(cols = 26, rows = 16, seedName) {
    const doc = new MapDoc({ name: seedName || ('Карта ' + (cols + '×' + rows)), cols, rows });
    doc.recomputeTiles();
    return doc;
  }
}

/* ==========================================================================
   §3  ПРОЦЕДУРНЫЙ РЕЛЬЕФ ТАЙЛА
   --------------------------------------------------------------------------
   Для каждого сухопутного тайла строится «крышка»: disc из SEG сегментов,
   вершины которого поднимаются по профилю острова + шуму. Возвращаем
   плоские данные (positions/colors/normals/indices) — их можно отдать и
   BufferGeometry (low-poly), и CatmullClark-подобному сабдиву (high-poly).
   ========================================================================== */

const DISC_SEG_LO = 6;    // совпадает с формой гекса → минимальный полигонаж
const DISC_SEG_HI = 18;

/**
 * @returns {{pos:Float32Array,col:Float32Array,idx:Uint16Array}} крышка тайла в мировых координатах
 */
function buildTileCap(doc, tile, opts) {
  const seg = opts.hi ? DISC_SEG_HI : DISC_SEG_LO;
  const R = doc.meta.hexSize;
  const isl = tile.island;
  const c = Hex.toWorld(tile.q, tile.r, R);
  const cx = c.x, cz = c.z;
  const cover = tile.coverage;                     // 0..1 близость к центру острова
  const scale = clamp(0.55 + cover * 0.62, 0.5, 1.0) * R;   // радиус «шапки» внутри тайла
  const hMax = isl.height * (0.35 + 0.65 * cover);

  const positions = [], colors = [], indices = [];
  const colSand = new THREE.Color(isl.preset.sand);
  const colBase = new THREE.Color(isl.mainColor);
  const colRock = new THREE.Color(isl.preset.rock);
  const colPeak = new THREE.Color(isl.preset.peak);

  // центральная вершина
  const noiseC = valueNoise(cx * 0.35, cz * 0.35, isl.seed) - 0.5;
  const yC = hMax * (0.75 + noiseC * isl.rough * 0.9);
  positions.push(cx, Math.max(0.02, yC), cz);
  pushColor(colors, mix3(colSand, colBase, colPeak, smoothstep(0, 0.9, yC / Math.max(0.001, isl.height))));

  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const nx = Math.cos(a), nz = Math.sin(a);
    // береговая неровность
    const wob = 1 + (valueNoise(nx * 2 + 5, nz * 2 + 5, isl.seed) - 0.5) * isl.rough * 0.5;
    const rad = scale * wob;
    const px = cx + nx * rad, pz = cz + nz * rad;
    const edgeH = hMax * (0.18 + 0.5 * cover) * (0.6 + 0.8 * valueNoise(px * 0.5, pz * 0.5, isl.seed + 17));
    positions.push(px, Math.max(0.005, edgeH), pz);
    pushColor(colors, mix3(colSand, colBase, colRock, smoothstep(0.05, 0.55, edgeH / Math.max(0.001, isl.height))));
  }
  for (let i = 0; i < seg; i++) {
    indices.push(0, 1 + i, 1 + ((i + 1) % seg));
  }

  const pos = new Float32Array(positions);
  const col = new Float32Array(colors);
  const geo = { pos, col, idx: new Uint16Array(indices) };
  geo.norm = computeNormals(pos, geo.idx);
  return geo;
}

function pushColor(arr, color) { arr.push(color.r, color.g, color.b); }

function mix3(a, b, c, t) {
  const out = new THREE.Color();
  if (t < 0.5) out.copy(a).lerp(b, t * 2);
  else { const m = new THREE.Color().copy(b).lerp(c, (t - 0.5) * 2); out.copy(m); }
  return out;
}

/** Плоские нормали из треугольников (flat shading — стилистика прототипа). */
function computeNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cr = new THREE.Vector3();
  for (let i = 0; i < idx.length; i += 3) {
    va.fromArray(pos, idx[i] * 3); vb.fromArray(pos, idx[i + 1] * 3); vc.fromArray(pos, idx[i + 2] * 3);
    e1.subVectors(vb, va); e2.subVectors(vc, va); cr.crossVectors(e1, e2).normalize();
    for (let k = 0; k < 3; k++) {
      const vi = idx[i + k] * 3;
      n[vi] += cr.x; n[vi + 1] += cr.y; n[vi + 2] += cr.z;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

/* ==========================================================================
   §4  МЕШИ И КЭШ ГЕОМЕТРИЙ
   --------------------------------------------------------------------------
   Каждый тайл суши — отдельный Mesh (это видно по draw calls). Чтобы не
   строить геометрию заново при каждом изменении, кэшируем по «ключу стиля».
   Вода — один большой PlaneGeometry (или InstancedMesh волн в hi-режиме).
   ========================================================================== */

/* Кэш «сырых» данных крышек тайлов (pos/col/norm/idx). */
const capCache = new Map();
function cachedCap(key, builder) {
  let g = capCache.get(key);
  if (!g) { g = builder(); capCache.set(key, g); }
  return g;
}

/* Кэш переиспользуемых примитивов THREE (для декора). При «новой карте»
   освобождается явно, чтобы не копить GPU-ресурсы между документами.     */
const geoCache = new Map();
function cachedGeo(key, builder) {
  let g = geoCache.get(key);
  if (!g) { g = builder(); geoCache.set(key, g); }
  return g;
}
function resetCaches() {
  for (const g of geoCache.values()) if (g && g.dispose) g.dispose();
  geoCache.clear();
  capCache.clear();
}

function tileStyleKey(doc, tile, hi) {
  const i = tile.island;
  return [hi ? 'H' : 'L', i.type, i.seed, +i.radius.toFixed(2), +i.height.toFixed(2),
    +i.rough.toFixed(2), +i.beach.toFixed(2), +i.north.toFixed(2), i.color || '',
    +tile.coverage.toFixed(2), tile.q, tile.r].join('|');
}

function makeTileMesh(doc, tile, hi) {
  const data = cachedCap(tileStyleKey(doc, tile, hi), () => buildTileCap(doc, tile, { hi }));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(data.col, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(data.norm, 3));
  g.setIndex(new THREE.BufferAttribute(data.idx, 1));
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Mesh(g, m);
  mesh.userData.tile = tile;
  mesh.userData.pickable = true;
  return mesh;
}

/** Декор острова (деревья/камни) — instanced или обычные меши, зависит от режима. */
function buildDecorForIsland(doc, isl, group, quality) {
  const R = doc.meta.hexSize;
  const rng = mulberry32(isl.seed ^ 0x9e37);
  const tiles = [];
  for (const t of doc.tiles.values()) if (t.island === isl) tiles.push(t);
  if (!tiles.length) return;
  const count = Math.round(clamp(tiles.length * (0.4 + isl.veg * 1.4), 0, 60));
  const kind = isl.preset.trees;
  if (kind === 'none' || count === 0) return;

  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6d4c33, flatShading: true });
  const leafMat  = new THREE.MeshLambertMaterial({ color: new THREE.Color(isl.mainColor).offsetHSL(0, 0.05, -0.12), flatShading: true });
  const rockMat  = new THREE.MeshLambertMaterial({ color: new THREE.Color(isl.preset.rock), flatShading: true });

  const trunkGeo = cachedGeo('trunk', () => new THREE.CylinderGeometry(0.035, 0.05, 0.42, 5));
  const crownGeo = cachedGeo('crown', () => new THREE.IcosahedronGeometry(0.22, 0));
  const bushGeo  = cachedGeo('bush', () => new THREE.SphereGeometry(0.2, 6, 4));
  const coneGeo  = cachedGeo('cone', () => new THREE.ConeGeometry(0.16, 0.5, 6));
  const stoneGeo = cachedGeo('stone', () => new THREE.DodecahedronGeometry(0.16, 0));

  // Декор строим поверх «крышки» тайла: берём её вершины и интерполируем
  // высоту в точке посадки (без raycast'ов по геометрии).
  function tileHeightAt(t, x, z) {
    const data = cachedCap(tileStyleKey(doc, t, false), () => buildTileCap(doc, t, { hi: false }));
    const cx = data.pos[0], cz = data.pos[2], yc = data.pos[1];
    const dcx = x - cx, dcz = z - cz;
    let best = yc, bestD = Infinity;
    for (let i = 1; i < data.pos.length / 3; i++) {
      const dx = data.pos[i * 3] - x, dz = data.pos[i * 3 + 2] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = data.pos[i * 3 + 1]; }
    }
    const drC = Math.hypot(dcx, dcz);
    const denom = drC + Math.sqrt(bestD) || 1;
    const wEdge = clamp(Math.sqrt(bestD) / denom, 0, 1);
    return lerp(yc, best, wEdge);
  }

  for (let i = 0; i < count; i++) {
    const t = tiles[Math.floor(rng() * tiles.length)];
    const w = Hex.toWorld(t.q, t.r, R);
    const ox = (rng() - 0.5) * R * 0.9, oz = (rng() - 0.5) * R * 0.9;
    const groundY = tileHeightAt(t, w.x + ox, w.z + oz);   // посадка точно по рельефу
    const s = 0.7 + rng() * 0.8;
    let mesh;
    if (kind === 'palm') {
      mesh = new THREE.Group();
      const tr = new THREE.Mesh(trunkGeo, trunkMat); tr.position.y = 0.2; mesh.add(tr);
      const cr = new THREE.Mesh(crownGeo, leafMat); cr.position.y = 0.44; cr.scale.set(1, 0.7, 1); mesh.add(cr);
      for (let f = 0; f < 5; f++) {
        const frond = new THREE.Mesh(coneGeo, leafMat);
        const a = f / 5 * Math.PI * 2;
        frond.position.set(Math.cos(a) * 0.16, 0.5, Math.sin(a) * 0.16);
        frond.rotation.z = Math.cos(a) * 0.9; frond.rotation.x = -Math.sin(a) * 0.9;
        frond.scale.setScalar(0.55); mesh.add(frond);
      }
    } else if (kind === 'cactus') {
      mesh = new THREE.Group();
      const body = new THREE.Mesh(cylCached(0.07, 0.5, 6), leafMat);
      body.position.y = 0.25; mesh.add(body);
      const arm = new THREE.Mesh(cylCached(0.05, 0.22, 5), leafMat);
      arm.position.set(0.11, 0.36, 0); arm.rotation.z = -0.9; mesh.add(arm);
    } else if (kind === 'mangrove') {
      mesh = new THREE.Group();
      const cr = new THREE.Mesh(bushGeo, leafMat); cr.position.y = 0.3; cr.scale.set(1.1, 0.8, 1.1); mesh.add(cr);
      for (let f = 0; f < 4; f++) {
        const root = new THREE.Mesh(cylCached(0.02, 0.3, 4), trunkMat);
        const a = f / 4 * Math.PI * 2;
        root.position.set(Math.cos(a) * 0.1, 0.12, Math.sin(a) * 0.1);
        root.rotation.z = Math.cos(a) * 0.4; root.rotation.x = -Math.sin(a) * 0.4; mesh.add(root);
      }
    } else { // bush
      mesh = new THREE.Mesh(bushGeo, leafMat);
      mesh.position.y = 0.12; mesh.scale.set(s, s * 0.8, s);
    }
    if (rng() < 0.18) {
      const st = new THREE.Mesh(stoneGeo, rockMat);
      st.position.set(w.x + ox, groundY + 0.05, w.z + oz);
      st.scale.setScalar(0.6 + rng()); st.rotation.y = rng() * 6.28;
      group.add(st);
    }
    mesh.position.set(w.x + ox, groundY - 0.02, w.z + oz);
    mesh.scale.setScalar(s);
    mesh.rotation.y = rng() * 6.28;
    group.add(mesh);
  }

  // «Вершина» острова — заметный пик/вулканический конус
  const centerTile = doc.tiles.get(Hex.key(isl.q, isl.r));
  const cw0 = Hex.toWorld(isl.q, isl.r, R);
  const baseY = centerTile ? tileHeightAt(centerTile, cw0.x, cw0.z) : 0;
  if (isl.peakOn && isl.height > 0.6) {
    const g = new THREE.Group();
    const cone = new THREE.Mesh(cachedGeo('peakcone', () => new THREE.ConeGeometry(0.5, 1.2, 8)), rockMat);
    cone.position.y = isl.height * 0.55;
    cone.scale.set(1, isl.height, 1);
    g.add(cone);
    if (isl.type === 'volcanic') {
      const lava = new THREE.Mesh(cachedGeo('lavatop', () => new THREE.CircleGeometry(0.16, 8)),
        new THREE.MeshBasicMaterial({ color: 0xff6a2a }));
      lava.rotation.x = -Math.PI / 2; lava.position.y = isl.height * 1.02 + 0.02;
      g.add(lava);
    }
    g.position.set(cw0.x, baseY - 0.05, cw0.z);
    group.add(g);
  }
  if (isl.boulder) {
    const b = new THREE.Mesh(cachedGeo('boulder', () => new THREE.IcosahedronGeometry(0.42, 0)), rockMat);
    const bt = centerTile || null;
    const bx = cw0.x + 0.5, bz = cw0.z - 0.4;
    b.position.set(bx, (bt ? tileHeightAt(bt, bx, bz) : baseY) + 0.1, bz);
    b.rotation.set(0.4, 0.9, 0.2);
    group.add(b);
  }
}

const _cylCache = new Map();
function cylCached(rTop, h, seg) {
  const k = rTop + '|' + h + '|' + seg;
  let g = _cylCache.get(k);
  if (!g) { g = new THREE.CylinderGeometry(rTop, rTop * 1.2, h, seg); _cylCache.set(k, g); }
  return g;
}

/* ---------- Water ----------
   Один plane с лёгкой анимацией вершин (cheap waves) — в preview статичен. */
function buildWater(doc, hi) {
  const R = doc.meta.hexSize;
  const spanX = (doc.bounds.maxQ - doc.bounds.minQ + 1) * SQRT3 * R;
  const spanZ = (doc.bounds.maxR - doc.bounds.minR + 1) * 1.5 * R + R;
  const W = spanX + R * 8, H = spanZ + R * 8;
  const segX = hi ? 48 : 12, segZ = hi ? 32 : 8;
  const g = new THREE.PlaneGeometry(W, H, segX, segZ);
  g.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshLambertMaterial({
    color: 0x0e5a7a, transparent: true, opacity: 0.9, flatShading: true,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(
    Hex.toWorld((doc.bounds.minQ + doc.bounds.maxQ) / 2, (doc.bounds.minR + doc.bounds.maxR) / 2, R).x,
    -0.06,
    Hex.toWorld((doc.bounds.minQ + doc.bounds.maxQ) / 2, (doc.bounds.minR + doc.bounds.maxR) / 2, R).z
  );
  mesh.userData.isWater = true;
  mesh.userData.basePos = g.attributes.position.array.slice(0);
  return mesh;
}

/* ---------- Grid overlay (preview) ----------
   Линии гексов одним LineSegments → 1 draw call. */
function buildGridLines(doc) {
  const R = doc.meta.hexSize;
  const pts = [];
  const corners = Hex.unitCorners();
  for (let r = doc.bounds.minR; r <= doc.bounds.maxR; r++) {
    for (let q = doc.bounds.minQ; q <= doc.bounds.maxQ; q++) {
      const w = Hex.toWorld(q, r, R);
      for (let i = 0; i < 6; i++) {
        const a = corners[i], b = corners[(i + 1) % 6];
        pts.push(w.x + a.x * R * 0.985, 0.012, w.z + a.z * R * 0.985);
        pts.push(w.x + b.x * R * 0.985, 0.012, w.z + b.z * R * 0.985);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const m = new THREE.LineBasicMaterial({ color: 0x2a7ea6, transparent: true, opacity: 0.35 });
  return new THREE.LineSegments(g, m);
}

/* ---------- Тайловые «подложки» воды (preview wireframe тест) ----------
   Каркас тайлов воды отдельными тонкими рамками — демонстрация стоимости
   отдельных draw call'ов (можно отключить чекбоксом). */
function buildWaterWire(doc) {
  const grp = new THREE.Group();
  const R = doc.meta.hexSize;
  const corners = Hex.unitCorners();
  const edges = [];
  for (let r = doc.bounds.minR; r <= doc.bounds.maxR; r++) {
    for (let q = doc.bounds.minQ; q <= doc.bounds.maxQ; q++) {
      if (doc.tiles.has(Hex.key(q, r))) continue;
      const w = Hex.toWorld(q, r, R);
      for (let i = 0; i < 6; i++) {
        const a = corners[i], b = corners[(i + 1) % 6];
        edges.push(w.x + a.x * R * 0.9, 0.005, w.z + a.z * R * 0.9,
                   w.x + b.x * R * 0.9, 0.005, w.z + b.z * R * 0.9);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
  const m = new THREE.LineBasicMaterial({ color: 0x1b5f7e, transparent: true, opacity: 0.25 });
  grp.add(new THREE.LineSegments(g, m));
  return grp;
}

/* ==========================================================================
   §5  СЦЕНА / КАМЕРА / СВЕТ
   ========================================================================== */

const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x071e2c);
scene.fog = new THREE.Fog(0x071e2c, 60, 260);

const hemi = new THREE.HemisphereLight(0xbfeaf5, 0x0a2a3a, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2d8, 1.0);
sun.position.set(-40, 60, 30);
scene.add(sun);
scene.add(new THREE.AmbientLight(0x224455, 0.5));

/* Ортографическая камера: один параметр tilt переключает top-down ↔ iso.
   top-down: tilt≈π/2 (смотрим сверху вниз), iso: tilt≈35.26° (классическая
   изометрия). Камера всегда смотрит на target.                      */
const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 600);
const camState = {
  target: new THREE.Vector3(0, 0, 0),
  zoom: 18,           // половина высоты видимой области в мировых единицах
  tilt: Math.PI / 2,  // π/2 = top-down
  yaw: 0,
};
function applyCamera() {
  const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
  camera.left = -camState.zoom * aspect; camera.right = camState.zoom * aspect;
  camera.top = camState.zoom; camera.bottom = -camState.zoom;
  camera.updateProjectionMatrix();
  const dist = 120;
  const cy = Math.sin(camState.tilt) * dist;
  const hr = Math.cos(camState.tilt) * dist;
  camera.position.set(
    camState.target.x + Math.sin(camState.yaw) * hr,
    Math.max(0.5, cy),
    camState.target.z + Math.cos(camState.yaw) * hr
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(camState.target);
}

const ISO_TILT = Math.atan(1 / Math.SQRT2);   // ≈35.26° — «истинная» изометрия
const TOP_TILT = Math.PI / 2 - 0.001;

/* ---------- слои сцены ---------- */
const layers = {
  water: null, waterWire: null, grid: null,
  landHi: new THREE.Group(), landLo: new THREE.Group(), decor: new THREE.Group(),
  highlight: null, marquee: null,
};
scene.add(layers.landHi, layers.landLo, layers.decor);

/* ---------- документ и сборка ---------- */
let doc = MapDoc.blank(26, 16);
let quality = 'lo';                 // 'lo' = preview (упрощённая), 'hi' = iso
let tool = { mode: 'select', type: 'jungle' };
let selectedUid = null;
let hoverTile = null;

function disposeMaterialsOf(obj) {
  obj.traverse(o => { if (o.material && o.material.dispose) o.material.dispose(); });
}

function disposeChildren(group) {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const ch = group.children[i];
    group.remove(ch);
    if (ch.geometry) ch.geometry.dispose();   // геометрия принадлежит мешу
    disposeMaterialsOf(ch);                   // материалы — тоже наши
  }
}

/** Пересобрать только меши суши (без пересчёта тайлов/воды/сетки). */
function rebuildLand() {
  disposeChildren(layers.landLo);
  disposeChildren(layers.landHi);
  for (const t of doc.tiles.values()) {
    if (!t.land) continue;
    const lo = makeTileMesh(doc, t, false);
    layers.landLo.add(lo);
    if (quality === 'hi') layers.landHi.add(makeTileMesh(doc, t, true));
  }
  layers.landLo.visible = quality === 'lo';
  layers.landHi.visible = quality === 'hi';
}

/** Быстрое обновление при правке параметров выделенного острова. */
function refreshLiveEdit() {
  doc.recomputeTiles();
  rebuildLand();
  disposeChildren(layers.decor);
  for (const isl of doc.islands) buildDecorForIsland(doc, isl, layers.decor, quality);
  updateSelectionGizmo();
  refreshInspectorMeta();
}

function rebuildScene() {
  doc.recomputeTiles();

  // вода
  if (layers.water) { scene.remove(layers.water); layers.water.geometry.dispose(); layers.water.material.dispose(); }
  layers.water = buildWater(doc, quality === 'hi');
  scene.add(layers.water);
  layers.water.visible = $('optWater').checked;

  // сетка (только в lo-режиме она полезна визуально)
  if (layers.grid) { scene.remove(layers.grid); layers.grid.geometry.dispose(); }
  layers.grid = buildGridLines(doc);
  layers.grid.visible = $('optGrid').checked;
  scene.add(layers.grid);

  // каркас воды
  if (layers.waterWire) { scene.remove(layers.waterWire); disposeChildren(layers.waterWire); }
  layers.waterWire = buildWaterWire(doc);
  layers.waterWire.visible = $('optWire').checked;
  scene.add(layers.waterWire);

  // суша + декор
  rebuildLand();
  disposeChildren(layers.decor);
  for (const isl of doc.islands) buildDecorForIsland(doc, isl, layers.decor, quality);

  fitCameraToMap();
  updateModeVisibility();
}

/** Подогнать zoom под размер карты. */
function fitCameraToMap() {
  const R = doc.meta.hexSize;
  const spanX = (doc.bounds.maxQ - doc.bounds.minQ + 1) * SQRT3 * R;
  const spanZ = (doc.bounds.maxR - doc.bounds.minR + 1) * 1.5 * R;
  const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
  const need = Math.max(spanZ / 2, spanX / 2 / aspect) * 1.15;
  camState.zoom = clamp(need, 6, 120);
  const c = Hex.toWorld((doc.bounds.minQ + doc.bounds.maxQ) / 2, (doc.bounds.minR + doc.bounds.maxR) / 2, R);
  camState.target.set(c.x, 0, c.z);
  applyCamera();
}

/* ==========================================================================
   §6  РЕЖИМЫ ОТОБРАЖЕНИЯ И ПЕРЕХОДЫ
   --------------------------------------------------------------------------
   preview : ortho top-down, low-poly, сетка включена
   fly     : автоматический облёт (yaw движется), tilt интерполируется к iso
   iso     : финальная изометрия, high-poly, мягкий свет
   Transition: плавный микс параметров камеры + апгрейд качества.
   ========================================================================== */

let mode = 'preview';               // preview | fly | iso
let anim = null;                    // активный переход {t0,dur,from,to,onDone}
let flyT = 0;

function setQuality(q) {
  if (quality === q) return;
  quality = q;
  rebuildLand();
  // декор пересобираем вместе с качеством (посадка по рельефу lo-крышек)
  disposeChildren(layers.decor);
  for (const isl of doc.islands) buildDecorForIsland(doc, isl, layers.decor, quality);
  // вода с более плотной сеткой
  if (layers.water) {
    scene.remove(layers.water); layers.water.geometry.dispose(); layers.water.material.dispose();
  }
  layers.water = buildWater(doc, q === 'hi');
  layers.water.visible = $('optWater').checked;
  scene.add(layers.water);
}

function updateModeVisibility() {
  const preview = mode === 'preview';
  layers.grid.visible = $('optGrid').checked && (preview || mode === 'fly');
  layers.waterWire.visible = $('optWire').checked && preview;
  layers.landLo.visible = quality === 'lo';
  layers.landHi.visible = quality === 'hi';
  const badge = $('modeBadge');
  badge.textContent = preview ? 'PREVIEW · top-down' : mode === 'fly' ? 'FLYBY · облёт карты' : 'ISOMETRIC · финальный вид';
  document.querySelectorAll('.segbtn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
}

function startTransition(to, onDone) {
  anim = {
    t0: performance.now(), dur: to === 'iso' ? 2600 : 1400,
    from: { tilt: camState.tilt, yaw: camState.yaw, zoom: camState.zoom },
    to, onDone,
  };
  mode = to;
  if (to !== 'preview') setQuality('hi'); else setQuality('lo');
  updateModeVisibility();
}

function tickTransition(now) {
  if (!anim) return;
  const k = clamp((now - anim.t0) / anim.dur, 0, 1);
  const e = easeInOutCubic(k);
  if (anim.to === 'fly') {
    camState.tilt = lerp(camState.from.tilt, lerp(TOP_TILT, ISO_TILT, 0.35), e);
    camState.zoom = lerp(anim.from.zoom, anim.from.zoom * 1.25, Math.sin(e * Math.PI));
  } else if (anim.to === 'iso') {
    camState.tilt = lerp(anim.from.tilt, ISO_TILT, e);
    camState.yaw = lerp(anim.from.yaw, Math.PI * 0.15, e);
    camState.zoom = lerp(anim.from.zoom, fitZoomIso(), e);
  } else { // preview
    camState.tilt = lerp(anim.from.tilt, TOP_TILT, e);
    camState.zoom = lerp(anim.from.zoom, fitZoomTop(), e);
  }
  applyCamera();
  if (k >= 1) { const cb = anim.onDone; anim = null; if (cb) cb(); }
}

function fitZoomTop() {
  const R = doc.meta.hexSize;
  const spanX = (doc.bounds.maxQ - doc.bounds.minQ + 1) * SQRT3 * R;
  const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
  return clamp(Math.max((doc.bounds.maxR - doc.bounds.minR + 1) * 1.5 * R / 2, spanX / 2 / aspect) * 1.12, 6, 120);
}
function fitZoomIso() {
  const R = doc.meta.hexSize;
  const spanX = (doc.bounds.maxQ - doc.bounds.minQ + 1) * SQRT3 * R;
  const spanZ = (doc.bounds.maxR - doc.bounds.minR + 1) * 1.5 * R;
  const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
  return clamp(Math.max(spanZ * 0.75, spanX / 2 / aspect) * 1.1, 6, 120);
}

/* ==========================================================================
   §7  РУЧНОЕ FRUSTUM CULLING
   --------------------------------------------------------------------------
   Three.js сам отсекает объекты по bounding sphere, но мы делаем это явно,
   чтобы счётчик draw calls был управляемым и наглядным (тест из ТЗ №4).
   ========================================================================== */

const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _box = new THREE.Box3();
function cullPass() {
  if (!$('optFrustum').checked) return;
  _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_projScreen);
  const groups = [layers.landLo, layers.landHi, layers.decor];
  for (const grp of groups) {
    for (const ch of grp.children) {
      if (!ch.geometry) continue;
      if (!ch.geometry.boundingSphere) ch.geometry.computeBoundingSphere();
      const bs = ch.geometry.boundingSphere.clone().applyMatrix4(ch.matrixWorld);
      ch.visible = _frustum.intersectsSphere(bs);
    }
  }
}

/* ==========================================================================
   §8  РЕДАКТОР: RAYCAST / ИНСТРУМЕНТЫ / ГИЗМО
   ========================================================================== */

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hitPoint = new THREE.Vector3();

function pointerToWorld(ev) {
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  if (raycaster.ray.intersectPlane(groundPlane, _hitPoint)) return { x: _hitPoint.x, z: _hitPoint.z };
  return null;
}

function worldToTile(x, z) {
  const a = Hex.toAxial(x, z, doc.meta.hexSize);
  const h = Hex.round(a.q, a.r);
  if (!doc.inBounds(h.q, h.r)) return null;
  return h;
}

/** Быстрый поиск ближайшего тайла по сетке (без raycast по мешам). */
function pickTile(ev) {
  const w = pointerToWorld(ev);
  if (!w) return null;
  return worldToTile(w.x, w.z);
}

/** Raycast по мешам суши — для выделения острова кликом по нему. */
function pickIslandMesh(ev) {
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const targets = (quality === 'hi' ? layers.landHi : layers.landLo).children.filter(m => m.visible);
  const hits = raycaster.intersectObjects(targets, false);
  for (const h of hits) {
    const t = h.object.userData.tile;
    if (t && t.island) return t.island;
  }
  return null;
}

/* ---------- гизмо подсветки ---------- */
function makeHighlight(color, opacity) {
  const corners = Hex.unitCorners();
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = corners[i], b = corners[(i + 1) % 6];
    pts.push(a.x, 0, a.z, b.x, 0, b.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  line.visible = false;
  scene.add(line);
  return line;
}
const hoverGizmo = makeHighlight(0x9fe8ff, 0.9);
const selGizmo = makeHighlight(0xffd166, 1.0);

function placeGizmo(gizmo, q, r) {
  const w = Hex.toWorld(q, r, doc.meta.hexSize);
  gizmo.position.set(w.x, 0.02, w.z);
  gizmo.scale.setScalar(doc.meta.hexSize);
  gizmo.visible = true;
}

/* ---------- применение инструментов ---------- */
function paintIslandAt(q, r, type) {
  const existing = doc.islandAtTile(q, r);
  if (existing) { selectIsland(existing.uid); return; }
  const isl = new Island({ q, r, type, radius: defaultRadiusFor(type) });
  doc.islands.push(isl);
  rebuildScene();
  selectIsland(isl.uid);
  showHint('Остров «' + TERRAIN_TYPES[type].label + '» размещён на ' + q + ',' + r);
}

function defaultRadiusFor(type) {
  return type === 'coral' ? 1.0 : type === 'beach' ? 1.1 : type === 'volcanic' ? 1.6 : 1.4;
}

function eraseAt(q, r) {
  const isl = doc.islandAtTile(q, r);
  if (!isl) return;
  const i = doc.islands.indexOf(isl);
  if (i >= 0) doc.islands.splice(i, 1);
  if (selectedUid === isl.uid) closeInspector();
  rebuildScene();
  showHint('Удалён остров ' + isl.q + ',' + isl.r);
}

/* ---------- рисование «кистью» при протяжке ---------- */
let dragging = null;   // {kind:'pan'|'paint'|'marquee', ...}
let lastPaintKey = '';

canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  const t = pickTile(ev);
  if (ev.button === 2 || ev.shiftKey && tool.mode === 'select') {
    dragging = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, target: camState.target.clone() };
    return;
  }
  if (!t) { dragging = null; return; }
  if (tool.mode === 'paint') {
    dragging = { kind: 'paint' };
    lastPaintKey = '';
    paintStroke(t);
  } else if (tool.mode === 'erase') {
    dragging = { kind: 'erase' };
    eraseAt(t.q, t.r);
  } else { // select
    const isl = pickIslandMesh(ev);
    if (isl) { selectIsland(isl.uid); dragging = { kind: 'move', uid: isl.uid, q0: isl.q, r0: isl.r, tile0: t }; }
    else { closeInspector(); selectedUid = null; updateSelectionGizmo(); dragging = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, target: camState.target.clone() }; }
  }
});

canvas.addEventListener('pointermove', (ev) => {
  const t = pickTile(ev);
  hoverTile = t;
  if (t) placeGizmo(hoverGizmo, t.q, t.r); else hoverGizmo.visible = false;

  if (!dragging) return;
  if (dragging.kind === 'pan') {
    const scale = camState.zoom * 2 / (canvas.clientHeight || 1);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const fwd = new THREE.Vector3().crossVectors(right, new THREE.Vector3(0, 1, 0)).normalize();
    camState.target.copy(dragging.target)
      .addScaledVector(right, -(ev.clientX - dragging.sx) * scale)
      .addScaledVector(fwd, (ev.clientY - dragging.sy) * scale);
    applyCamera();
  } else if (dragging.kind === 'paint' && t) {
    paintStroke(t);
  } else if (dragging.kind === 'erase' && t) {
    eraseAt(t.q, t.r);
  } else if (dragging.kind === 'move' && t) {
    const isl = doc.islands.find(i => i.uid === dragging.uid);
    if (isl) {
      const dq = t.q - dragging.tile0.q, dr = t.r - dragging.tile0.r;
      const nq = dragging.q0 + dq, nr = dragging.r0 + dr;
      if (doc.inBounds(nq, nr) && (nq !== isl.q || nr !== isl.r)) {
        isl.q = nq; isl.r = nr;
        refreshLiveEdit();
      }
    }
  }
});

function paintStroke(t) {
  const key = Hex.key(t.q, t.r);
  if (key === lastPaintKey) return;
  lastPaintKey = key;
  paintIslandAt(t.q, t.r, tool.type);
}

window.addEventListener('pointerup', () => { dragging = null; });
canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  if (ev.shiftKey) {          // Shift+колесо — «высота» камеры (zoom)
    camState.zoom = clamp(camState.zoom * (ev.deltaY > 0 ? 1.1 : 0.9), 4, 160);
  } else {
    camState.zoom = clamp(camState.zoom * (ev.deltaY > 0 ? 1.08 : 0.925), 4, 160);
  }
  applyCamera();
}, { passive: false });

function updateSelectionGizmo() {
  const isl = doc.islands.find(i => i.uid === selectedUid);
  if (!isl) { selGizmo.visible = false; return; }
  placeGizmo(selGizmo, isl.q, isl.r);
}

/* ==========================================================================
   §9  ПАНЕЛЬ СВОЙСТВ
   ========================================================================== */

const insp = {
  el: $('inspector'), type: $('pType'), radius: $('pRadius'), height: $('pHeight'),
  rough: $('pRough'), beach: $('pBeach'), veg: $('pVeg'), north: $('pNorth'),
  boulder: $('pBoulder'), peak: $('pPeak'), name: $('pName'), sw: $('pSwatches'), meta: $('pMeta'),
};

for (const k of TYPE_ORDER) {
  const o = document.createElement('option');
  o.value = k; o.textContent = TERRAIN_TYPES[k].label;
  insp.type.appendChild(o);
}

function currentIsland() { return doc.islands.find(i => i.uid === selectedUid) || null; }

function selectIsland(uid) {
  selectedUid = uid;
  const isl = currentIsland();
  if (!isl) { closeInspector(); return; }
  insp.el.classList.remove('hidden');
  insp.type.value = isl.type;
  insp.radius.value = isl.radius; $('oRadius').textContent = isl.radius.toFixed(2);
  insp.height.value = isl.height; $('oHeight').textContent = isl.height.toFixed(2);
  insp.rough.value = isl.rough;   $('oRough').textContent = isl.rough.toFixed(2);
  insp.beach.value = isl.beach;   $('oBeach').textContent = isl.beach.toFixed(2);
  insp.veg.value = isl.veg;       $('oVeg').textContent = isl.veg.toFixed(2);
  insp.north.value = isl.north;   $('oNorth').textContent = isl.north.toFixed(2);
  insp.boulder.checked = isl.boulder;
  insp.peak.checked = isl.peakOn;
  insp.name.value = isl.name;
  renderSwatches(isl);
  refreshInspectorMeta();
  updateSelectionGizmo();
}

function closeInspector() { insp.el.classList.add('hidden'); selectedUid = null; updateSelectionGizmo(); }

function refreshInspectorMeta() {
  const isl = currentIsland(); if (!isl) return;
  const n = [...doc.tiles.values()].filter(t => t.island === isl).length;
  insp.meta.innerHTML =
    'uid: ' + isl.uid + '<br>центр: q=' + isl.q + ' r=' + isl.r +
    '<br>покрыто тайлов: ' + n + '<br>seed: ' + isl.seed;
}

function renderSwatches(isl) {
  insp.sw.innerHTML = '';
  const pal = isl.preset.swatches.concat([null]);
  for (const c of pal) {
    const b = document.createElement('div');
    b.className = 'swatch' + ((isl.color || null) === c ? ' sel' : '');
    b.style.background = c || isl.preset.base;
    if (c === null) { b.title = 'По умолчанию'; b.textContent = '🏝'; b.style.display = 'grid'; b.style.placeItems = 'center'; b.style.fontSize = '11px'; }
    b.onclick = () => { isl.color = c; refreshLiveEdit(); selectIsland(isl.uid); };
    insp.sw.appendChild(b);
  }
}

function bindRange(input, out, prop, fmt) {
  input.addEventListener('input', () => {
    const isl = currentIsland(); if (!isl) return;
    isl[prop] = parseFloat(input.value);
    out.textContent = fmt(isl[prop]);
    refreshLiveEdit();
  });
}
bindRange(insp.radius, $('oRadius'), 'radius', v => v.toFixed(2));
bindRange(insp.height, $('oHeight'), 'height', v => v.toFixed(2));
bindRange(insp.rough, $('oRough'), 'rough', v => v.toFixed(2));
bindRange(insp.beach, $('oBeach'), 'beach', v => v.toFixed(2));
bindRange(insp.veg, $('oVeg'), 'veg', v => v.toFixed(2));
bindRange(insp.north, $('oNorth'), 'north', v => v.toFixed(2));

insp.type.addEventListener('change', () => {
  const isl = currentIsland(); if (!isl) return;
  isl.type = insp.type.value;
  const p = isl.preset;
  isl.height = p.height; isl.rough = p.rough; isl.beach = p.beach; isl.veg = p.veg; isl.color = null;
  refreshLiveEdit(); selectIsland(isl.uid);
});
insp.boulder.addEventListener('change', () => { const i = currentIsland(); if (i) { i.boulder = insp.boulder.checked; refreshLiveEdit(); } });
insp.peak.addEventListener('change', () => { const i = currentIsland(); if (i) { i.peakOn = insp.peak.checked; refreshLiveEdit(); } });
insp.name.addEventListener('input', () => { const i = currentIsland(); if (i) i.name = insp.name.value; });

$('btnDel').addEventListener('click', () => {
  const i = currentIsland(); if (!i) return;
  doc.islands.splice(doc.islands.indexOf(i), 1);
  closeInspector(); rebuildScene();
});
$('btnDup').addEventListener('click', () => {
  const i = currentIsland(); if (!i) return;
  const copy = new Island(Object.assign({}, i.toJSON ? i.toJSON() : i, { uid: undefined, q: i.q + 2, r: i.r + 1, seed: (i.seed ^ 0x5bf03635) | 0 }));
  doc.islands.push(copy); rebuildScene(); selectIsland(copy.uid);
});
$('inspClose').addEventListener('click', closeInspector);

/* ==========================================================================
   §10  ИЗОБРАЖЕНИЕ → КАРТА
   --------------------------------------------------------------------------
   Алгоритм:
     1) изображение рисуется во временный canvas размером cols×rows (или
        пропорционально уменьшенное до ~128 px по большей стороне);
     2) считается luminance каждой ячейки;
     3) cells выше порога (sens) объединяются в связные компоненты (BFS,
        6-соседи в смещённой hex-системе);
     4) каждая компонента ≥ minSize превращается в остров: центр — взвешенный
        centroid, радиус — по площади, тип — по оттенку (hue/sat), высота — по
        средней яркости.
   ========================================================================== */

let pendingImage = null;   // {img, name}

function openImageFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    pendingImage = { img, name: file.name };
    const prev = $('imgPrev'), pc = prev.getContext('2d');
    const sc = Math.min(220 / img.width, 150 / img.height, 1);
    prev.width = Math.max(40, Math.round(img.width * sc));
    prev.height = Math.max(30, Math.round(img.height * sc));
    pc.drawImage(img, 0, 0, prev.width, prev.height);
    $('imgName').textContent = file.name;
    $('imgSize').textContent = img.width + '×' + img.height + ' px';
    $('imgModal').classList.remove('hidden');
  };
  img.onerror = () => { URL.revokeObjectURL(url); alert('Не удалось прочитать изображение.'); };
  img.src = url;
}

function imageToIslands(opts) {
  const img = pendingImage.img;
  const cols = doc.meta.cols, rows = doc.meta.rows;
  const cw = 128, ch = Math.max(24, Math.round(cw * rows / cols));
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, cw, ch);
  const data = ctx.getImageData(0, 0, cw, ch).data;

  // 1) luminance + hue grid
  const lum = new Float32Array(cw * ch);
  const sat = new Float32Array(cw * ch);
  const hue = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sat[i] = mx === 0 ? 0 : d / mx;
    let h = 0;
    if (d !== 0) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    hue[i] = h;
  }

  // 2) порог → binary map
  const bin = new Uint8Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) bin[i] = lum[i] >= opts.sens ? 1 : 0;

  // 3) BFS компоненты связности (8-соседство достаточно для пиксельной сетки)
  const visited = new Uint8Array(cw * ch);
  const blobs = [];
  const stack = [];
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const id = y * cw + x;
      if (!bin[id] || visited[id]) continue;
      visited[id] = 1; stack.length = 0; stack.push(id);
      let count = 0, sumWx = 0, sumWy = 0, sumLum = 0, sumSat = 0, sumHue = 0, maxLum = 0;
      while (stack.length) {
        const cur = stack.pop();
        count++;
        const cxp = cur % cw, cyp = (cur / cw) | 0;
        sumWx += cxp; sumWy += cyp;
        sumLum += lum[cur]; sumSat += sat[cur]; sumHue += hue[cur];
        maxLum = Math.max(maxLum, lum[cur]);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cxp + dx, ny = cyp + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const nid = ny * cw + nx;
          if (bin[nid] && !visited[nid]) { visited[nid] = 1; stack.push(nid); }
        }
      }
      if (count >= opts.minSize) blobs.push({ count, wx: sumWx / count, wy: sumWy / count, avgLum: sumLum / count, avgSat: sumSat / count, avgHue: sumHue / count, maxLum });
    }
  }
  blobs.sort((a, b) => b.count - a.count);
  const chosen = blobs.slice(0, opts.maxIslands);

  // 4) blob → остров в hex-координатах
  const made = [];
  for (const bl of chosen) {
    const fx = bl.wx / cw, fy = bl.wy / ch;              // 0..1
    // пиксель → «world» → axial: используем ту же проекцию, что и Hex.toWorld
    const spanX = (cols) * SQRT3, spanZ = (rows) * 1.5;
    const wx = (fx - 0.5) * spanX + Hex.toWorld((doc.bounds.minQ + doc.bounds.maxQ) / 2, (doc.bounds.minR + doc.bounds.maxR) / 2, 1).x;
    const wz = (fy - 0.5) * spanZ + Hex.toWorld((doc.bounds.minQ + doc.bounds.maxQ) / 2, (doc.bounds.minR + doc.bounds.maxR) / 2, 1).z;
    const ax = Hex.toAxial(wx, wz, 1);
    let h = Hex.round(ax.q, ax.r);
    h.q = clamp(h.q, doc.bounds.minQ, doc.bounds.maxQ);
    h.r = clamp(h.r, doc.bounds.minR, doc.bounds.maxR);
    if (opts.onlyWater && doc.islandAtTile(h.q, h.r)) continue;

    const areaFrac = bl.count / (cw * ch);
    const radius = clamp(Math.sqrt(areaFrac * cols * rows) * 0.55, 0.6, opts.maxRadius);
    const type = classifyTerrain(bl.avgHue, bl.avgSat, bl.avgLum);
    const isl = new Island({
      q: h.q, r: h.r, type,
      radius,
      height: clamp(0.25 + bl.maxLum * 1.4, 0.2, 2.2),
      rough: clamp(0.25 + (1 - bl.avgLum) * 0.6, 0.1, 0.9),
      seed: (bl.wx * 1000 + bl.wy * 37 + count32(bl.avgHue)) | 0,
      name: pendingImage.name.replace(/\.[^.]+$/, '') + ' #' + (made.length + 1),
    });
    made.push(isl);
  }
  return made;
}

function count32(x) { return Math.floor(x * 1e6) | 0; }

/** Эвристика: оттенок/насыщенность/яркость → тип ландшафта. */
function classifyTerrain(hueDeg, sat, lum) {
  if (lum > 0.85 && sat < 0.25) return 'beach';
  if (sat < 0.18) return lum > 0.55 ? 'arid' : 'volcanic';
  if (hueDeg >= 15 && hueDeg < 45) return 'arid';
  if (hueDeg >= 45 && hueDeg < 75) return 'savanna';
  if (hueDeg >= 75 && hueDeg < 170) return 'jungle';
  if (hueDeg >= 170 && hueDeg < 210) return 'mangrove';
  if (hueDeg >= 300 || hueDeg < 15) return 'coral';
  return 'volcanic';
}

/* ==========================================================================
   §11  ФАЙЛЫ: СОХРАНЕНИЕ / ЗАГРУЗКА / DRAG-DROP
   ========================================================================== */

function saveMapFile() {
  const json = JSON.stringify(doc.toJSON(), null, 1);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  const safe = (doc.meta.name || 'map').replace(/[^\w\d\-а-яА-Я ]+/g, '').trim().replace(/\s+/g, '_') || 'map';
  a.href = URL.createObjectURL(blob);
  a.download = safe + '.hexmap.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  showHint('Сохранено: ' + a.download);
}

function loadMapFile(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const obj = JSON.parse(rd.result);
      doc = MapDoc.fromJSON(obj);
      resetCaches();
      selectedUid = null; closeInspector();
      $('metaName').textContent = doc.meta.name || '';
      rebuildScene();
      if (mode !== 'preview') { setQuality('hi'); }
      showHint('Загружена карта: ' + (doc.meta.name || file.name) + ' · островов: ' + doc.islands.length);
    } catch (err) {
      console.error(err);
      alert('Ошибка загрузки карты: ' + err.message);
    }
  };
  rd.readAsText(file);
}

document.addEventListener('dragover', e => { e.preventDefault(); });
document.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  if (f.type.startsWith('image/')) openImageFile(f);
  else if (/\.json$/i.test(f.name) || f.type === 'application/json') loadMapFile(f);
});

/* ==========================================================================
   §12  UI-ПРЯЗКА, СЧЁТЧИКИ, ЦИКЛ, ГОРЯЧИЕ КЛАВИШИ
   ========================================================================== */

// скрытый элемент для имени карты (синхронизируется с meta.name)
const metaNameHolder = document.createElement('span'); metaNameHolder.id = 'metaName'; metaNameHolder.hidden = true;
document.body.appendChild(metaNameHolder);

function showHint(text) {
  const h = $('hint');
  h.textContent = text; h.classList.add('show');
  clearTimeout(showHint._t);
  showHint._t = setTimeout(() => h.classList.remove('show'), 2400);
}

// инструменты
document.querySelectorAll('.tool').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (btn.dataset.tool === 'paint') tool = { mode: 'paint', type: btn.dataset.type };
    else tool = { mode: btn.dataset.tool, type: tool.type };
    canvas.style.cursor = tool.mode === 'select' ? 'default' : 'crosshair';
  });
});

// чекбоксы слоёв
['optGrid', 'optWire', 'optWater', 'optFrustum'].forEach(id => $(id).addEventListener('change', () => {
  if (id === 'optWater') layers.water.visible = $(id).checked;
  else updateModeVisibility();
}));

// toolbar
$('btnNew').addEventListener('click', () => {
  const cols = prompt('Столбцов гексов?', String(doc.meta.cols));
  if (cols === null) return;
  const rows = prompt('Строк гексов?', String(doc.meta.rows));
  if (rows === null) return;
  doc = MapDoc.blank(clamp(parseInt(cols) || 26, 6, 80), clamp(parseInt(rows) || 16, 6, 60));
  resetCaches(); selectedUid = null; closeInspector();
  $('metaName').textContent = doc.meta.name;
  rebuildScene(); showHint('Новая карта ' + doc.meta.cols + '×' + doc.meta.rows);
});
$('btnSave').addEventListener('click', saveMapFile);
$('btnOpen').addEventListener('click', () => $('fileMap').click());
$('fileMap').addEventListener('change', e => { if (e.target.files[0]) loadMapFile(e.target.files[0]); e.target.value = ''; });
$('btnImg').addEventListener('click', () => $('fileImg').click());
$('fileImg').addEventListener('change', e => { if (e.target.files[0]) openImageFile(e.target.files[0]); e.target.value = ''; });

// модалка изображения
$('imgCancel').addEventListener('click', () => $('imgModal').classList.add('hidden'));
$('imgApply').addEventListener('click', () => {
  const opts = {
    maxIslands: parseInt($('pMaxIsl').value), sens: parseFloat($('pSens').value),
    minSize: parseInt($('pMinSz').value), maxRadius: parseFloat($('pMaxR').value),
    onlyWater: $('pOnlyWater').checked,
  };
  const islands = imageToIslands(opts);
  $('imgModal').classList.add('hidden');
  if (!islands.length) { showHint('Островов не найдено — снизьте чувствительность/мин. размер'); return; }
  doc.islands = doc.islands.concat(islands);
  resetCaches();
  rebuildScene();
  showHint('Изображение → карта: добавлено островов — ' + islands.length);
});
[['pMaxIsl', 'oMaxIsl'], ['pSens', 'oSens'], ['pMinSz', 'oMinSz'], ['pMaxR', 'oMaxR']].forEach(([inp, out]) => {
  $(inp).addEventListener('input', () => { $(out).textContent = $(inp).value; });
  $(out).textContent = $(inp).value;
});

// сегменты режима + большая кнопка перехода
document.querySelectorAll('.segbtn').forEach(b => b.addEventListener('click', () => switchMode(b.dataset.mode)));
$('btnTransition').addEventListener('click', () => {
  if (mode === 'iso') { switchMode('preview'); return; }
  // плавный облёт карты → финальная изометрия
  startTransition('fly', () => startTransition('iso'));
});

function switchMode(m) {
  if (m === mode) return;
  if (m === 'preview') startTransition('preview');
  else if (m === 'fly') startTransition('fly');
  else startTransition('iso');
}

/* ---------- счётчики ---------- */
let frames = 0, fpsAcc = 0, lastFpsT = performance.now(), fpsVal = 0;
let objCount = 0;
function countObjects() {
  let n = 0;
  scene.traverse(o => { if (o.isMesh || o.isLine || o.isPoints || o.isSprite) n++; });
  return n;
}
function updateStats(now) {
  frames++;
  if (now - lastFpsT >= 500) {
    fpsVal = Math.round(frames * 1000 / (now - lastFpsT));
    frames = 0; lastFpsT = now;
    objCount = countObjects();
    $('stFps').textContent = fpsVal;
    $('stCalls').textContent = fmtInt(renderer.info.render.calls);
    $('stObjs').textContent = fmtInt(objCount);
    $('stTris').textContent = fmtInt(renderer.info.render.triangles);
    $('stVis').textContent = fmtInt(renderer.info.memory.geometries) + ' geo';
  }
}

/* ---------- анимация воды ---------- */
function animateWater(t) {
  if (!layers.water || !layers.water.visible) return;
  if (quality === 'lo') return;
  const pos = layers.water.geometry.attributes.position;
  const base = layers.water.userData.basePos;
  for (let i = 0; i < pos.count; i++) {
    const x = base[i * 3], z = base[i * 3 + 2];
    pos.array[i * 3 + 1] = Math.sin(x * 0.12 + t * 1.1) * 0.06 + Math.cos(z * 0.16 + t * 0.8) * 0.05;
  }
  pos.needsUpdate = true;
}

/* ---------- главный цикл ---------- */
function loop(now) {
  requestAnimationFrame(loop);
  tickTransition(now);
  if (mode === 'fly' && !anim) {
    flyT += 0.0016;
    camState.yaw = flyT * 0.9;
    camState.tilt = lerp(ISO_TILT, TOP_TILT, 0.15 + 0.15 * Math.sin(flyT * 0.7));
    applyCamera();
  }
  animateWater(now * 0.001);
  cullPass();
  renderer.render(scene, camera);
  updateStats(now);
}

/* ---------- resize ---------- */
function resize() {
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  renderer.setSize(w, h, false);
  applyCamera();
}
new ResizeObserver(resize).observe($('stage'));
window.addEventListener('resize', resize);

/* ---------- горячие клавиши ---------- */
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input,select,textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { closeInspector(); }
  else if (k === 'delete' || k === 'backspace') { const i = currentIsland(); if (i) { doc.islands.splice(doc.islands.indexOf(i), 1); closeInspector(); rebuildScene(); } }
  else if (k === 'g') { $('optGrid').click(); }
  else if (k === 'w') { $('optWater').click(); }
  else if (k === 'f') { $('optFrustum').click(); }
  else if (k === 'enter') { $('btnTransition').click(); }
  else if (k === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveMapFile(); }
  else if (k === 'o' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('fileMap').click(); }
});

/* ---------- стартовая демо-карта (чтобы не быть пустым экраном) ---------- */
function seedDemo() {
  const presets = [
    { q: 6,  r: 5,  type: 'jungle',   radius: 1.9, name: 'Пальмовый бастион' },
    { q: 13, r: 3,  type: 'volcanic', radius: 2.2, name: 'Пепельный пик' },
    { q: 19, r: 8,  type: 'savanna',  radius: 1.5, name: 'Золотистый кос' },
    { q: 9,  r: 11, type: 'coral',    radius: 1.1, name: 'Атол Роз' },
    { q: 22, r: 12, type: 'mangrove', radius: 1.4, name: 'Мангровая топь' },
    { q: 3,  r: 9,  type: 'beach',    radius: 1.0, name: 'Разлом песка' },
  ];
  doc.islands = presets.map(p => new Island(Object.assign({ seed: (p.q * 73856093 ^ p.r * 19349663) | 0 }, p)));
}

/* ---------- boot ---------- */
seedDemo();
rebuildScene();
resize();
requestAnimationFrame(loop);
showHint('Выберите инструмент слева и кликните по тайлу, чтобы разместить остров');

})();
