# 🗺️ Карта репозитория: map_painter_for_my_game

> Пометки для навигации по проекту. Обновлено: 2026-10-26.

## Что это за проект
Изометрическая гексовая морская игра-прототип «Гексовый прилив» (Tidal Hex):
парусник плавает по гексовому морю Карибского бассейна, собирает 8 «искр».
Стек: HTML + CSS + JS + Three.js (без сборки, без npm — просто открыть `index.html`).
Git: 1 коммит (`848e858 adding game prototype files`).

## Корневые файлы
| Файл | Что там | Когда искать |
|---|---|---|
| `README.md` | Краткое описание проекта (рус.) | Общий контекст |
| `LICENSE` | MIT | — |
| `game_prototype/readme.md` | Описание прототипа + список изменений после DeepSeek Harness (волны, ветер, новые острова) | История изменений дизайна |

## game_prototype/ — ядро проекта
| Файл | Строк | Назначение | Строки-якоря |
|---|---|---|---|
| `game.js` | 2841 | **Главный и единственный игровой код** (IIFE) | см. разбор ниже |
| `game_backup_original_DSHarness_file.js` | 2712 | Старая версия до правок (другой ракурс камеры `(0.6,1,0.4)`, 3 маленьких оригинальных острова вместо Карибов, нет индикатора ветра) | Сравнение diff'ом: `diff game.js game_backup_...js` |
| `index.html` | 183 | Разметка: canvas `#world`, HUD, стартовый/финальный экраны, индикатор ветра (`#windIndicator`, `#windArrow`, `#windStrength`), мобильный джойстик `#mobilePad`. Подключает `three.min.js` → `game.js` (стр. 180–181) | UI/HUD правки начинать здесь |
| `style.css` | 1114 | Стили HUD, экранов, ambient-glow, виньетки; CSS-переменные цветов UI | Внешний вид интерфейса |
| `three.min.js` | 7 (minified) | Библиотека Three.js — не редактировать | — |
| `wiki_deepseek.html` | 1437 | Документация от DeepSeek: структура проекта, порядок инициализации, генерация мира (6 шагов), рендеринг/шейдеры, debug-режим | Лучшая «справочная карта» кода |
| `wiki_qwen.html` | 1086 | Документация от Qwen: утилиты, шум, физика лодки, ветер, шейдер океана, палитра, анализ оптимизации | Алгоритмы и производительность |
| `preview.png`, `big-idle.png` | — | Картинки (превью / idle-скриншот) | — |

## Разбор game.js — где что искать (главные якоря)
Все константы/состояния — внутри IIFE, объявленной в начале файла.

### Математика и шум (стр. 8–59)
- `clamp/lerp/smoothstep/expDamp/dampAngle` — стр. 9–20
- `mulberry32(seed)` — стр. 22 (PRNG); `hash2/valueNoise` — стр. 33–50 (процедурный шум рельефа/волн)

### DOM-ссылки (стр. 61–77)
`canvas #world`, `startScreen/startBtn`, `endScreen/againBtn/resetBtn`, `soundBtn`,
`count/#pips` (счёт искр), `toast`, `statusText`, `endTime`, `mobilePad`, элементы ветра.

### Камера и сцена (стр. 101–142)
- Ортографическая камера, `CAMERA_DIR = (1,1,1)` — стр. 115–116 (**изометрия**; в backup было `(0.6,1,0.4)`)
- `cameraRig`, `fitCamera()` — стр. 2497, `updateCamera()` — стр. 2540
- Параметры сетки: `NX=100, NZ=40, HEX_R=0.155, TILE_W/TILE_D, MAP_W/MAP_D` — стр. 132–142
  ⚠️ **Размер карты и геометрию гексов менять сюда.**

