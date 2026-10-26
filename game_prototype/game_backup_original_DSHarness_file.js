(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  Small utilities                                                    */
  /* ------------------------------------------------------------------ */

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const expDamp = (current, target, lambda, dt) =>
    current + (target - current) * (1 - Math.exp(-lambda * dt));
  const dampAngle = (current, target, lambda, dt) => {
    const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
    return current + delta * (1 - Math.exp(-lambda * dt));
  };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash2(x, z) {
    const v = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
    return v - Math.floor(v);
  }

  function valueNoise(x, z) {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const xf = x - xi;
    const zf = z - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = zf * zf * (3 - 2 * zf);
    const a = hash2(xi, zi);
    const b = hash2(xi + 1, zi);
    const c = hash2(xi, zi + 1);
    const d = hash2(xi + 1, zi + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /* ------------------------------------------------------------------ */
  /*  DOM                                                               */
  /* ------------------------------------------------------------------ */

  const canvas = document.getElementById('world');
  const startScreen = document.getElementById('startScreen');
  const startBtn = document.getElementById('startBtn');
  const endScreen = document.getElementById('endScreen');
  const againBtn = document.getElementById('againBtn');
  const resetBtn = document.getElementById('resetBtn');
  const soundBtn = document.getElementById('soundBtn');
  const countEl = document.getElementById('count');
  const pips = Array.from(document.querySelectorAll('#pips i'));
  const toastEl = document.getElementById('toast');
  const statusText = document.getElementById('statusText');
  const endTimeEl = document.getElementById('endTime');
  const mobilePad = document.getElementById('mobilePad');

  if (!window.THREE) {
    startScreen.innerHTML = '<div class="end-card"><h2>Нет доступа к three.js</h2><p>Файл three.min.js должен лежать рядом с index.html.</p></div>';
    return;
  }

  /* ------------------------------------------------------------------ */
  /*  Renderer, scene and camera                                        */
  /* ------------------------------------------------------------------ */

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
  } catch (error) {
    startScreen.innerHTML = '<div class="end-card"><h2>WebGL недоступен</h2><p>Попробуйте открыть игру в современном браузере с включённым аппаратным ускорением.</p></div>';
    return;
  }

  const getPixelRatio = () =>
    Math.min(window.devicePixelRatio || 1, window.innerWidth < 720 ? 1.65 : 2);

  renderer.setPixelRatio(getPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x09242b, 56, 108);

  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 160);
  const CAMERA_DIR = new THREE.Vector3(0.6, 1, 0.4).normalize();  //(1, 1, 1)

  const cameraHome = new THREE.Vector3();
  const cameraFocus = new THREE.Vector3();
  const cameraDesired = new THREE.Vector3();
  const boatFocus = new THREE.Vector3();
  const cameraRig = {
    zoom: 1,
    initialized: false,
  };
  let particleScaleBase = 24;

  /* ------------------------------------------------------------------ */
  /*  World constants                                                   */
  /* ------------------------------------------------------------------ */

  const NX = 100; //100/80
  const NZ = 40; //40/32
  const HEX_R = 0.155;  //0.31 original - x4 times less than 0.155
  const SQRT3 = Math.sqrt(3);
  const HEX_SX = SQRT3 * HEX_R;
  const HEX_SZ = 1.5 * HEX_R;
  // Five-column patches knitted into one continuous honeycomb: no tile gaps.
  const TILE_W = 5 * HEX_SX;
  const TILE_D = 7.5 * HEX_R;
  const MAP_W = NX * TILE_W;
  const MAP_D = NZ * TILE_D;

  /*const ISLANDS = [
    { x: -5.4, z: -3.3, r: 5.6, seed: 1.31, peak: 1.0, name: 'Аврора' },
    { x: 6.8, z: 4.1, r: 4.5, seed: 2.73, peak: 0.82, name: 'Тихий' },
    { x: -5.8, z: 7.2, r: 2.9, seed: 4.17, peak: 0.62, name: 'Маяк' },
  ];*/
  const ISLANDS = [
  // Юкатан
  { x: -47.5, z: -7.5, r: 4, seed: 1.1, peak: 0.4, name: 'Юкатан' },
  { x: -42.5, z: 0, r: 3, seed: 1.2, peak: 0.5, name: 'Юкатан-юг' },
  { x: -37.5, z: 7.5, r: 1.5, seed: 1.3, peak: 0.6, name: 'Юкатан-низ' },
  
  // Центральная Америка
  { x: -35, z: 12.5, r: 2.5, seed: 2.1, peak: 0.7, name: 'Гватемала' },
  { x: -27.5, z: 15, r: 2, seed: 2.2, peak: 0.8, name: 'Гондурас' },
  { x: -20, z: 16, r: 1.5, seed: 2.3, peak: 0.7, name: 'Никарагуа' },
  { x: -12.5, z: 15, r: 1, seed: 2.4, peak: 0.6, name: 'Коста-Рика' },
  
  // Южная Америка
  { x: 30, z: 17.5, r: 4.5, seed: 3.1, peak: 0.5, name: 'Колумбия' },
  { x: 42.5, z: 19, r: 4.5, seed: 3.2, peak: 0.4, name: 'Венесуэла' },
  { x: 55, z: 17.5, r: 3.5, seed: 3.3, peak: 0.5, name: 'Гайана' },
  
  // Куба
  { x: -15, z: -2.5, r: 3.5, seed: 4.1, peak: 0.9, name: 'Куба-запад' },
  { x: -5, z: -4, r: 2, seed: 4.2, peak: 1.0, name: 'Куба-центр' },
  { x: 5, z: -3, r: 1.5, seed: 4.3, peak: 0.8, name: 'Куба-восток' },
  
  // Гаити
  { x: 17.5, z: 0, r: 3.5, seed: 5.1, peak: 1.1, name: 'Гаити-запад' },
  { x: 25, z: 1, r: 2.5, seed: 5.2, peak: 1.2, name: 'Доминикана' },
  
  // Ямайка
  { x: 2.5, z: 6, r: 2, seed: 6.1, peak: 0.9, name: 'Ямайка' },
  
  // Пуэрто-Рико
  { x: 35, z: 2.5, r: 1, seed: 7.1, peak: 0.8, name: 'Пуэрто-Рико' },
  
  // Багамы
  { x: 10, z: -9, r: 1, seed: 8.1, peak: 0.3, name: 'Багамы-1' },
  { x: 15, z: -11, r: 1.25, seed: 8.2, peak: 0.3, name: 'Багамы-2' },
  { x: 20, z: -10, r: 1.5, seed: 8.3, peak: 0.3, name: 'Багамы-3' },
  { x: 25, z: -9, r: 1, seed: 8.4, peak: 0.3, name: 'Багамы-4' },
  { x: 27.5, z: -7.5, r: 0.75, seed: 8.5, peak: 0.3, name: 'Багамы-5' },
  
  // Малые Антильские
  { x: 40, z: -2.5, r: 1, seed: 9.1, peak: 0.6, name: 'Виргинские о-ва' },
  { x: 42.5, z: 0, r: 0.75, seed: 9.2, peak: 0.5, name: 'Антигуа' },
  { x: 45, z: 2.5, r: 1, seed: 9.3, peak: 0.7, name: 'Гваделупа' },
  { x: 47.5, z: 5, r: 0.75, seed: 9.4, peak: 0.6, name: 'Мартиника' },
  { x: 50, z: 7.5, r: 1, seed: 9.5, peak: 0.8, name: 'Сент-Люсия' },
  { x: 52.5, z: 9, r: 0.75, seed: 9.6, peak: 0.7, name: 'Барбадос' },
  { x: 55, z: 10, r: 0.5, seed: 9.7, peak: 0.5, name: 'Гренада' },
  { x: 57.5, z: 11, r: 0.75, seed: 9.8, peak: 0.6, name: 'Тринидад' },
  
  // Дополнительные
  { x: -7.5, z: 9, r: 1, seed: 10.1, peak: 0.4, name: 'Кайман' },
  { x: 30, z: -6, r: 0.25, seed: 11.1, peak: 0.3, name: 'Теркс' },
  { x: 37.5, z: 14, r: 0.5, seed: 12.1, peak: 0.3, name: 'Аруба' },
  { x: 41, z: 15, r: 0.25, seed: 12.2, peak: 0.3, name: 'Кюрасао' },
];

  const palette = {
    deep: new THREE.Color('#042c36'),
    mid: new THREE.Color('#17666d'),
    crest: new THREE.Color('#8fdbc2'),
    foam: new THREE.Color('#eff7df'),
    sand: new THREE.Color('#d8b977'),
    sandLight: new THREE.Color('#efd9a0'),
    grass: new THREE.Color('#4f8b51'),
    grassLight: new THREE.Color('#73a758'),
    hillLight: new THREE.Color('#afd185'),
    rock: new THREE.Color('#7f877f'),
    rockDark: new THREE.Color('#606b66'),
    snow: new THREE.Color('#e7ede2'),
    gold: new THREE.Color('#f1cf8c'),
  };

  const state = {
    started: false,
    finished: false,
    score: 0,
    startedAt: 0,
    elapsed: 0,
    introTime: 0,
    statusClock: 0,
    boatSpeed: 0,
    viewH: 34,
    collectibles: [],
    boat: {
      /*x: 4.5,
      z: -1.8,
      vx: 0,
      vz: 0,
      heading: 0.2,
      turnRate: 0,
    }*/
	x: 0,
	z: 2.5,
	vx: 0,
	vz: 0,
	heading: 0.2,
	turnRate: 0,
	},
    trail: [],
    trailClock: 0,
  };

  const keys = Object.create(null);
  const keyVectors = {
    forward: new THREE.Vector2(-1, -1).normalize(),
    right: new THREE.Vector2(1, -1).normalize(),
  };

  /* ------------------------------------------------------------------ */
  /*  Lights                                                            */
  /* ------------------------------------------------------------------ */

  scene.add(new THREE.HemisphereLight(0xd8f2ea, 0x10252c, 1.4));

  const sun = new THREE.DirectionalLight(0xffe4b9, 2.55);
  sun.position.set(-13, 23, 9);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -27;
  sun.shadow.camera.right = 27;
  sun.shadow.camera.top = 27;
  sun.shadow.camera.bottom = -27;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 64;
  sun.shadow.bias = -0.00055;
  sun.shadow.normalBias = 0.025;
  scene.add(sun);
  scene.add(sun.target);

  const fillLight = new THREE.DirectionalLight(0x7ad9d0, 0.55);
  fillLight.position.set(14, 9, -15);
  scene.add(fillLight);

  const warmFill = new THREE.DirectionalLight(0xffbe84, 0.3);
  warmFill.position.set(9, 6, 18);
  scene.add(warmFill);

  /* ------------------------------------------------------------------ */
  /*  Textures                                                          */
  /* ------------------------------------------------------------------ */

  function makeGlowTexture(size = 128, irregular = false) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.16, 'rgba(255,255,255,.98)');
    g.addColorStop(0.42, 'rgba(255,255,255,.46)');
    g.addColorStop(0.72, 'rgba(255,255,255,.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);

    if (irregular) {
      const rnd = mulberry32(71);
      ctx.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 22; i++) {
        const a = rnd() * TAU;
        const r = size * (0.06 + rnd() * 0.34);
        const x = size / 2 + Math.cos(a) * r;
        const y = size / 2 + Math.sin(a) * r;
        const rad = size * (0.009 + rnd() * 0.025);
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, TAU);
        ctx.fillStyle = `rgba(0,0,0,${0.25 + rnd() * 0.35})`;
        ctx.fill();
      }
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  const glowTexture = makeGlowTexture(128, false);
  const foamTexture = makeGlowTexture(96, true);

  /* ------------------------------------------------------------------ */
  /*  Geometry helpers                                                  */
  /* ------------------------------------------------------------------ */

  function roundedRectShape(w, d, r) {
    const s = new THREE.Shape();
    const hw = w / 2;
    const hd = d / 2;
    r = Math.min(r, hw, hd);
    s.moveTo(-hw + r, -hd);
    s.lineTo(hw - r, -hd);
    s.quadraticCurveTo(hw, -hd, hw, -hd + r);
    s.lineTo(hw, hd - r);
    s.quadraticCurveTo(hw, hd, hw - r, hd);
    s.lineTo(-hw + r, hd);
    s.quadraticCurveTo(-hw, hd, -hw, hd - r);
    s.lineTo(-hw, -hd + r);
    s.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
    return s;
  }

  function addSlab({ w, d, h, r, top, color, roughness = 0.8, metalness = 0.02, bevel = 0.09 }) {
    const shape = roundedRectShape(w, d, r);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: h,
      steps: 1,
      bevelEnabled: true,
      bevelSegments: 2,
      bevelSize: bevel,
      bevelThickness: bevel,
      curveSegments: 5,
    });
    geo.rotateX(Math.PI / 2);
    geo.translate(0, top, 0);
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness,
      flatShading: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }

  /* ------------------------------------------------------------------ */
  /*  Terrain map                                                       */
  /* ------------------------------------------------------------------ */

  const tiles = [];
  const landTiles = [];
  const landGrid = new Uint8Array(NX * NZ);

  const tileX = (tx) => (tx - (NX - 1) / 2) * TILE_W;
  const tileZ = (tz) => (tz - (NZ - 1) / 2) * TILE_D;
  const idxOf = (tx, tz) => tz * NX + tx;

  for (let tz = 0; tz < NZ; tz++) {
    for (let tx = 0; tx < NX; tx++) {
      const x = tileX(tx);
      const z = tileZ(tz);
      let hit = null;

      for (let i = 0; i < ISLANDS.length; i++) {
        const island = ISLANDS[i];
        const dx = x - island.x;
        const dz = z - island.z;
        const dist = Math.hypot(dx, dz);
        const angle = Math.atan2(dz, dx);
        const wobble =
          1 +
          /*0.145 * Math.sin(angle * 3 + island.seed) +
          0.062 * Math.sin(angle * 5 - island.seed * 1.7) +
          0.035 * Math.sin(angle * 8 + 1.4)*/
		  + 0.25 * Math.sin(angle * 3 + island.seed)        // было 0.145
		  + 0.15 * Math.sin(angle * 5 - island.seed * 1.7)  // было 0.062
		  + 0.08 * Math.sin(angle * 8 + 1.4)                // было 0.035
		  + 0.05 * Math.sin(angle * 13 + island.seed * 2.3); // добавить высокочастотный шум;
        const edge = island.r * wobble;
        if (dist < edge) {
          const q = dist / edge;
          if (!hit || q < hit.q) {
            hit = { island, islandIndex: i, q, dist, edge };
          }
        }
      }

      const tile = {
        tx,
        tz,
        x,
        z,
        land: Boolean(hit),
        island: hit ? hit.island : null,
        islandIndex: hit ? hit.islandIndex : -1,
        q: hit ? hit.q : 1,
        edge: false,
        zone: 'water',
        columns: [],
        avgHeight: 0,
        maxHeight: 0,
        topAtCenter: 0,
      };

      tiles.push(tile);
      if (tile.land) {
        landGrid[idxOf(tx, tz)] = 1;
        landTiles.push(tile);
      }
    }
  }

  for (const tile of landTiles) {
    let edge = false;
    for (let dz = -1; dz <= 1 && !edge; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = tile.tx + dx;
        const nz = tile.tz + dz;
        if (nx < 0 || nz < 0 || nx >= NX || nz >= NZ || !landGrid[idxOf(nx, nz)]) {
          edge = true;
          break;
        }
      }
    }
    tile.edge = edge;
    if (tile.q < 0.31) tile.zone = 'peak';
    else if (tile.q > 0.79) tile.zone = 'sand';
    else if (tile.q < 0.54) tile.zone = 'hill';
    else tile.zone = 'grass';
  }

  function tileAtPoint(x, z) {
    const tx = Math.floor((x + MAP_W / 2) / TILE_W);
    const tz = Math.floor((z + MAP_D / 2) / TILE_D);
    if (tx < 0 || tz < 0 || tx >= NX || tz >= NZ) return null;
    return tiles[idxOf(tx, tz)];
  }

  function isLandPoint(x, z) {
    if (x < -MAP_W / 2 || x > MAP_W / 2 || z < -MAP_D / 2 || z > MAP_D / 2) return true;
    const tile = tileAtPoint(x, z);
    return !tile ? true : tile.land;
  }

  /* ------------------------------------------------------------------ */
  /*  Ocean and land columns                                            */
  /* ------------------------------------------------------------------ */

  const oceanCols = [];
  const landCols = [];

  function columnLocalPositions(tx, tz) {
    const out = [];
    for (let row = 0; row < 5; row++) {
      const globalRow = tz * 5 + row;
      for (let col = 0; col < 5; col++) {
        const x =
          tileX(tx) +
          (col - 2) * HEX_SX +
          (globalRow % 2 ? HEX_SX * 0.5 : 0) -
          HEX_SX * 0.25;
        const z = tileZ(tz) + (row - 2) * HEX_SZ;
        out.push({ x, z });
      }
    }
    return out;
  }

  for (const tile of tiles) {
    if (tile.land) continue;
    const positions = columnLocalPositions(tile.tx, tile.tz);
    for (const p of positions) {
      const broad = valueNoise(p.x * 0.085 + 11.3, p.z * 0.085 - 4.7);
      const fine = valueNoise(p.x * 0.53 - 8.1, p.z * 0.49 + 2.4);
      oceanCols.push({
        x: p.x,
        z: p.z,
        phase: hash2(p.x * 7.13, p.z * 3.71) * TAU,
        shade: 0.94 + broad * 0.075 + fine * 0.035,
        baseTop: (hash2(p.x * 4.4, p.z * 8.8) - 0.5) * 0.012,
      });
    }
  }

  function terrainForColumn(worldX, worldZ, tile) {
    const island = tile.island;
    const dist = Math.hypot(worldX - island.x, worldZ - island.z);
    const q = clamp(dist / island.r, 0, 1);
    const micro =
      valueNoise(worldX * 2.05 + island.seed * 4.1, worldZ * 2.05) * 0.58 +
      valueNoise(worldX * 6.3, worldZ * 6.3 - island.seed) * 0.22;
    const peakRange = island.r * 0.5;
    const peakT = clamp(1 - dist / peakRange, 0, 1);
    const peakRise = (3.15 + island.r * 0.24) * island.peak * Math.pow(peakT, 1.62);

    let height;
    let baseColor;
    const tint = valueNoise(worldX * 4.7 + 10.2, worldZ * 4.7 - 3.8);

    // The colour bands follow the actual shoreline of the island, not the
    // rectangular tile, so fields and hills remain visible inside each tile.
    if (q > 0.79) {
      height = 0.3 + micro * 0.14;
      baseColor = palette.sand.clone().lerp(palette.sandLight, 0.25 + tint * 0.67);
    } else if (q > 0.56) {
      height = 0.54 + micro * 0.17;
      baseColor = palette.grass.clone().lerp(palette.grassLight, 0.16 + tint * 0.55);
    } else if (q > 0.39) {
      height = 0.84 + micro * 0.29 + (0.56 - q) * 0.7;
      baseColor = palette.grassLight.clone().lerp(palette.hillLight, 0.22 + tint * 0.6);
    } else {
      height = 1.08 + micro * 0.35;
      baseColor = palette.rock.clone().lerp(palette.rockDark, 0.28 + tint * 0.4);
    }

    height += peakRise;
    const rockBlend = smoothstep(1.05, 3.1, peakRise);
    if (rockBlend > 0.001) {
      baseColor.lerp(palette.rock.clone().lerp(palette.rockDark, tint * 0.5), rockBlend);
    }
    const snowBlend = smoothstep(3.85, 4.75, height) * (0.68 + tint * 0.28);
    if (snowBlend > 0.001) baseColor.lerp(palette.snow, snowBlend);

    baseColor.offsetHSL((tint - 0.5) * 0.018, (tint - 0.5) * 0.04, (tint - 0.5) * 0.055);

	// ДОБАВЛЕНО по квен
	// Сглаживание на границе
	if (tile.edge && tile.q > 0.7) {
    const blend = smoothstep(0.7, 1.0, tile.q);
    height = lerp(height, 0.1, blend * 0.5);
    baseColor.lerp(palette.mid, blend * 0.3);
  }

    return {
      height,
      color: baseColor,
      peakRise,
    };
  }

  for (const tile of landTiles) {
    const positions = columnLocalPositions(tile.tx, tile.tz);
    let total = 0;
    let max = 0;
    let centerHeight = 0;

    for (const p of positions) {
      const terrain = terrainForColumn(p.x, p.z, tile);
      landCols.push({
        x: p.x,
        z: p.z,
        h: terrain.height,
        color: terrain.color,
        tile,
      });
      total += terrain.height;
      max = Math.max(max, terrain.height);
      if (Math.hypot(p.x - tile.x, p.z - tile.z) < 0.55) centerHeight = terrain.height;
    }

    tile.avgHeight = total / positions.length;
    tile.maxHeight = max;
    tile.topAtCenter = centerHeight || tile.avgHeight;
  }

  /* ------------------------------------------------------------------ */
  /*  Foundations and base diorama                                      */
  /* ------------------------------------------------------------------ */

  addSlab({
    w: MAP_W + 3.7,
    d: MAP_D + 3.7,
    h: 2.9,
    r: 1.45,
    top: -1.92,
    color: 0x082127,
    roughness: 0.9,
    metalness: 0.03,
    bevel: 0.14,
  });
  addSlab({
    w: MAP_W + 3.15,
    d: MAP_D + 3.15,
    h: 0.09,
    r: 1.2,
    top: -1.79,
    color: 0x947042,
    roughness: 0.72,
    metalness: 0.16,
    bevel: 0.04,
  });
  addSlab({
    w: MAP_W + 2.6,
    d: MAP_D + 2.6,
    h: 0.55,
    r: 1.1,
    top: -1.55,
    color: 0x143c44,
    roughness: 0.82,
    metalness: 0.04,
    bevel: 0.1,
  });
  addSlab({
    w: MAP_W + 1.15,
    d: MAP_D + 1.15,
    h: 0.38,
    r: 0.75,
    top: -1.2,
    color: 0x0b3039,
    roughness: 0.66,
    metalness: 0.08,
    bevel: 0.07,
  });

  const underWaterPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_W - 0.06, MAP_D - 0.06),
    new THREE.MeshStandardMaterial({
      color: 0x082a32,
      roughness: 0.44,
      metalness: 0.12,
    })
  );
  underWaterPlane.rotation.x = -Math.PI / 2;
  underWaterPlane.position.y = -1.16;
  underWaterPlane.receiveShadow = true;
  scene.add(underWaterPlane);

  const landFoundationGeo = new THREE.BoxGeometry(1, 1, 1);
  const foundationMat = new THREE.MeshStandardMaterial({
    roughness: 0.88,
    metalness: 0.02,
    vertexColors: false,
  });
  const foundationMesh = new THREE.InstancedMesh(landFoundationGeo, foundationMat, landTiles.length);
  foundationMesh.castShadow = true;
  foundationMesh.receiveShadow = true;
  foundationMesh.frustumCulled = false;

  const foundationDummy = new THREE.Object3D();
  const foundationColors = {
    sand: new THREE.Color('#645437'),
    grass: new THREE.Color('#29452e'),
    hill: new THREE.Color('#355234'),
    peak: new THREE.Color('#3b4541'),
  };

  landTiles.forEach((tile, i) => {
    foundationDummy.position.set(tile.x, 0.055 - 1.25 / 2, tile.z);
    foundationDummy.scale.set(TILE_W, 1.25, TILE_D);
    foundationDummy.rotation.set(0, 0, 0);
    foundationDummy.updateMatrix();
    foundationMesh.setMatrixAt(i, foundationDummy.matrix);
    foundationMesh.setColorAt(i, foundationColors[tile.zone] || foundationColors.grass);
  });
  foundationMesh.instanceMatrix.needsUpdate = true;
  if (foundationMesh.instanceColor) foundationMesh.instanceColor.needsUpdate = true;
  scene.add(foundationMesh);

  /* ------------------------------------------------------------------ */
  /*  Column geometry and meshes                                        */
  /* ------------------------------------------------------------------ */

  function createColumnGeometry(radius, bands = 25) {
    const positions = [];
    const colors = [];
    const indices = [];

    const pushVertex = (x, y, z, shade) => {
      positions.push(x, y, z);
      colors.push(shade, shade, shade);
      return positions.length / 3 - 1;
    };

    const makeRing = (y, shade) => {
      const ring = [];
      for (let s = 0; s < 6; s++) {
        const a = Math.PI / 6 + (s * Math.PI) / 3;
        ring.push(pushVertex(Math.cos(a) * radius, y, Math.sin(a) * radius, shade));
      }
      return ring;
    };

    for (let b = 0; b < bands; b++) {
      const yTop = -b / bands;
      const yBottom = -(b + 1) / bands;
      const bandLight = 0.56 + (1 - b / bands) * 0.075 + (b % 2 ? 0.025 : 0);
      const topRing = makeRing(yTop, bandLight * 1.12);
      const bottomRing = makeRing(yBottom, bandLight * 0.78);

      for (let s = 0; s < 6; s++) {
        const next = (s + 1) % 6;
        indices.push(topRing[s], topRing[next], bottomRing[s]);
        indices.push(topRing[next], bottomRing[next], bottomRing[s]);
      }
    }

    const topRim = [];
    for (let s = 0; s < 6; s++) {
      const a = Math.PI / 6 + (s * Math.PI) / 3;
      topRim.push(pushVertex(Math.cos(a) * radius, 0, Math.sin(a) * radius, 1));
    }
    const center = pushVertex(0, 0, 0, 1);
    for (let s = 0; s < 6; s++) {
      indices.push(center, topRim[(s + 1) % 6], topRim[s]);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  const columnGeo = createColumnGeometry(HEX_R * 0.955, 25);

  // The ocean uses a much lighter prism: the 25 stacked-hex seams are drawn
  // in the shader, which keeps a 100 x 40 map cheap enough to animate on GPU.
  function createOceanColumnGeometry(radius) {
    const positions = [];
    const normals = [];
    const indices = [];

    const addVertex = (x, y, z, nx, ny, nz) => {
      positions.push(x, y, z);
      normals.push(nx, ny, nz);
      return positions.length / 3 - 1;
    };

    const top = [];
    const bottom = [];
    for (let s = 0; s < 6; s++) {
      const a = Math.PI / 6 + (s * Math.PI) / 3;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      top.push(addVertex(nx * radius, 0, nz * radius, nx, 0, nz));
      bottom.push(addVertex(nx * radius, -1, nz * radius, nx, 0, nz));
    }

    for (let s = 0; s < 6; s++) {
      const next = (s + 1) % 6;
      indices.push(top[s], top[next], bottom[s]);
      indices.push(top[next], bottom[next], bottom[s]);
    }

    const rim = [];
    for (let s = 0; s < 6; s++) {
      const a = Math.PI / 6 + (s * Math.PI) / 3;
      rim.push(addVertex(Math.cos(a) * radius, 0, Math.sin(a) * radius, 0, 1, 0));
    }
    const center = addVertex(0, 0, 0, 0, 1, 0);
    for (let s = 0; s < 6; s++) {
      indices.push(center, rim[(s + 1) % 6], rim[s]);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setIndex(indices);
    return geo;
  }

  const oceanGeometry = createOceanColumnGeometry(HEX_R * 0.955);
  const OCEAN_TRAIL_SAMPLES = 12;

  const oceanUniforms = {
    uTime: { value: 0 },
    uBoat: { value: new THREE.Vector4(0, 0, 0, 0) },
    uTrail: {
      value: Array.from({ length: OCEAN_TRAIL_SAMPLES }, () => new THREE.Vector4(0, 0, 99, 0)),
    },
    uTrailCount: { value: 0 },
    uDeep: { value: palette.deep.clone() },
    uMid: { value: palette.mid.clone() },
    uCrest: { value: palette.crest.clone() },
    uFoamColor: { value: palette.foam.clone() },
  };

  const oceanMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.56,
    metalness: 0.1,
    flatShading: true,
  });

  oceanMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, oceanUniforms);
	
	/* ДОБАВЛЕНО для понимания параметров волнения океана
	Шторм sin1 = 0.14 и sin2 - 0.07
	Штиль sin1 = 0.03 и sin2 = 0.015
	
	wave_freq - частоты во времени (скорость волн)
	меньше значение - медленные волны
	больше - мелкая рябь
	
	wave_x_length и wave_y_lenght - длина волн (меньше - волны шире; больше - короче)
	
	const wave_amplitude_base_sin1 = 0.09 // 0.073
	const wave_amplitude_base_sin2 = 0.04 //0.037
	
	const wave_freq_1 = 1.08
	const wave_freq_2 = 1.63
	
	const wave_x_length_1 = 0.53
	const wave_y_lenght_1 = 0.21
	
	const wave_x_length_2 = 0.29
	const wave_y_lenght_2 = 0.82*/
	
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform vec4 uBoat;
        uniform vec4 uTrail[${OCEAN_TRAIL_SAMPLES}];
        uniform float uTrailCount;
        attribute float aPhase;
        attribute float aShade;
        varying float vWave;
        varying float vFoam;
        varying float vLocalH;
        varying float vTop;
        varying float vShade;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec2 instXZ = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
        float ambient = sin(uTime * 1.08 + instXZ.x * 0.53 + instXZ.y * 0.21 + aPhase) * 0.09
                      + sin(uTime * 1.63 - instXZ.x * 0.29 + instXZ.y * 0.82 + 0.9 + aPhase * 0.31) * 0.04;
        float target = ambient;
        float foam = 0.0;
        float speedK = 0.58 + uBoat.w * 0.12;
        float headingX = sin(uBoat.z);
        float headingZ = cos(uBoat.z);

        vec2 boatDelta = instXZ - uBoat.xy;
        float boatD2 = dot(boatDelta, boatDelta);
        if (boatD2 < 18.0) {
          float d = sqrt(boatD2);
          float hull = exp(-boatD2 * 1.25);
          float bowD = d - 1.08;
          float bow = exp(-bowD * bowD * 4.54);
          float ringD = d - 1.9;
          float outerRing = exp(-ringD * ringD * 1.92);
          float ahead = boatD2 > 0.0001 ? dot(boatDelta, vec2(headingX, headingZ)) / d : 0.0;
          target += -0.255 * hull * speedK;
          target += 0.375 * bow * speedK * (0.68 + max(0.0, ahead) * 0.38);
          target += 0.088 * outerRing * speedK;
          foam += hull * 0.14 + bow * 0.46 * speedK;
        }

        for (int i = 0; i < ${OCEAN_TRAIL_SAMPLES}; i++) {
          if (float(i) >= uTrailCount) break;
          vec4 p = uTrail[i];
          float age = p.z;
          if (age > 2.9) continue;
          vec2 trailDelta = instXZ - p.xy;
          float trailD2 = dot(trailDelta, trailDelta);
          if (trailD2 > 9.0) continue;
          float td = sqrt(trailD2);
          float decay = exp(-age * 0.92) * p.w;
          float ripple = sin(td * 8.4 - age * 7.2) * exp(-td * 1.24);
          target += ripple * 0.208 * decay;
          foam += max(ripple, 0.0) * 0.21 * decay * exp(-td * 0.9);
        }

        float wave = clamp(target, -0.43, 0.6);
        float squash = max(0.0, -wave) * 0.3 + clamp(foam, 0.0, 0.75) * 0.14;
        transformed.y += wave / 2.1;
        transformed.xz *= 1.0 + squash;
        vWave = wave;
        vFoam = clamp(foam, 0.0, 0.75);
        vLocalH = clamp(-position.y, 0.0, 1.0);
        vTop = step(0.5, normal.y);
        vShade = aShade;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uDeep;
        uniform vec3 uMid;
        uniform vec3 uCrest;
        uniform vec3 uFoamColor;
        varying float vWave;
        varying float vFoam;
        varying float vLocalH;
        varying float vTop;
        varying float vShade;`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float depthT = clamp((vWave + 0.18) / 0.42, 0.0, 1.0);
        vec3 water = mix(uDeep, uMid, smoothstep(0.0, 0.52, depthT));
        water = mix(water, uCrest, smoothstep(0.5, 1.0, depthT));
        if (vWave > 0.075) {
          water = mix(water, uFoamColor, smoothstep(0.09, 0.33, vWave) * 0.54);
        }
        if (vFoam > 0.015) {
          water = mix(water, uFoamColor, clamp(vFoam * 0.88, 0.0, 0.68));
        }
        float bandCoord = fract(vLocalH * 25.0);
        float bandEdge = min(bandCoord, 1.0 - bandCoord);
        float seam = mix(0.7, 1.0, smoothstep(0.0, 0.11, bandEdge));
        float bandTint = mix(0.93, 1.015, mod(floor(vLocalH * 25.0), 2.0));
        float sideTone = mix(seam * bandTint, 1.055, vTop);
        water *= sideTone * vShade;
        diffuseColor.rgb *= water;`
      );
  };

  oceanMaterial.customProgramCacheKey = () => 'tidal-hex-ocean-v2';

  const landMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.015,
    flatShading: true,
  });

  const oceanMesh = new THREE.InstancedMesh(oceanGeometry, oceanMaterial, oceanCols.length);
  oceanMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  oceanMesh.receiveShadow = true;
  oceanMesh.castShadow = false;
  oceanMesh.frustumCulled = false;
  scene.add(oceanMesh);

  const landMesh = new THREE.InstancedMesh(columnGeo, landMaterial, landCols.length);
  landMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  landMesh.receiveShadow = true;
  landMesh.castShadow = true;
  landMesh.frustumCulled = false;
  scene.add(landMesh);

  const dummy = new THREE.Object3D();

  landCols.forEach((col, i) => {
    dummy.position.set(col.x, col.h, col.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, col.h + 2.6, 1);
    dummy.updateMatrix();
    landMesh.setMatrixAt(i, dummy.matrix);
    landMesh.setColorAt(i, col.color);
  });
  landMesh.instanceMatrix.needsUpdate = true;
  if (landMesh.instanceColor) landMesh.instanceColor.needsUpdate = true;

  const oceanPhases = new Float32Array(oceanCols.length);
  const oceanShades = new Float32Array(oceanCols.length);
  oceanCols.forEach((col, i) => {
    dummy.position.set(col.x, col.baseTop, col.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 2.3, 1);
    dummy.updateMatrix();
    oceanMesh.setMatrixAt(i, dummy.matrix);
    oceanPhases[i] = col.phase;
    oceanShades[i] = col.shade;
  });
  oceanMesh.instanceMatrix.needsUpdate = true;
  oceanGeometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(oceanPhases, 1));
  oceanGeometry.setAttribute('aShade', new THREE.InstancedBufferAttribute(oceanShades, 1));

  /* ------------------------------------------------------------------ */
  /*  Island decoration: trees, rocks, cottages, lighthouse             */
  /* ------------------------------------------------------------------ */

  const decoRng = mulberry32(4901);

  function nearestColumnHeight(tile, x, z) {
    let best = null;
    let bestD = Infinity;
    for (const c of tile.columns) {
      const d = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best ? best.h : tile.avgHeight;
  }

  // Attach the generated land columns to their tiles for decoration lookups.
  for (const tile of landTiles) {
    tile.columns = landCols.filter((c) => c.tile === tile);
  }

  const treeSpots = [];
  for (const tile of landTiles) {
    if (!['grass', 'hill'].includes(tile.zone)) continue;
    if (tile.avgHeight > 2.15) continue;
    const count = (tile.zone === 'grass' && decoRng() < 0.58) || (tile.zone === 'hill' && decoRng() < 0.38) ? 1 : 0;
    for (let i = 0; i < count; i++) {
      const ox = (decoRng() - 0.5) * TILE_W * 0.54;
      const oz = (decoRng() - 0.5) * TILE_D * 0.5;
      const x = tile.x + ox;
      const z = tile.z + oz;
      const y = nearestColumnHeight(tile, x, z);
      const s = 0.78 + decoRng() * 0.55;
      treeSpots.push({ x, z, y, s });
    }
  }

  // A few extra trees make the larger island feel inhabited.
  for (let i = 0; i < 10; i++) {
    const tile = landTiles[Math.floor(decoRng() * landTiles.length)];
    if (!tile || !['grass', 'hill'].includes(tile.zone) || tile.avgHeight > 2.3) continue;
    const x = tile.x + (decoRng() - 0.5) * TILE_W * 0.5;
    const z = tile.z + (decoRng() - 0.5) * TILE_D * 0.5;
    treeSpots.push({ x, z, y: nearestColumnHeight(tile, x, z), s: 0.72 + decoRng() * 0.5 });
  }

  if (treeSpots.length) {
    const trunkGeo = new THREE.CylinderGeometry(0.045, 0.065, 0.36, 5);
    trunkGeo.translate(0, 0.18, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b3e2b, roughness: 1, flatShading: true });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeSpots.length);
    trunks.castShadow = true;
    trunks.receiveShadow = true;
    trunks.frustumCulled = false;

    const lowerGeo = new THREE.ConeGeometry(0.27, 0.72, 6);
    const upperGeo = new THREE.ConeGeometry(0.19, 0.57, 6);
    const crownMat = new THREE.MeshStandardMaterial({
      roughness: 0.92,
      metalness: 0,
      flatShading: true,
    });
    const lowerCrowns = new THREE.InstancedMesh(lowerGeo, crownMat, treeSpots.length);
    const upperCrowns = new THREE.InstancedMesh(upperGeo, crownMat, treeSpots.length);
    lowerCrowns.castShadow = true;
    lowerCrowns.receiveShadow = true;
    upperCrowns.castShadow = true;
    upperCrowns.receiveShadow = true;
    lowerCrowns.frustumCulled = false;
    upperCrowns.frustumCulled = false;

    const treeDummy = new THREE.Object3D();
    treeSpots.forEach((tree, i) => {
      treeDummy.position.set(tree.x, tree.y, tree.z);
      treeDummy.rotation.set(0, decoRng() * TAU, 0);
      treeDummy.scale.set(tree.s, tree.s, tree.s);
      treeDummy.updateMatrix();
      trunks.setMatrixAt(i, treeDummy.matrix);
      treeDummy.position.y = tree.y + 0.34 * tree.s + 0.36 * tree.s;
      treeDummy.updateMatrix();
      lowerCrowns.setMatrixAt(i, treeDummy.matrix);
      const crownColor = palette.grass.clone().lerp(palette.hillLight, 0.12 + decoRng() * 0.45);
      crownColor.offsetHSL((decoRng() - 0.5) * 0.025, 0, (decoRng() - 0.5) * 0.06);
      lowerCrowns.setColorAt(i, crownColor);
      treeDummy.position.y = tree.y + 0.68 * tree.s + 0.285 * tree.s;
      treeDummy.updateMatrix();
      upperCrowns.setMatrixAt(i, treeDummy.matrix);
      upperCrowns.setColorAt(i, crownColor.clone().offsetHSL(0, -0.03, 0.035));
    });

    trunks.instanceMatrix.needsUpdate = true;
    lowerCrowns.instanceMatrix.needsUpdate = true;
    upperCrowns.instanceMatrix.needsUpdate = true;
    if (lowerCrowns.instanceColor) lowerCrowns.instanceColor.needsUpdate = true;
    if (upperCrowns.instanceColor) upperCrowns.instanceColor.needsUpdate = true;
    scene.add(trunks, lowerCrowns, upperCrowns);
  }

  // Palms on a few sandy shores.
  function createPalm(x, y, z, scale = 1) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.scale.setScalar(scale);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x82613f, roughness: 1, flatShading: true });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x60935c, roughness: 0.94, flatShading: true });
    let px = 0;
    let py = 0;
    let pz = 0;
    const segmentSizes = [
      [0.052, 0.075, 0.33],
      [0.043, 0.056, 0.32],
      [0.035, 0.045, 0.3],
    ];
    for (let i = 0; i < segmentSizes.length; i++) {
      const [rt, rb, h] = segmentSizes[i];
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 6), trunkMat);
      const lean = 0.07 * (i + 1);
      seg.position.set(px + lean, py + h / 2, pz);
      seg.rotation.z = -0.1 * i;
      seg.castShadow = true;
      group.add(seg);
      px += lean * 1.7;
      py += h * 0.93;
    }
    const crownY = py + 0.05;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.12, 1.02, 4), leafMat);
      leaf.position.set(Math.cos(a) * 0.24, crownY + 0.12 - (i % 2) * 0.05, Math.sin(a) * 0.24);
      leaf.rotation.order = 'YXZ';
      leaf.rotation.y = -a + Math.PI / 2;
      leaf.rotation.z = -1.12;
      leaf.scale.set(1, 1, 0.32);
      leaf.castShadow = true;
      group.add(leaf);
    }
    const coconutMat = new THREE.MeshStandardMaterial({ color: 0x5f442c, roughness: 1 });
    for (let i = 0; i < 3; i++) {
      const nut = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 4), coconutMat);
      nut.position.set(Math.cos(i * 2.1) * 0.12, crownY - 0.06, Math.sin(i * 2.1) * 0.12);
      group.add(nut);
    }
    scene.add(group);
    return group;
  }

  let palms = 0;
  for (const tile of landTiles) {
    if (palms >= 4) break;
    if (tile.zone !== 'sand' || !tile.edge) continue;
    if (decoRng() > 0.36) continue;
    const x = tile.x + (decoRng() - 0.5) * 0.7;
    const z = tile.z + (decoRng() - 0.5) * 0.55;
    createPalm(x, nearestColumnHeight(tile, x, z), z, 0.8 + decoRng() * 0.3);
    palms++;
  }

  // Small rocks, mostly on beaches and mountain slopes.
  const rockSpots = [];
  for (const tile of landTiles) {
    if (decoRng() > 0.44) continue;
    const x = tile.x + (decoRng() - 0.5) * TILE_W * 0.6;
    const z = tile.z + (decoRng() - 0.5) * TILE_D * 0.55;
    rockSpots.push({
      x,
      z,
      y: nearestColumnHeight(tile, x, z),
      s: 0.55 + decoRng() * 0.9,
      color: palette.rock.clone().lerp(palette.rockDark, decoRng() * 0.55),
    });
  }
  if (rockSpots.length) {
    const rockGeo = new THREE.DodecahedronGeometry(0.18, 0);
    const rockMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: true });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockSpots.length);
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    rocks.frustumCulled = false;
    const rockDummy = new THREE.Object3D();
    rockSpots.forEach((rock, i) => {
      rockDummy.position.set(rock.x, rock.y + rock.s * 0.07, rock.z);
      rockDummy.rotation.set(decoRng() * 0.6, decoRng() * TAU, decoRng() * 0.4);
      rockDummy.scale.set(rock.s, rock.s * 0.7, rock.s);
      rockDummy.updateMatrix();
      rocks.setMatrixAt(i, rockDummy.matrix);
      rocks.setColorAt(i, rock.color);
    });
    rocks.instanceMatrix.needsUpdate = true;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    scene.add(rocks);
  }

  function createCottage(x, y, z, rotation = 0) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.rotation.y = rotation;

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe4d3b1, roughness: 0.88, flatShading: true });
    const wallSideMat = new THREE.MeshStandardMaterial({ color: 0xcbb790, roughness: 0.9, flatShading: true });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xa85940, roughness: 0.86, flatShading: true });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x5c412e, roughness: 1 });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffc372, toneMapped: false });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.32, 0.42), wallMat);
    body.position.y = 0.16;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.59, 0.07, 0.47), wallSideMat);
    plinth.position.y = 0.035;
    plinth.castShadow = true;
    group.add(plinth);

    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.43, 0.3, 4), roofMat);
    roof.position.y = 0.47;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    group.add(roof);

    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.23, 0.09), wallSideMat);
    chimney.position.set(0.14, 0.56, -0.06);
    chimney.castShadow = true;
    group.add(chimney);

    const door = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.18), woodMat);
    door.position.set(-0.11, 0.11, 0.211);
    group.add(door);

    const windowGlow = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.1), glowMat);
    windowGlow.position.set(0.12, 0.21, 0.212);
    group.add(windowGlow);

    const windowFrame = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.13), woodMat);
    windowFrame.position.set(0.12, 0.21, 0.208);
    group.add(windowFrame);
    windowGlow.position.z = 0.211;

    scene.add(group);
    return group;
  }

  const cottageTiles = landTiles.filter((t) => t.zone === 'grass' && t.avgHeight < 1.9).slice(0, 6);
  if (cottageTiles.length > 0) {
    const tile = cottageTiles[Math.floor(cottageTiles.length * 0.34)];
    createCottage(tile.x - 0.25, tile.topAtCenter, tile.z + 0.18, -0.35);
  }
  if (cottageTiles.length > 2) {
    const tile = cottageTiles[Math.floor(cottageTiles.length * 0.78)];
    createCottage(tile.x + 0.3, tile.topAtCenter, tile.z - 0.12, 0.55);
  }

  const lighthouseGroup = new THREE.Group();
  let lighthouseBeam = null;
  const lighthouseTiles = landTiles
    .filter((t) => t.islandIndex === 2)
    .sort((a, b) => (a.zone === 'grass' ? -1 : 0) - (b.zone === 'grass' ? -1 : 0));
  if (lighthouseTiles.length) {
    const tile = lighthouseTiles[0];
    const x = tile.x;
    const z = tile.z;
    const y = nearestColumnHeight(tile, x, z);
    lighthouseGroup.position.set(x, y, z);

    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x9b937c, roughness: 0.94, flatShading: true });
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe8e1cc, roughness: 0.78, flatShading: true });
    const redMat = new THREE.MeshStandardMaterial({ color: 0xb8563f, roughness: 0.8, flatShading: true });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a3433, roughness: 0.7, metalness: 0.18 });
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xffd58a, toneMapped: false });

    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.18, 8), stoneMat);
    base.position.y = 0.09;
    base.castShadow = true;
    base.receiveShadow = true;
    lighthouseGroup.add(base);

    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.245, 1.32, 8), whiteMat);
    tower.position.y = 0.8;
    tower.castShadow = true;
    tower.receiveShadow = true;
    lighthouseGroup.add(tower);

    const bandA = new THREE.Mesh(new THREE.CylinderGeometry(0.207, 0.225, 0.17, 8), redMat);
    bandA.position.y = 0.54;
    bandA.castShadow = true;
    lighthouseGroup.add(bandA);
    const bandB = new THREE.Mesh(new THREE.CylinderGeometry(0.174, 0.192, 0.15, 8), redMat);
    bandB.position.y = 1.11;
    bandB.castShadow = true;
    lighthouseGroup.add(bandB);

    const gallery = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.07, 8), darkMat);
    gallery.position.y = 1.49;
    gallery.castShadow = true;
    lighthouseGroup.add(gallery);

    const lantern = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.24, 8), lightMat);
    lantern.position.y = 1.64;
    lighthouseGroup.add(lantern);

    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.27, 0.22, 8), redMat);
    cap.position.y = 1.87;
    cap.castShadow = true;
    lighthouseGroup.add(cap);

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0xffcc7c,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      })
    );
    glow.position.y = 1.66;
    glow.scale.setScalar(1.15);
    lighthouseGroup.add(glow);

    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 3.2, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffcf86,
        transparent: true,
        opacity: 0.055,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      })
    );
    beam.position.set(0, 1.66, 0);
    beam.rotation.z = Math.PI / 2;
    beam.rotation.y = 0.4;
    lighthouseBeam = beam;
    lighthouseGroup.add(beam);

    const light = new THREE.PointLight(0xffbf70, 5.2, 7.5, 2);
    light.position.set(0, 1.65, 0);
    lighthouseGroup.add(light);

    scene.add(lighthouseGroup);
  }

  /* ------------------------------------------------------------------ */
  /*  Particles and wake                                                */
  /* ------------------------------------------------------------------ */

  const particleCount = 120;
  const particleData = [];
  const particlePositions = new Float32Array(particleCount * 3);
  const particleColors = new Float32Array(particleCount * 3);
  const particleSizes = new Float32Array(particleCount);
  let particleCursor = 0;

  for (let i = 0; i < particleCount; i++) {
    particlePositions[i * 3 + 1] = -100;
    particleData.push({
      life: 0,
      maxLife: 1,
      vx: 0,
      vy: 0,
      vz: 0,
      drag: 0,
      gravity: 0,
      size: 0,
      color: new THREE.Color(0xffffff),
    });
  }

  const particleGeo = new THREE.BufferGeometry();
  particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
  particleGeo.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
  particleGeo.setAttribute('aSize', new THREE.BufferAttribute(particleSizes, 1));
  particleGeo.setDrawRange(0, particleCount);

  const particleMat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: foamTexture },
      uScale: { value: 20 },
    },
    vertexShader: `
      attribute float aSize;
      varying vec3 vColor;
      uniform float uScale;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(aSize * uScale, 1.0, 64.0);
        gl_Position = projectionMatrix * mvPosition;
        vColor = color;
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      varying vec3 vColor;
      void main() {
        vec4 tex = texture2D(uMap, gl_PointCoord);
        if (tex.a < 0.02) discard;
        gl_FragColor = vec4(vColor * tex.rgb, tex.a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    toneMapped: false,
  });

  const particles = new THREE.Points(particleGeo, particleMat);
  particles.frustumCulled = false;
  scene.add(particles);

  function spawnParticle(x, y, z, vx, vy, vz, life, size, color, drag = 1.2, gravity = 0) {
    const p = particleData[particleCursor];
    particleCursor = (particleCursor + 1) % particleCount;
    p.life = life;
    p.maxLife = life;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.drag = drag;
    p.gravity = gravity;
    p.size = size;
    p.color.copy(color);
    particlePositions[particleCursor === 0 ? (particleCount - 1) * 3 : (particleCursor - 1) * 3] = x;
    particlePositions[particleCursor === 0 ? (particleCount - 1) * 3 + 1 : (particleCursor - 1) * 3 + 1] = y;
    particlePositions[particleCursor === 0 ? (particleCount - 1) * 3 + 2 : (particleCursor - 1) * 3 + 2] = z;
  }

  function updateParticles(dt) {
    for (let i = 0; i < particleCount; i++) {
      const p = particleData[i];
      if (p.life > 0) {
        p.life -= dt;
        const t = clamp(p.life / p.maxLife, 0, 1);
        const dragFactor = Math.exp(-p.drag * dt);
        p.vx *= dragFactor;
        p.vz *= dragFactor;
        p.vy = p.vy * dragFactor - p.gravity * dt;
        particlePositions[i * 3] += p.vx * dt;
        particlePositions[i * 3 + 1] += p.vy * dt;
        particlePositions[i * 3 + 2] += p.vz * dt;
        const alpha = Math.pow(t, 0.68);
        particleColors[i * 3] = p.color.r * alpha * 1.18;
        particleColors[i * 3 + 1] = p.color.g * alpha * 1.18;
        particleColors[i * 3 + 2] = p.color.b * alpha * 1.18;
        particleSizes[i] = p.size * (0.72 + t * 0.55);
      } else {
        particlePositions[i * 3 + 1] = -100;
        particleColors[i * 3] = 0;
        particleColors[i * 3 + 1] = 0;
        particleColors[i * 3 + 2] = 0;
        particleSizes[i] = 0;
      }
    }
    particleGeo.attributes.position.needsUpdate = true;
    particleGeo.attributes.color.needsUpdate = true;
    particleGeo.attributes.aSize.needsUpdate = true;
  }

  const wakeMax = 24;
  const wakeGeo = new THREE.BufferGeometry();
  const wakePositions = new Float32Array(wakeMax * 3 * 3);
  const wakeColors = new Float32Array(wakeMax * 3 * 3);
  const wakeIndices = [];
  for (let i = 0; i < wakeMax - 1; i++) {
    const a = i * 3;
    const b = (i + 1) * 3;
    wakeIndices.push(a, a + 1, b, a + 1, b + 1, b);
    wakeIndices.push(a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
  }
  wakeGeo.setAttribute('position', new THREE.BufferAttribute(wakePositions, 3));
  wakeGeo.setAttribute('color', new THREE.BufferAttribute(wakeColors, 3));
  wakeGeo.setIndex(wakeIndices);
  wakeGeo.setDrawRange(0, 0);

  const wakeMesh = new THREE.Mesh(
    wakeGeo,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
  );
  wakeMesh.frustumCulled = false;
  wakeMesh.renderOrder = 3;
  scene.add(wakeMesh);

  /* ------------------------------------------------------------------ */
  /*  Boat                                                              */
  /* ------------------------------------------------------------------ */

  function makeBoatShape(scale = 1) {
    const s = new THREE.Shape();
    s.moveTo(0, 1.24 * scale);
    s.bezierCurveTo(0.55 * scale, 0.8 * scale, 0.63 * scale, 0.12 * scale, 0.45 * scale, -0.62 * scale);
    s.quadraticCurveTo(0.35 * scale, -1.02 * scale, 0, -1.13 * scale);
    s.quadraticCurveTo(-0.35 * scale, -1.02 * scale, -0.45 * scale, -0.62 * scale);
    s.bezierCurveTo(-0.63 * scale, 0.12 * scale, -0.55 * scale, 0.8 * scale, 0, 1.24 * scale);
    return s;
  }

  function createBoat() {
    const root = new THREE.Group();
    root.position.set(state.boat.x, 0.5, state.boat.z);
    root.rotation.y = state.boat.heading;

    const tilt = new THREE.Group();
    tilt.scale.setScalar(1.02);
    root.add(tilt);

    const hullMat = new THREE.MeshStandardMaterial({
      color: 0x4b2e23,
      roughness: 0.64,
      metalness: 0.04,
      flatShading: true,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0xd1a15f,
      roughness: 0.58,
      metalness: 0.08,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    const deckMat = new THREE.MeshStandardMaterial({
      color: 0xb9844c,
      roughness: 0.88,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    const creamMat = new THREE.MeshStandardMaterial({
      color: 0xf1e2c1,
      roughness: 0.85,
      side: THREE.DoubleSide,
      flatShading: true,
    });
    const coralMat = new THREE.MeshStandardMaterial({
      color: 0xc6664d,
      roughness: 0.9,
      side: THREE.DoubleSide,
      flatShading: true,
    });
    const darkWoodMat = new THREE.MeshStandardMaterial({
      color: 0x573a28,
      roughness: 0.9,
      flatShading: true,
    });

    const hullShape = makeBoatShape(1);
    const hullGeo = new THREE.ExtrudeGeometry(hullShape, {
      depth: 0.46,
      steps: 1,
      bevelEnabled: true,
      bevelSegments: 3,
      bevelSize: 0.055,
      bevelThickness: 0.055,
      curveSegments: 8,
    });
    hullGeo.rotateX(Math.PI / 2);
    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.position.y = 0.02;
    hull.castShadow = true;
    hull.receiveShadow = true;
    tilt.add(hull);

    const topPlateGeo = new THREE.ShapeGeometry(makeBoatShape(0.94), 12);
    topPlateGeo.rotateX(Math.PI / 2);
    const topPlate = new THREE.Mesh(topPlateGeo, trimMat);
    topPlate.position.y = 0.071;
    tilt.add(topPlate);

    const deckGeo = new THREE.ShapeGeometry(makeBoatShape(0.77), 12);
    deckGeo.rotateX(Math.PI / 2);
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.position.y = 0.083;
    deck.receiveShadow = true;
    tilt.add(deck);

    // Simple deck planks.
    for (let i = 0; i < 4; i++) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(0.65 - i * 0.08, 0.008, 0.045), darkWoodMat);
      plank.position.set(0, 0.089, 0.55 - i * 0.36);
      tilt.add(plank);
    }

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.036, 1.68, 7), darkWoodMat);
    mast.position.set(0, 0.9, 0.13);
    mast.castShadow = true;
    tilt.add(mast);

    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.024, 1.33, 6), darkWoodMat);
    boom.position.set(0, 0.5, -0.36);
    boom.rotation.x = Math.PI / 2;
    boom.castShadow = true;
    tilt.add(boom);

    const sailGeo = new THREE.BufferGeometry();
    const sailVerts = new Float32Array([
      0.012, 1.7, 0.06,
      0.012, 0.47, -0.92,
      0.012, 0.62, 0.51,
      0.13, 1.03, -0.17,
    ]);
    sailGeo.setAttribute('position', new THREE.BufferAttribute(sailVerts, 3));
    sailGeo.setIndex([0, 1, 3, 0, 3, 2, 3, 1, 2]);
    sailGeo.computeVertexNormals();
    const sail = new THREE.Mesh(sailGeo, creamMat);
    sail.castShadow = true;
    tilt.add(sail);

    const stripeGeo = new THREE.BufferGeometry();
    stripeGeo.setAttribute('position', new THREE.Float32BufferAttribute([
      0.014, 0.51, -0.82,
      0.014, 0.58, 0.42,
      0.15, 0.74, 0.1,
    ], 3));
    stripeGeo.computeVertexNormals();
    const stripe = new THREE.Mesh(stripeGeo, coralMat);
    tilt.add(stripe);

    const flagGroup = new THREE.Group();
    flagGroup.position.set(0, 1.76, 0.12);
    const flag = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape([
      new THREE.Vector2(0, 0),
      new THREE.Vector2(0.28, -0.045),
      new THREE.Vector2(0, -0.13),
    ]), 4), coralMat);
    flag.position.x = 0.009;
    flagGroup.add(flag);
    tilt.add(flagGroup);

    const ropeMat = new THREE.LineBasicMaterial({ color: 0x3c2b21, transparent: true, opacity: 0.8 });
    const ropeGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 1.7, 0.07),
      new THREE.Vector3(0, 0.2, 1.03),
      new THREE.Vector3(0, 1.7, 0.07),
      new THREE.Vector3(0, 0.2, -0.97),
    ]);
    tilt.add(new THREE.LineSegments(ropeGeo, ropeMat));

    const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.02, 0.5, 5), darkWoodMat);
    bowsprit.position.set(0, 0.12, 1.28);
    bowsprit.rotation.x = Math.PI / 2.8;
    bowsprit.castShadow = true;
    tilt.add(bowsprit);

    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.17, 0.22), trimMat);
    crate.position.set(-0.17, 0.16, -0.5);
    crate.rotation.y = 0.3;
    crate.castShadow = true;
    tilt.add(crate);

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.19, 0.28), deckMat);
    cabin.position.set(0.12, 0.17, -0.18);
    cabin.rotation.y = -0.06;
    cabin.castShadow = true;
    tilt.add(cabin);

    const lanternGroup = new THREE.Group();
    lanternGroup.position.set(-0.3, 0.56, -0.68);
    lanternGroup.rotation.z = -0.08;
    const lanternPost = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.42, 5), darkWoodMat);
    lanternPost.position.y = 0.15;
    lanternGroup.add(lanternPost);
    const lanternGlass = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffc37a, toneMapped: false })
    );
    lanternGlass.scale.y = 1.25;
    lanternGlass.position.y = 0.38;
    lanternGroup.add(lanternGlass);
    const lanternCap = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.08, 6), darkWoodMat);
    lanternCap.position.y = 0.48;
    lanternGroup.add(lanternCap);
    const lanternGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0xffb466,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      })
    );
    lanternGlow.position.y = 0.38;
    lanternGlow.scale.setScalar(0.62);
    lanternGroup.add(lanternGlow);
    tilt.add(lanternGroup);

    const boatLight = new THREE.PointLight(0xffb066, 2.1, 3.6, 2);
    boatLight.position.set(-0.27, 0.42, -0.6);
    tilt.add(boatLight);

    // Soft dark contact just above the water columns.
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.8, 24),
      new THREE.MeshBasicMaterial({
        color: 0x04191d,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.16;
    shadow.renderOrder = 2;
    root.add(shadow);

    scene.add(root);
    return { root, tilt, flagGroup, lanternGlow, lanternGlass, boatLight, shadow };
  }

  const boatVisual = createBoat();

  /* ------------------------------------------------------------------ */
  /*  Collectibles                                                      */
  /* ------------------------------------------------------------------ */

  /*const collectibleSpots = [
    [0.0, -4.1],
    [-1.45, -8.55],
    [3.35, -8.1],
    [11.0, -3.8],
    [10.3, 1.8],
    [1.3, 8.8],
    [-10.7, 1.1],
    [-10.6, -9.6],
  ];*/
	const collectibleSpots = [
  [-10, 0],      // пролив между Кубой и Юкатаном
  [10, -7.5],    // Багамы
  [20, 2.5],     // между Кубой и Гаити
  [30, 7.5],     // южнее Гаити
  [40, -2.5],    // восточнее Пуэрто-Рико
  [47.5, 5],     // Малые Антильские
  [-25, 10],     // Центральная Америка
  [50, 15],      // у берегов Венесуэлы
	];

  function findWaterSpot(x, z) {
    if (!isLandPoint(x, z) && canSail(x, z)) return { x, z };
    for (let r = 0.7; r < 7; r += 0.7) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        const nx = x + Math.cos(a) * r;
        const nz = z + Math.sin(a) * r;
        if (!isLandPoint(nx, nz) && canSail(nx, nz)) return { x: nx, z: nz };
      }
    }
    return { x: 0, z: 0 };
  }

  function createCollectible(x, z, index) {
    const group = new THREE.Group();
    group.position.set(x, 0.65, z);

    const coreMat = new THREE.MeshStandardMaterial({
      color: 0xffe5b1,
      emissive: 0xffb85c,
      emissiveIntensity: 2.2,
      roughness: 0.18,
      metalness: 0.15,
      flatShading: true,
      toneMapped: false,
    });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.135, 0), coreMat);
    core.castShadow = false;
    group.add(core);

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0xffc56f,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      })
    );
    halo.scale.setScalar(1.02);
    group.add(halo);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.28, 0.014, 4, 24),
      new THREE.MeshBasicMaterial({
        color: 0xffd58d,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      })
    );
    ring.rotation.x = Math.PI / 2;
    group.add(ring);

    scene.add(group);
    return {
      group,
      core,
      halo,
      ring,
      x,
      z,
      index,
      baseY: 0.65,
      phase: index * 1.34 + 0.5,
      collected: false,
      collectT: 0,
    };
  }

  state.collectibles = collectibleSpots.map((spot, i) => {
    const safe = findWaterSpot(spot[0], spot[1]);
    return createCollectible(safe.x, safe.z, i);
  });

  /* ------------------------------------------------------------------ */
  /*  Collision                                                         */
  /* ------------------------------------------------------------------ */

  function canSail(x, z) {
    const margin = 0.68;
    if (x < -MAP_W / 2 + margin || x > MAP_W / 2 - margin || z < -MAP_D / 2 + margin || z > MAP_D / 2 - margin) {
      return false;
    }
    const r = 0.67;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      if (isLandPoint(x + Math.cos(a) * r, z + Math.sin(a) * r)) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /*  Audio                                                             */
  /* ------------------------------------------------------------------ */

  const Sound = (() => {
    let ctx = null;
    let master = null;
    let oceanGain = null;
    let muted = false;
    let ready = false;

    function connectOcean() {
      const length = Math.floor(ctx.sampleRate * 4);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        last = last * 0.985 + white * 0.015;
        data[i] = last * 2.6;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 540;
      filter.Q.value = 0.65;

      oceanGain = ctx.createGain();
      oceanGain.gain.value = 0.13;
      source.connect(filter);
      filter.connect(oceanGain);
      oceanGain.connect(master);
      source.start();

      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 0.082;
      lfoGain.gain.value = 0.052;
      lfo.connect(lfoGain);
      lfoGain.connect(oceanGain.gain);
      lfo.start();

      const droneGain = ctx.createGain();
      droneGain.gain.value = 0.018;
      droneGain.connect(master);
      [98, 147, 196].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.value = 0.16 - i * 0.03;
        osc.connect(g);
        g.connect(droneGain);
        osc.start();
      });
    }

    function init() {
      if (ready) {
        if (ctx && ctx.state === 'suspended') ctx.resume();
        return;
      }
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      try {
        ctx = new AudioCtx();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : 0.6;
        master.connect(ctx.destination);
        connectOcean();
        ready = true;
      } catch (error) {
        ready = false;
      }
    }

    function setMuted(next) {
      muted = next;
      if (ready && master) {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.linearRampToValueAtTime(muted ? 0 : 0.6, ctx.currentTime + 0.4);
      }
    }

    function chime(index = 0) {
      if (!ready || muted) return;
      const notes = [523.25, 659.25, 783.99, 1046.5];
      const base = notes[index % notes.length];
      const now = ctx.currentTime;
      [1, 1.5].forEach((ratio, j) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = j === 0 ? 'sine' : 'triangle';
        osc.frequency.value = base * ratio;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(j === 0 ? 0.13 : 0.035, now + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.55 + j * 0.25);
        osc.connect(gain);
        gain.connect(master);
        osc.start(now);
        osc.stop(now + 1.9);
      });
    }

    function finish() {
      if (!ready || muted) return;
      const now = ctx.currentTime;
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + i * 0.11);
        gain.gain.linearRampToValueAtTime(0.085, now + i * 0.11 + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.11 + 1.8);
        osc.connect(gain);
        gain.connect(master);
        osc.start(now + i * 0.11);
        osc.stop(now + i * 0.11 + 2);
      });
    }

    return {
      init,
      chime,
      finish,
      get muted() { return muted; },
      setMuted,
    };
  })();

  soundBtn.addEventListener('click', () => {
    Sound.init();
    const muted = !Sound.muted;
    Sound.setMuted(muted);
    document.body.classList.toggle('sound-off', muted);
    soundBtn.setAttribute('aria-label', muted ? 'Включить звук' : 'Выключить звук');
  });

  // Start with a quiet, muted icon state only if audio is unavailable; otherwise sound is on.
  soundBtn.setAttribute('aria-label', 'Выключить звук');

  /* ------------------------------------------------------------------ */
  /*  UI helpers                                                        */
  /* ------------------------------------------------------------------ */

  let toastTimeout = null;
  function showToast(message, duration = 2400) {
    toastEl.textContent = message;
    toastEl.classList.add('visible');
    if (toastTimeout) window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => {
      toastEl.classList.remove('visible');
    }, duration);
  }

  function updateScoreUI() {
    countEl.textContent = String(state.score);
    pips.forEach((pip, i) => pip.classList.toggle('active', i < state.score));
  }

  function updateStatus(dt) {
    state.statusClock -= dt;
    if (state.statusClock > 0) return;
    state.statusClock = 0.55;
    if (state.finished) {
      statusText.textContent = 'Все искры собраны';
    } else if (state.boatSpeed > 3.6) {
      statusText.textContent = 'Попутный ветер';
    } else if (state.boatSpeed > 0.4) {
      statusText.textContent = 'Волна за кормой';
    } else {
      statusText.textContent = 'Море спокойно';
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Game logic                                                        */
  /* ------------------------------------------------------------------ */

  function sampleAmbientWave(x, z, time) {
    return (
      Math.sin(time * 1.08 + x * 0.53 + z * 0.21) * 0.09 +
      Math.sin(time * 1.63 - x * 0.29 + z * 0.82 + 0.9) * 0.04
    );
  }

  function recordTrail(dt) {
    state.trailClock += dt;
    const moving = state.boatSpeed > 0.25;
    if (moving && state.trailClock > 0.055) {
      state.trailClock = 0;
      const heading = state.boat.heading;
      const backX = state.boat.x - Math.sin(heading) * 0.82;
      const backZ = state.boat.z - Math.cos(heading) * 0.82;
      state.trail.push({
        x: backX,
        z: backZ,
        age: 0,
        strength: clamp(state.boatSpeed / 3.4, 0.22, 1.1),
      });
      if (state.trail.length > wakeMax) state.trail.shift();
    }

    for (let i = state.trail.length - 1; i >= 0; i--) {
      state.trail[i].age += dt;
      if (state.trail[i].age > 3.1) state.trail.splice(i, 1);
    }
  }

  function updateWakeRibbon() {
    const points = [];
    const heading = state.boat.heading;
    const current = {
      x: state.boat.x - Math.sin(heading) * 0.72,
      z: state.boat.z - Math.cos(heading) * 0.72,
      age: 0,
      strength: clamp(state.boatSpeed / 3.4, 0.2, 1.05),
    };

    if (state.boatSpeed > 0.22) points.push(current);

    for (let i = state.trail.length - 1; i >= 0 && points.length < wakeMax; i--) {
      points.push(state.trail[i]);
    }

    if (points.length < 2) {
      wakeGeo.setDrawRange(0, 0);
      return;
    }

    let idx = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      let tx = p.x - next.x;
      let tz = p.z - next.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      let px = -tz;
      let pz = tx;
      const age = p.age;
      const fade = Math.pow(clamp(1 - age / 3.15, 0, 1), 1.45) * p.strength;
      const width = (0.075 + age * 0.06) * (0.58 + Math.min(0.9, state.boatSpeed / 4.8));
      const wobble = Math.sin(age * 4.7 + i * 0.8) * 0.019;
      const lateral = Math.sin(age * 4.2 + i * 0.62) * 0.055 * Math.min(1, age);
      const y = 0.45 + Math.sin(age * 2.1 + i) * 0.007;
      const foamPulse = 0.55 + 0.45 * Math.abs(Math.sin(age * 6.7 + i * 0.93));

      const cx = p.x + px * lateral;
      const cz = p.z + pz * lateral;
      const base = idx * 9;
      wakePositions[base] = cx - px * width;
      wakePositions[base + 1] = y;
      wakePositions[base + 2] = cz - pz * width;
      wakePositions[base + 3] = cx + wobble * px;
      wakePositions[base + 4] = y + 0.008;
      wakePositions[base + 5] = cz + wobble * pz;
      wakePositions[base + 6] = cx + px * width;
      wakePositions[base + 7] = y;
      wakePositions[base + 8] = cz + pz * width;

      const edge = 0.3 * fade * foamPulse;
      const center = 0.075 * fade * foamPulse;
      wakeColors[base] = edge * 0.7;
      wakeColors[base + 1] = edge * 0.92;
      wakeColors[base + 2] = edge * 0.86;
      wakeColors[base + 3] = center * 0.8;
      wakeColors[base + 4] = center * 0.96;
      wakeColors[base + 5] = center * 0.87;
      wakeColors[base + 6] = edge * 0.7;
      wakeColors[base + 7] = edge * 0.92;
      wakeColors[base + 8] = edge * 0.86;
      idx++;
    }

    wakeGeo.attributes.position.needsUpdate = true;
    wakeGeo.attributes.color.needsUpdate = true;
    wakeGeo.setDrawRange(0, (idx - 1) * 12);
  }

  function updateBoat(dt, time) {
    if (!state.started || state.finished) {
      state.boat.vx = expDamp(state.boat.vx, 0, 3.6, dt);
      state.boat.vz = expDamp(state.boat.vz, 0, 3.6, dt);
      state.boatSpeed = Math.hypot(state.boat.vx, state.boat.vz);
    } else {
      let ix = 0;
      let iz = 0;
      if (keys.KeyW || keys.ArrowUp) iz += 1;
      if (keys.KeyS || keys.ArrowDown) iz -= 1;
      if (keys.KeyD || keys.ArrowRight) ix += 1;
      if (keys.KeyA || keys.ArrowLeft) ix -= 1;

      const dir = new THREE.Vector2();
      if (ix || iz) {
        dir.addScaledVector(keyVectors.right, ix);
        dir.addScaledVector(keyVectors.forward, iz);
        dir.normalize();
      }

      const boost = keys.ShiftLeft || keys.ShiftRight;
      const maxSpeed = boost ? 5.1 : 3.25;
      const desiredVx = dir.x * maxSpeed;
      const desiredVz = dir.y * maxSpeed;
      const lambda = dir.lengthSq() > 0.01 ? 5.2 : 3.4;
      state.boat.vx = expDamp(state.boat.vx, desiredVx, lambda, dt);
      state.boat.vz = expDamp(state.boat.vz, desiredVz, lambda, dt);

      let moved = false;
      const nextX = state.boat.x + state.boat.vx * dt;
      if (canSail(nextX, state.boat.z)) {
        state.boat.x = nextX;
        moved = true;
      } else {
        state.boat.vx *= -0.15;
        emitCollisionFoam();
      }
      const nextZ = state.boat.z + state.boat.vz * dt;
      if (canSail(state.boat.x, nextZ)) {
        state.boat.z = nextZ;
        moved = true;
      } else {
        state.boat.vz *= -0.15;
        emitCollisionFoam();
      }

      state.boatSpeed = Math.hypot(state.boat.vx, state.boat.vz);
      if (state.boatSpeed > 0.08) {
        const targetHeading = Math.atan2(state.boat.vx, state.boat.vz);
        const prev = state.boat.heading;
        state.boat.heading = dampAngle(state.boat.heading, targetHeading, 6.2, dt);
        state.boat.turnRate = dampAngle(0, Math.atan2(Math.sin(state.boat.heading - prev), Math.cos(state.boat.heading - prev)) / Math.max(dt, 0.001), 5, dt);
      } else {
        state.boat.turnRate = expDamp(state.boat.turnRate, 0, 4, dt);
      }

      if (!moved && dir.lengthSq() > 0.01) {
        state.boat.vx *= 0.95;
        state.boat.vz *= 0.95;
      }
    }

    const wave = sampleAmbientWave(state.boat.x, state.boat.z, time);
    const bob = Math.sin(time * 1.7 + 0.5) * 0.032 + Math.sin(time * 2.65) * 0.013;
    const speedLift = Math.min(state.boatSpeed, 4.8) * 0.008;
    const rootY = 0.49 + wave * 0.65 + bob + speedLift;
    state.boat.turnRate = clamp(state.boat.turnRate, -4.5, 4.5);

    boatVisual.root.position.set(state.boat.x, rootY, state.boat.z);
    boatVisual.root.rotation.y = state.boat.heading;
    const targetRoll = clamp(-state.boat.turnRate * 0.045, -0.17, 0.17) + Math.sin(time * 1.13) * 0.018;
    const targetPitch = clamp((state.boatSpeed / 5.1) * 0.09, 0, 0.09) + Math.sin(time * 1.47 + 0.4) * 0.012;
    boatVisual.tilt.rotation.z = expDamp(boatVisual.tilt.rotation.z, targetRoll, 4.5, dt);
    boatVisual.tilt.rotation.x = expDamp(boatVisual.tilt.rotation.x, -targetPitch, 4.5, dt);
    boatVisual.shadow.position.y = 0.155 + wave * 0.32;
    boatVisual.shadow.material.opacity = 0.22 + clamp(-wave, 0, 0.2) * 0.4;
    boatVisual.flagGroup.rotation.y = Math.sin(time * 5.5) * 0.13;
    boatVisual.lanternGlow.scale.setScalar(0.58 + Math.sin(time * 3.1) * 0.035);
    boatVisual.lanternGlass.material.color.setHSL(0.09, 0.9, 0.67 + Math.sin(time * 2.2) * 0.025);
    boatVisual.boatLight.intensity = 1.9 + Math.sin(time * 2.5) * 0.2;
  }

  let collisionFoamClock = 0;
  function emitCollisionFoam() {
    if (performance.now() - collisionFoamClock < 170) return;
    collisionFoamClock = performance.now();
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * TAU;
      const sp = 0.2 + Math.random() * 0.5;
      spawnParticle(
        state.boat.x + Math.cos(a) * 0.42,
        0.4,
        state.boat.z + Math.sin(a) * 0.42,
        Math.cos(a) * sp,
        0.25 + Math.random() * 0.3,
        Math.sin(a) * sp,
        0.45 + Math.random() * 0.35,
        0.18 + Math.random() * 0.12,
        palette.foam,
        2.2,
        0.45
      );
    }
    if (navigator.vibrate && navigator.userActivation && navigator.userActivation.hasBeenActive) {
      navigator.vibrate(8);
    }
  }

  function emitWakeParticles(dt) {
    if (!state.started || state.finished) return;
    if (state.boatSpeed < 0.6) return;
    collisionFoamClock = collisionFoamClock || 0;
    const rate = state.boatSpeed > 3.6 ? 0.033 : 0.07;
    if (state.trailClock < rate * 0.5) {
      // trailClock already drives the ribbon; use its pace as a loose timer.
    }
    if (Math.random() > state.boatSpeed / 4.8) return;
    const heading = state.boat.heading;
    const backX = state.boat.x - Math.sin(heading) * 0.72;
    const backZ = state.boat.z - Math.cos(heading) * 0.72;
    const side = Math.random() < 0.5 ? -1 : 1;
    const sideX = Math.cos(heading) * 0.34 * side;
    const sideZ = -Math.sin(heading) * 0.34 * side;
    spawnParticle(
      backX + sideX + (Math.random() - 0.5) * 0.22,
      0.49,
      backZ + sideZ + (Math.random() - 0.5) * 0.22,
      sideX * 1.85 + (Math.random() - 0.5) * 0.14,
      0.05 + Math.random() * 0.08,
      sideZ * 1.85 + (Math.random() - 0.5) * 0.14,
      0.8 + Math.random() * 0.75,
      0.19 + Math.random() * 0.16,
      palette.foam,
      1.4,
      0
    );
    if (Math.random() > 0.52) {
      spawnParticle(
        state.boat.x + Math.sin(heading) * 0.75,
        0.52,
        state.boat.z + Math.cos(heading) * 0.75,
        Math.sin(heading) * 0.28 + (Math.random() - 0.5) * 0.3,
        0.1 + Math.random() * 0.16,
        Math.cos(heading) * 0.28 + (Math.random() - 0.5) * 0.3,
        0.55 + Math.random() * 0.55,
        0.16 + Math.random() * 0.13,
        palette.foam,
        1.7,
        0.2
      );
    }
  }

  function updateCollectibles(dt, time) {
    for (const c of state.collectibles) {
      if (c.collected) {
        if (c.collectT > 0) {
          c.collectT -= dt;
          const t = clamp(c.collectT / 0.42, 0, 1);
          c.group.scale.setScalar(1 + (1 - t) * 1.8);
          c.group.position.y += dt * 0.9;
          c.halo.material.opacity = t * 0.9;
          c.ring.material.opacity = t * 0.7;
          c.core.rotation.y += dt * 5;
          if (c.collectT <= 0) c.group.visible = false;
        }
        continue;
      }

      const bob = Math.sin(time * 1.45 + c.phase) * 0.08;
      c.group.position.y = c.baseY + bob;
      c.core.rotation.y += dt * 0.8;
      c.core.rotation.x = Math.sin(time * 0.7 + c.phase) * 0.25;
      c.ring.rotation.z += dt * 0.35;
      c.ring.rotation.x = Math.PI / 2 + Math.sin(time * 0.8 + c.phase) * 0.12;
      c.halo.scale.setScalar(0.94 + Math.sin(time * 2.2 + c.phase) * 0.08);

      if (!state.started || state.finished) continue;
      const dx = state.boat.x - c.x;
      const dz = state.boat.z - c.z;
      if (dx * dx + dz * dz < 1.32 * 1.32) {
        collect(c);
      }
    }
  }

  function collect(c) {
    c.collected = true;
    c.collectT = 0.42;
    state.score++;
    updateScoreUI();
    Sound.chime(state.score - 1);
    showToast(`Искра ${state.score} / 8 · ${['рассвет', 'соль', 'бриз', 'тайна', 'путь', 'эхо', 'берег', 'дом'][state.score - 1] || 'свет'}`);
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * TAU;
      const elev = Math.random() * Math.PI * 0.7;
      const speed = 0.35 + Math.random() * 0.8;
      spawnParticle(
        c.x,
        c.group.position.y,
        c.z,
        Math.cos(a) * Math.cos(elev) * speed,
        0.35 + Math.sin(elev) * speed,
        Math.sin(a) * Math.cos(elev) * speed,
        0.7 + Math.random() * 0.9,
        0.16 + Math.random() * 0.16,
        palette.gold,
        1.2,
        0.55
      );
    }
    if (state.score >= 8) {
      state.finished = true;
      Sound.finish();
      window.setTimeout(showEndScreen, 1200);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Ocean animation                                                   */
  /* ------------------------------------------------------------------ */

  function updateOcean(dt, time) {
    const boat = state.boat;

    oceanUniforms.uTime.value = time;
    oceanUniforms.uBoat.value.set(boat.x, boat.z, boat.heading, state.boatSpeed);

    const trail = state.trail;
    const count = Math.min(OCEAN_TRAIL_SAMPLES, trail.length);
    oceanUniforms.uTrailCount.value = count;

    for (let i = 0; i < count; i++) {
      const index = count === 1
        ? trail.length - 1
        : Math.round((i / (count - 1)) * (trail.length - 1));
      const p = trail[index];
      oceanUniforms.uTrail.value[i].set(p.x, p.z, p.age, p.strength);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Camera fitting                                                    */
  /* ------------------------------------------------------------------ */

  function fitCamera() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const aspect = width / height;

    // The world is now 100 x 40 tiles, so the camera works as a local
    // cinematic viewport instead of trying to fit the whole map.
    let viewH;
    if (aspect < 0.7) viewH = 58;
    else if (aspect < 1.05) viewH = 48;
    else viewH = 36;
    const viewW = viewH * aspect;
    state.viewH = viewH;

    camera.left = -viewW / 2;
    camera.right = viewW / 2;
    camera.top = viewH / 2;
    camera.bottom = -viewH / 2;
    camera.near = 0.1;
    camera.far = 180;

    cameraHome.set(0, 0.15, 0);
    if (!state.started || !cameraRig.initialized) {
      cameraFocus.copy(cameraHome);
    }

    camera.position.copy(cameraFocus).addScaledVector(CAMERA_DIR, 62);
    camera.lookAt(cameraFocus);
    camera.zoom = cameraRig.zoom;
    camera.updateProjectionMatrix();
    cameraRig.initialized = true;

    renderer.setSize(width, height, false);
    renderer.setPixelRatio(getPixelRatio());

    const drawSize = new THREE.Vector2();
    renderer.getDrawingBufferSize(drawSize);
    particleScaleBase = (drawSize.y / viewH) * 1.45;
    particleMat.uniforms.uScale.value = particleScaleBase * cameraRig.zoom;
  }

  fitCamera();

  function updateCamera(dt) {
    let targetZoom = 1;

    if (state.started) {
      const speedT = smoothstep(0.04, 4.2, state.boatSpeed);  // 2.9 скорость стояния и макс скорость кораблика
      targetZoom = lerp(2.4, 0.9, speedT);  // 2, 1 = крупный план - широкий план на скорости
    }

    cameraRig.zoom = expDamp(cameraRig.zoom, targetZoom, 1.75, dt);  // 2.15 - плавность наезда/отъезда
    if (Math.abs(cameraRig.zoom - targetZoom) < 0.0004) {
      cameraRig.zoom = targetZoom;
    }

    if (state.started) {
      const lead = 0.18;
      boatFocus.set(
        state.boat.x + state.boat.vx * lead,
        0.55,
        state.boat.z + state.boat.vz * lead
      );
      cameraDesired.copy(boatFocus);
    } else {
      cameraDesired.copy(cameraHome);
    }

    cameraFocus.lerp(cameraDesired, 1 - Math.exp(-3.25 * dt));
    camera.position.copy(cameraFocus).addScaledVector(CAMERA_DIR, 62);
    camera.lookAt(cameraFocus);
    camera.zoom = cameraRig.zoom;
    camera.updateProjectionMatrix();
    particleMat.uniforms.uScale.value = particleScaleBase * cameraRig.zoom;

    // Keep the shadow map travelling with the playable area.
    sun.position.set(cameraFocus.x - 13, 23, cameraFocus.z + 9);
    sun.target.position.set(cameraFocus.x, 0, cameraFocus.z);
    sun.target.updateMatrixWorld();
  }

  window.addEventListener('resize', () => {
    fitCamera();
  });

  /* ------------------------------------------------------------------ */
  /*  Input                                                             */
  /* ------------------------------------------------------------------ */

  window.addEventListener('keydown', (e) => {
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
      keys[e.code] = true;
    }
    if (e.code === 'KeyR' && state.started) {
      resetGame(true);
    }
  });

  window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });

  window.addEventListener('blur', () => {
    for (const key of Object.keys(keys)) keys[key] = false;
  });

  // Touch controls.
  if (mobilePad) {
    mobilePad.querySelectorAll('[data-key]').forEach((btn) => {
      const code = btn.getAttribute('data-key');
      const press = (e) => {
        e.preventDefault();
        keys[code] = true;
        btn.classList.add('is-pressed');
        if (btn.setPointerCapture) btn.setPointerCapture(e.pointerId);
      };
      const release = (e) => {
        e.preventDefault();
        keys[code] = false;
        btn.classList.remove('is-pressed');
      };
      btn.addEventListener('pointerdown', press);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('pointerleave', (e) => {
        if (e.buttons === 0) release(e);
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Start / reset / end                                               */
  /* ------------------------------------------------------------------ */

  function beginPlay() {
    if (state.started) return;
    state.started = true;
    state.startedAt = performance.now();
    Sound.init();
    document.body.classList.add('playing');
    startScreen.classList.add('is-leaving');
    window.setTimeout(() => {
      startScreen.style.display = 'none';
    }, 950);
    showToast('Найдите восемь искр', 2600);
  }

  startBtn.addEventListener('click', beginPlay);

  function showEndScreen() {
    if (!state.finished) return;
    endTimeEl.textContent = formatTime((performance.now() - state.startedAt) / 1000);
    endScreen.hidden = false;
    document.body.classList.remove('playing');
  }

  function resetGame(autoStart = false) {
    const wasStarted = state.started;
    state.finished = false;
    state.score = 0;
    state.trail.length = 0;
    state.boat.x = 4.5;
    state.boat.z = -1.8;
    state.boat.vx = 0;
    state.boat.vz = 0;
    state.boat.heading = 0.2;
    state.boat.turnRate = 0;
    state.boatSpeed = 0;
    state.startedAt = performance.now();
    state.started = autoStart || wasStarted;
    updateScoreUI();
    endScreen.hidden = true;

    for (const c of state.collectibles) {
      c.collected = false;
      c.collectT = 0;
      c.group.visible = true;
      c.group.scale.setScalar(1);
      c.group.position.y = c.baseY;
      c.halo.material.opacity = 0.9;
      c.ring.material.opacity = 0.7;
    }

    for (let i = 0; i < particleCount; i++) {
      particleData[i].life = 0;
      particlePositions[i * 3 + 1] = -100;
      particleSizes[i] = 0;
    }
    particleGeo.attributes.position.needsUpdate = true;
    particleGeo.attributes.aSize.needsUpdate = true;

    document.body.classList.add('playing');
    if (startScreen.style.display !== 'none' && state.started) {
      startScreen.classList.add('is-leaving');
      window.setTimeout(() => {
        startScreen.style.display = 'none';
      }, 950);
    }
    showToast('Новая одиссея · курс проложен', 2200);
  }

  resetBtn.addEventListener('click', () => {
    resetGame(true);
  });

  againBtn.addEventListener('click', () => {
    resetGame(true);
    endScreen.hidden = true;
  });

  /* ------------------------------------------------------------------ */
  /*  Ambient life                                                      */
  /* ------------------------------------------------------------------ */

  const moteCount = 52;
  const motePositions = new Float32Array(moteCount * 3);
  const moteSeeds = [];
  const moteRng = mulberry32(813);
  for (let i = 0; i < moteCount; i++) {
    const x = (moteRng() - 0.5) * MAP_W * 0.94;
    const z = (moteRng() - 0.5) * MAP_D * 0.94;
    const y = 0.8 + moteRng() * 4.1;
    motePositions[i * 3] = x;
    motePositions[i * 3 + 1] = y;
    motePositions[i * 3 + 2] = z;
    moteSeeds.push({
      x,
      y,
      z,
      phase: moteRng() * TAU,
      speed: 0.05 + moteRng() * 0.13,
      amp: 0.1 + moteRng() * 0.35,
    });
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePositions, 3));
  const moteMat = new THREE.PointsMaterial({
    map: glowTexture,
    color: 0xf4d493,
    size: 0.15,
    transparent: true,
    opacity: 0.44,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    toneMapped: false,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false;
  scene.add(motes);

  function updateMotes(time) {
    for (let i = 0; i < moteCount; i++) {
      const s = moteSeeds[i];
      motePositions[i * 3] = s.x + Math.sin(time * s.speed + s.phase) * s.amp;
      motePositions[i * 3 + 1] = s.y + Math.sin(time * s.speed * 1.7 + s.phase * 1.3) * 0.18;
      motePositions[i * 3 + 2] = s.z + Math.cos(time * s.speed * 0.8 + s.phase) * s.amp;
    }
    moteGeo.attributes.position.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ */
  /*  Main loop                                                         */
  /* ------------------------------------------------------------------ */

  const debugMode = new URLSearchParams(window.location.search).has('debug');
  const clock = new THREE.Clock();
  let elapsed = 0;

  if (debugMode) {
    window.__hexDebug = {
      state,
      keys,
      camera,
      cameraRig,
      cameraFocus,
      oceanUniforms,
      renderer,
      counts: { tiles: tiles.length, oceanColumns: oceanCols.length, landTiles: landTiles.length },
      advance(seconds) {
        const step = 1 / 60;
        const steps = Math.min(600, Math.max(1, Math.ceil(seconds / step)));
        for (let i = 0; i < steps; i++) {
          elapsed += step;
          state.elapsed = elapsed;
          updateBoat(step, elapsed);
          recordTrail(step);
          updateOcean(step, elapsed);
          updateWakeRibbon();
          emitWakeParticles(step);
          updateParticles(step);
          updateCollectibles(step, elapsed);
          updateMotes(elapsed);
          updateStatus(step);
          updateCamera(step);
        }
        renderer.render(scene, camera);
      },
    };
  }

  function animate() {
    const dt = Math.min(clock.getDelta(), 0.045);
    elapsed += dt;
    state.elapsed = elapsed;

    updateBoat(dt, elapsed);
    recordTrail(dt);
    updateOcean(dt, elapsed);
    updateWakeRibbon();
    emitWakeParticles(dt);
    updateParticles(dt);
    updateCollectibles(dt, elapsed);
    updateMotes(elapsed);
    updateStatus(dt);
    updateCamera(dt);

    if (lighthouseBeam) {
      lighthouseBeam.rotation.y += dt * 0.18;
      lighthouseBeam.material.opacity = 0.045 + Math.sin(elapsed * 0.7) * 0.012;
    }
    if (lighthouseGroup.children.length) {
      const sprite = lighthouseGroup.children.find((child) => child.isSprite);
      if (sprite) sprite.material.opacity = 0.72 + Math.sin(elapsed * 1.7) * 0.1;
    }

    renderer.render(scene, camera);
  }

  renderer.setAnimationLoop(animate);

  // Initialize HUD and toasts once the scene is ready.
  updateScoreUI();

  // A tiny hint on first load, before the start screen is dismissed.
  window.setTimeout(() => {
    if (!state.started) {
      const coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      showToast(coarsePointer ? 'Коснитесь штурвала · курс к искрам' : 'WASD · вперёд, к искрам', 3000);
    }
  }, 2200);
})();