### 🏝 Острова — КАРТА МИРА (стр. 144–204)
- Старые 3 острова (Аврора/Тихий/Маяк) закомментированы — стр. 144–148
- Рабочий массив `ISLANDS` — стр. 149+: Карибы (Юкатан, Куба, Гаити, Ямайка, Багамы, Малые Антилы, Южная Америка...).
  Каждое: `{ x, z, r, seed, peak, name }` — центр, радиус, сид шума, высота пика.
  ⚠️ **Главное место для запроса пользователя «состарить/поправить карту»** — правится здесь.

### Палитра и состояние (стр. 205–252)
- `palette` — цвета deep/mid/crest/foam/sand/grass/rock/snow/gold — стр. 205
- `state` — started/score/boat{x,z,heading}/collectibles/trail — стр. 221; старт лодки `(0, 2.5)`

### 💨 Ветер (стр. 254–335)
`wind{angle,strength,season...}`, `getWindAt()`, `updateWind()` (смена направления раз в ~55 c),
`updateWindIndicator()` — стр. 307.

### Ввод (стр. 338–376)
Клавиши WASD + стрелки, мобильный пад (`data-key` кнопки, стр. 2606).

### Генерация мира (стр. 378–1100)
- `makeGlowTexture` — 378; `roundedRectShape/addSlab` — 421/438 (моделирование)
- `tileAtPoint/isLandPoint` — 550/557 (**принадлежность точки суше — по ISLANDS**)
- `columnLocalPositions` — 570; `terrainForColumn` — 603 (высота каждой гекс-колонки)
- `createColumnGeometry` (суша) — 781; `createOceanColumnGeometry` — 837
- Шейдер океана: `oceanMaterial.onBeforeCompile` — стр. 904 (волны/amplitude править тут)
- `nearestColumnHeight` — 1096 (высота под объектами)

### Декор (стр. 1165–1500)
Пальмы `createPalm` — 1192; камни — 1272; хижина `createCottage` — 1285; маяк (`lighthouseGroup/Beam` — в главном цикле).

### Частицы (стр. 1506–1590)
`spawnParticle/updateParticles` — брызги, кильватер.

### Лодка (стр. 1590–1836)
`makeBoatShape` — 1590; `createBoat` — 1600; физика: `updateBoat(dt,time)` — **стр. 2225**
(ветер→паруса, столкновения/пена — 2335, след-ribbon — 2152).

### Collectibles — ИСКРЫ (стр. 1817–1935)
- Старые позиции закомментированы (1817–1826); рабочие `collectibleSpots` — **стр. 1827–1836** (8 точек в проливах Карибов)
- `createCollectible` — 1851; `canSail(x,z)` — 1921 (проверка «не суша»); `collect()` — 2438
- `findWaterSpot` — 1838 (поиск ближайшей воды вокруг точки)

### Звук (стр. 1938–2082)
WebAudio: шум океана, chimе при сборе, финал. Кнопка mute — 2068.

### UI-хелперы (стр. 2084–2120)
`showToast`, `updateScoreUI`, `updateStatus`.

### Главный цикл (стр. ~2760–2825)
`animate()` через `renderer.setAnimationLoop` (стр. ~2827): updateBoat → recordTrail →
updateOcean → wake → particles → collectibles → motes → status → camera → windIndicator → маяк → render.

## Быстрые ответы «где менять»
- **Форма/расположение островов** → `game.js:149` (`ISLANDS`)
- **Размер карты/сетки** → `game.js:132–142` (`NX, NZ, HEX_R...`)
- **Высота рельефа** → `game.js:603` (`terrainForColumn`) + `peak` в ISLANDS
- **Волны океана** → `game.js:904` (шейдер) 
- **Позиции искр** → `game.js:1827` (`collectibleSpots`)
- **Старт лодки** → `game.js:221` (`state.boat`)
- **Камера/изометрия** → `game.js:115–116`
- **HUD/верстка** → `index.html` + `style.css`
- **Документация по коду** → два wiki-файла (deepseek — структура, qwen — алгоритмы)
