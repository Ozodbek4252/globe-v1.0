// The 3D city: builds the Three.js scene from CityData and runs it. Framework-agnostic (no Vue), like
// src/globe. Call createCityScene(host, data) and use the returned API.

import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Fog,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  SpotLight,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Texture,
} from 'three';
import { createEmitter, type Unsubscribe } from '../lib/emitter';
import { buildColliders, findSpawn } from '../sim/colliders';
import { createPlayer, speedOf, stepPlayer, type PlayerState } from '../sim/player';
import { createSurvivor } from './character';
import { createCutaway, type Cutaway } from './cutaway';
import { openestYaw } from './followYaw';
import {
  MAX_DISTANCE,
  MAX_PITCH,
  MIN_DISTANCE,
  MIN_PITCH,
  ease,
  groundAxes,
  keepInside,
  metresPerPixel,
  pan,
  rotate,
  zoom,
  cameraPosition,
  clamp,
  type Rig,
} from './cameraRig';
import {
  buildBuildings,
  buildGround,
  buildRoads,
  buildTowers,
  chunkBuildings,
  type MeshData,
} from './geometry';
import { LAMP_STRIDE, placeLamps, type LampSet } from './lamps';
import { buildOccupancy } from './occupancy';
import { TERRAIN, WATER, srgb } from './palette';
import { createSky } from './sky';
import { localSun, skyPalette, sunDirection } from './sunlight';
import {
  createFacadeTextures,
  createGlowTexture,
  createGroundTexture,
  createPerimeterTexture,
  createRoadTexture,
} from './textures';
import { TREE_STRIDE, placeTrees, type TreeSet } from './trees';
import type { CityData } from './types';

const FOV = 42;
/** Tashkent is UTC+5. The scene's clock is local time on a fixed autumn day, so the sun is repeatable. */
const UTC_OFFSET_HOURS = 5;
const REFERENCE_DAY = Date.UTC(2026, 8, 22);

export interface CityStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  buildings: number;
  trees: number;
}

/** A camera placement. x and y are city metres (east, north); angles are degrees. */
export interface CityViewpoint {
  x?: number;
  y?: number;
  yaw?: number;
  pitch?: number;
  distance?: number;
}

/** The camera either follows the survivor or flies free over the city. */
export type CameraMode = 'follow' | 'free';

/** What the HUD shows about the survivor. Fires about ten times a second. */
export interface PlayerStatus {
  x: number;
  y: number;
  /** Metres per second. */
  speed: number;
  /** 0 to 1. */
  stamina: number;
  exhausted: boolean;
  sprinting: boolean;
  flashlight: boolean;
  camera: CameraMode;
}

export interface CityOptions {
  /** Local hour (0-24) to start at. Default is golden hour. */
  hour?: number;
  /** Start from this viewpoint instead of the default one, with no fly-in. Implies the free camera. */
  view?: CityViewpoint;
  /** Which camera to start with. Default: follow the survivor (free when `view` is given). */
  camera?: CameraMode;
  /** Put the survivor near this point (city metres) instead of beside the TV tower. */
  player?: { x: number; y: number };
  /** Skip the fly-in and the camera easing. Defaults to the user's reduced-motion setting. */
  reducedMotion?: boolean;
  onProgress?: (fraction: number, label: string) => void;
}

export interface CityScene {
  /** Set the local time of day, 0 to 24. */
  setHour(hour: number): void;
  getHour(): number;
  /** The sun's height above the horizon in degrees, for display. */
  sunElevation(): number;
  /** Look at a point in city metres (x east, y north). Switches to the free camera. */
  focus(x: number, y: number, distance?: number): void;
  /** Bring the camera back to the survivor, or to the starting view in the free camera. */
  resetView(): void;
  cameraMode(): CameraMode;
  setCameraMode(mode: CameraMode): void;
  toggleFlashlight(): void;
  /** Fires about twice a second. */
  onStats(listener: (stats: CityStats) => void): Unsubscribe;
  /** Fires about ten times a second with the survivor's condition. */
  onPlayer(listener: (status: PlayerStatus) => void): Unsubscribe;
  destroy(): void;
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number): number => {
  let d = ((((b - a) % 360) + 540) % 360) - 180;
  d = Math.max(-180, Math.min(180, d));
  return a + d * t;
};

function toGeometry(data: MeshData): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new BufferAttribute(data.normals, 3));
  g.setAttribute('uv', new BufferAttribute(data.uvs, 2));
  g.setAttribute('color', new BufferAttribute(data.colors, 3));
  g.setIndex(new BufferAttribute(data.indices, 1));
  g.computeBoundingSphere();
  return g;
}

/** Build the scene and start rendering. Resolves once the first frame is on screen. */
export async function createCityScene(
  host: HTMLElement,
  data: CityData,
  options: CityOptions = {},
): Promise<CityScene> {
  const progress = options.onProgress ?? ((): void => {});
  const reducedMotion =
    options.reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches;
  const half = data.halfSize;

  // ---------- renderer ----------
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch {
    throw new Error('Your browser could not start WebGL, which the 3D city needs.');
  }
  // Phones and low-core machines get a cheaper picture: fewer pixels and a smaller shadow map.
  const modest =
    Math.min(host.clientWidth, host.clientHeight) < 700 ||
    (navigator.hardwareConcurrency || 8) <= 4;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, modest ? 1.5 : 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  const canvas = renderer.domElement;
  Object.assign(canvas.style, {
    display: 'block',
    width: '100%',
    height: '100%',
    outline: 'none',
    touchAction: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  host.append(canvas);

  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(thing: T): T => {
    disposables.push(thing);
    return thing;
  };

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 4, 6500);
  const fog = new Fog(0x000000, 450, 3400);
  scene.fog = fog;
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  // ---------- textures ----------
  progress(0.02, 'Painting facades');
  const facade = createFacadeTextures(anisotropy);
  const roadTexture = createRoadTexture(anisotropy);
  const groundTexture = createGroundTexture(anisotropy);
  // the same grain, at two scales: huge terrain tiles every ~46 m, park and plaza polygons every 40 m
  const landTexture = groundTexture.clone();
  groundTexture.repeat.set(300, 300);
  const perimeterTexture = createPerimeterTexture();
  const glowTexture = createGlowTexture();
  for (const t of [
    facade.map,
    facade.emissive,
    roadTexture,
    groundTexture,
    landTexture,
    perimeterTexture,
    glowTexture,
  ] as Texture[])
    own(t);
  await nextFrame();

  // ---------- sky and lights ----------
  const sky = own(createSky());
  scene.add(sky.mesh);

  const hemi = new HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(hemi);
  const sun = new DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  const SHADOW_SIZE = modest ? 2048 : 4096;
  sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 1800;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  sun.shadow.radius = 2.5;
  scene.add(sun, sun.target);
  // a soft light from the side away from the sun, so shaded walls keep their form
  const fill = new DirectionalLight(0xffffff, 0.5);
  scene.add(fill);

  // ---------- materials ----------
  const wallMaterial = own(
    new MeshStandardMaterial({
      map: facade.map,
      emissiveMap: facade.emissive,
      emissive: new Color(1, 0.86, 0.62),
      emissiveIntensity: 0,
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.02,
    }),
  );
  const roofMaterial = own(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
  );
  // buildings and trees that stand between the camera and the survivor dissolve (see cutaway.ts)
  const cutaway = createCutaway();
  cutaway.apply(wallMaterial);
  cutaway.apply(roofMaterial);
  const towerMaterial = own(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05 }),
  );
  const offset = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
  const majorRoadMaterial = own(
    new MeshStandardMaterial({ map: roadTexture, vertexColors: true, roughness: 0.92, ...offset }),
  );
  const minorRoadMaterial = own(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, ...offset }),
  );
  const pathMaterial = own(
    new MeshStandardMaterial({ vertexColors: true, roughness: 1, ...offset }),
  );
  const landMaterial = own(
    new MeshStandardMaterial({
      map: landTexture,
      vertexColors: true,
      roughness: 1,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  const waterMaterial = own(
    new MeshStandardMaterial({
      color: new Color().setRGB(...WATER),
      roughness: 0.08,
      metalness: 0.15,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }),
  );

  // ---------- ground ----------
  const terrain = new Mesh(
    own(new PlaneGeometry(14000, 14000)),
    own(
      new MeshStandardMaterial({
        color: new Color().setRGB(...TERRAIN),
        map: groundTexture,
        roughness: 1,
      }),
    ),
  );
  terrain.rotation.x = -Math.PI / 2;
  terrain.receiveShadow = true;
  scene.add(terrain);

  // the quarantine perimeter: a faint glowing wall around the play area
  const perimeterMaterial = own(
    new MeshBasicMaterial({
      map: perimeterTexture,
      color: 0xff5a30,
      transparent: true,
      opacity: 0.5,
      side: DoubleSide,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    }),
  );
  const wallGeometry = own(new PlaneGeometry(half * 2, 26));
  const sides: [number, number, number][] = [
    [0, -half, 0],
    [0, half, 0],
    [-half, 0, Math.PI / 2],
    [half, 0, Math.PI / 2],
  ];
  for (const [x, z, ry] of sides) {
    const wall = new Mesh(wallGeometry, perimeterMaterial);
    wall.position.set(x, 13, z);
    wall.rotation.y = ry;
    wall.renderOrder = 5;
    scene.add(wall);
  }

  // ---------- the city ----------
  progress(0.08, 'Raising buildings');
  const tiles = chunkBuildings(data.buildings, 250);
  for (let i = 0; i < tiles.length; i++) {
    const { walls, roofs } = buildBuildings(tiles[i]);
    const wallMesh = new Mesh(own(toGeometry(walls)), wallMaterial);
    const roofMesh = new Mesh(own(toGeometry(roofs)), roofMaterial);
    for (const m of [wallMesh, roofMesh]) {
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
    }
    if (i % 4 === 3) {
      progress(0.08 + 0.5 * ((i + 1) / tiles.length), 'Raising buildings');
      await nextFrame();
    }
  }

  progress(0.6, 'Laying roads');
  const roads = buildRoads(data.roads);
  for (const [mesh, material, z] of [
    [roads.paths, pathMaterial, 1],
    [roads.minor, minorRoadMaterial, 2],
    [roads.major, majorRoadMaterial, 3],
  ] as const) {
    const m = new Mesh(own(toGeometry(mesh)), material);
    m.receiveShadow = true;
    m.renderOrder = z;
    scene.add(m);
  }
  const ground = buildGround(data.areas, data.waterways);
  const land = new Mesh(own(toGeometry(ground.land)), landMaterial);
  land.receiveShadow = true;
  scene.add(land);
  const water = new Mesh(own(toGeometry(ground.water)), waterMaterial);
  water.receiveShadow = true;
  scene.add(water);
  await nextFrame();

  progress(0.72, 'Planting trees');
  const occupancy = buildOccupancy(data, 2);
  const lampSet = placeLamps(data, occupancy); // lamps first, so trees keep clear of them
  const lamps = buildLampMeshes(lampSet, glowTexture, own);
  scene.add(lamps.group);
  const treeSet = placeTrees(data, occupancy);
  scene.add(buildTreeMeshes(treeSet, own, cutaway));
  await nextFrame();

  // ---------- the survivor ----------
  progress(0.8, 'Finding a place to stand');
  const colliders = buildColliders(data, [
    { data: treeSet.data, stride: TREE_STRIDE, count: treeSet.count, radius: 0.35 },
    { data: lampSet.data, stride: LAMP_STRIDE, count: lampSet.count, radius: 0.15 },
  ]);
  const landmark = data.towers.find((t) => t.height >= 100);
  const startNear: [number, number] = options.player
    ? [options.player.x, options.player.y]
    : landmark
      ? [landmark.x, landmark.y]
      : [0, 0];
  const [spawnX, spawnY] = findSpawn(colliders, startNear, 200, options.player ? 1.5 : 5);
  let player: PlayerState = createPlayer(spawnX, spawnY, Math.PI / 2);
  let previous: PlayerState = player;
  const survivor = createSurvivor();
  scene.add(survivor.object);
  survivor.place(player.x, player.y, player.heading, 0, 0, false);
  // a flashlight for the dark
  const flashlight = new SpotLight(0xfff1d6, 0, 70, 0.52, 0.65, 1.4);
  flashlight.castShadow = false;
  scene.add(flashlight, flashlight.target);
  let flashlightPref: 'auto' | 'on' | 'off' = 'auto';
  await nextFrame();

  progress(0.85, 'Landmarks');
  if (data.towers.length > 0) {
    const towers = new Mesh(own(toGeometry(buildTowers(data.towers))), towerMaterial);
    towers.castShadow = true;
    towers.receiveShadow = true;
    scene.add(towers);
  }
  // aviation beacons on the tall towers
  const beaconMaterial = own(new MeshBasicMaterial({ color: 0xff2a1a, fog: false }));
  const beaconGeometry = own(new SphereGeometry(1.5, 12, 8));
  const beacons: Mesh[] = [];
  for (const tower of data.towers) {
    if (tower.height < 100) continue;
    const beacon = new Mesh(beaconGeometry, beaconMaterial);
    beacon.position.set(tower.x, tower.height + 1.2, -tower.y);
    scene.add(beacon);
    beacons.push(beacon);
  }

  // ---------- camera rig ----------
  const tower = data.towers.find((t) => t.height >= 100);
  const home: Rig = {
    x: tower ? tower.x : 0,
    z: tower ? -tower.y + 40 : 0,
    yaw: 0.55,
    pitch: (46 * Math.PI) / 180,
    distance: 330,
  };
  const preset = options.view;
  if (preset) {
    if (preset.x !== undefined) home.x = preset.x;
    if (preset.y !== undefined) home.z = -preset.y;
    if (preset.yaw !== undefined) home.yaw = (preset.yaw * Math.PI) / 180;
    if (preset.pitch !== undefined)
      home.pitch = clamp((preset.pitch * Math.PI) / 180, MIN_PITCH, MAX_PITCH);
    if (preset.distance !== undefined)
      home.distance = clamp(preset.distance, MIN_DISTANCE, MAX_DISTANCE);
  }
  // The follow camera sits behind and above the survivor, much closer than the overview.
  const followView = { yaw: 0.35, pitch: (55 * Math.PI) / 180, distance: 28 };
  // a deep link may set the angle and distance for the follow camera too
  if (preset?.yaw !== undefined) followView.yaw = (preset.yaw * Math.PI) / 180;
  if (preset?.pitch !== undefined)
    followView.pitch = clamp((preset.pitch * Math.PI) / 180, MIN_PITCH, MAX_PITCH);
  if (preset?.distance !== undefined)
    followView.distance = clamp(preset.distance, MIN_DISTANCE, MAX_DISTANCE);
  const FOLLOW_MAX_DISTANCE = 220;
  let cameraMode: CameraMode = options.camera ?? (preset ? 'free' : 'follow');
  const followRig = (): Rig => ({ x: player.x, z: -player.y, ...followView });
  /** The follow camera on the side of the survivor with the clearest view (unless a link chose one). */
  const recentred = (): Rig => {
    const rig = followRig();
    if (preset?.yaw !== undefined) return rig;
    const flat = rig.distance * Math.cos(rig.pitch);
    return { ...rig, yaw: openestYaw(colliders, player.x, player.y, flat, rig.yaw) };
  };
  followView.yaw = recentred().yaw;

  const skipIntro = reducedMotion || preset !== undefined;
  let goal: Rig = cameraMode === 'follow' ? followRig() : { ...home };
  let current: Rig = skipIntro
    ? { ...goal }
    : {
        x: goal.x,
        z: goal.z + 120,
        yaw: goal.yaw - 1.1,
        pitch: (62 * Math.PI) / 180,
        distance: 1000,
      };
  let easeRate = skipIntro ? 30 : 1.7; // slow for the fly-in, then snappy
  let introUntil = skipIntro ? 0 : performance.now() + 3800;

  function setCameraMode(next: CameraMode): void {
    if (next === cameraMode) return;
    cameraMode = next;
    introUntil = 0;
    if (next === 'follow') {
      goal = {
        ...followRig(),
        yaw: goal.yaw,
        pitch: goal.pitch,
        distance: Math.min(goal.distance, FOLLOW_MAX_DISTANCE, 40),
      };
    } else {
      goal = { ...current }; // stay where the camera is; from here WASD pans it
    }
  }

  // ---------- time of day ----------
  let hour = options.hour ?? 17.4;
  let elevation = 0;
  let darkness = 0; // 0 in daylight, 1 at night: drives the flashlight and the glow
  const lightDirection = new Vector3();
  const skyDirection = new Vector3();

  function applyTime(): void {
    const date = REFERENCE_DAY + (hour - UTC_OFFSET_HOURS) * 3_600_000;
    const angles = localSun(date, data.center[0], data.center[1]);
    elevation = angles.elevation;
    const palette = skyPalette(angles.elevation);
    // The light is the sun by day and shifts to a high "moon" at night, so shadows stay sensible.
    const night = smoothstep(8, -4, angles.elevation);
    const lightAngles = {
      elevation: lerp(Math.max(angles.elevation, 3), 44, night),
      azimuth: lerpAngle(angles.azimuth, 235, night),
    };
    lightDirection.set(...sunDirection(lightAngles));
    skyDirection.set(...sunDirection(angles));
    sun.color.setRGB(...palette.light);
    sun.intensity = palette.lightIntensity;
    hemi.color.setRGB(...palette.hemiSky);
    hemi.groundColor.setRGB(...palette.hemiGround);
    hemi.intensity = palette.hemiIntensity;
    fill.color.setRGB(...palette.hemiSky);
    fill.intensity = palette.fillIntensity;
    fill.position.set(-lightDirection.x, 0.5, -lightDirection.z).normalize().multiplyScalar(100);
    lamps.setGlow(palette.windowGlow);
    darkness = palette.windowGlow;
    renderer.toneMappingExposure = palette.exposure;
    wallMaterial.emissiveIntensity = palette.windowGlow * 1.1;
    sky.update(palette, skyDirection, camera, fog);
  }
  applyTime();

  // ---------- size ----------
  const resizeObserver = new ResizeObserver(() => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  resizeObserver.observe(host);

  // ---------- input ----------
  const keys = new Set<string>();
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'v') setCameraMode(cameraMode === 'follow' ? 'free' : 'follow');
    else if (k === 'l') flashlightPref = flashlightOn() ? 'off' : 'on';
    else if (k === 't' && tower) {
      setCameraMode('free');
      goal = { ...goal, x: tower.x, z: -tower.y + 40 };
    } else if (k === 'h' || k === 'home')
      goal = cameraMode === 'follow' ? recentred() : { ...home };
    else if (k === '+' || k === '=') goal = zoom(goal, 0.8);
    else if (k === '-' || k === '_') goal = zoom(goal, 1.25);
    else keys.add(k);
    if (k.startsWith('arrow') || k === ' ') e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.key.toLowerCase());
  };
  const onBlur = (): void => keys.clear();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const pointers = new Map<number, { x: number; y: number }>();
  const dragBy = (dx: number, dy: number, orbit: boolean): void => {
    // following the survivor, there is nothing to pan, so any drag turns the camera
    if (orbit || cameraMode === 'follow') {
      goal = rotate(goal, -dx * 0.005, dy * 0.004);
    } else {
      const mpp = metresPerPixel(goal, FOV, canvas.clientHeight);
      goal = keepInside(pan(goal, (dy * mpp) / Math.sin(goal.pitch), -dx * mpp), half);
    }
    easeRate = Math.max(easeRate, 14);
  };
  const onPointerDown = (e: PointerEvent): void => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    introUntil = 0;
  };
  const onPointerMove = (e: PointerEvent): void => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (pointers.size === 1) {
      dragBy(dx, dy, (e.buttons & 2) !== 0 || ((e.buttons & 1) !== 0 && e.altKey));
    } else if (pointers.size === 2) {
      // pinch to zoom, twist to rotate, and the midpoint drags the map
      const [a, b] = [...pointers.entries()];
      const other = a[0] === e.pointerId ? b[1] : a[1];
      const before = Math.hypot(last.x - other.x, last.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (before > 10 && after > 10) goal = zoom(goal, before / after);
      const angBefore = Math.atan2(last.y - other.y, last.x - other.x);
      const angAfter = Math.atan2(e.clientY - other.y, e.clientX - other.x);
      goal = rotate(goal, -(angAfter - angBefore), 0);
      dragBy(dx / 2, dy / 2, false);
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onPointerEnd = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    goal = zoom(goal, Math.exp(e.deltaY * lines * 0.0011));
    introUntil = 0;
  };
  const onContextMenu = (e: Event): void => e.preventDefault();
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);

  // ---------- frame loop ----------
  const stats = createEmitter<CityStats>();
  const playerEvents = createEmitter<PlayerStatus>();
  const SIM_STEP = 1 / 60;
  let simClock = 0;
  let playerAt = 0;
  const cutPlayer = new Vector3();
  function flashlightOn(): boolean {
    return flashlightPref === 'on' || (flashlightPref === 'auto' && darkness > 0.35);
  }
  let frames = 0;
  let statsAt = performance.now();
  let last = performance.now();
  let frameId = 0;
  let destroyed = false;
  let shadowRadius = 0;
  const SHADOW_STEP = 1.08;

  function frame(now: number): void {
    if (destroyed) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    // keyboard: W A S D (or the arrows) walk the survivor when following, and pan the camera when free
    const forward =
      Number(keys.has('w') || keys.has('arrowup')) - Number(keys.has('s') || keys.has('arrowdown'));
    const sideways =
      Number(keys.has('d') || keys.has('arrowright')) -
      Number(keys.has('a') || keys.has('arrowleft'));
    if (cameraMode === 'free' && (forward || sideways)) {
      const speed = goal.distance * 0.9 * (keys.has('shift') ? 2.6 : 1);
      goal = keepInside(pan(goal, forward * speed * dt, sideways * speed * dt), half);
      easeRate = Math.max(easeRate, 9);
      introUntil = 0;
    }
    const turn = Number(keys.has('e')) - Number(keys.has('q'));
    const tilt = Number(keys.has('r')) - Number(keys.has('f'));
    if (turn || tilt) goal = rotate(goal, turn * 1.5 * dt, tilt * 0.9 * dt);

    // the survivor runs on a fixed 60 Hz clock, so movement is identical at any frame rate. "Forward"
    // is up the screen: the direction the camera looks, flattened onto the ground.
    const axes = groundAxes(current.yaw);
    const walking = cameraMode === 'follow';
    const input = {
      moveX: walking ? forward * axes.forward[0] + sideways * axes.right[0] : 0,
      moveY: walking ? -(forward * axes.forward[1] + sideways * axes.right[1]) : 0,
      sprint: keys.has('shift'),
    };
    simClock += dt;
    let steps = 0;
    while (simClock >= SIM_STEP && steps < 6) {
      previous = player;
      player = stepPlayer(player, input, colliders, SIM_STEP);
      simClock -= SIM_STEP;
      steps++;
    }
    if (steps === 6) simClock = 0; // far behind (a stalled tab): do not try to catch up
    const alpha = simClock / SIM_STEP;
    const px = lerp(previous.x, player.x, alpha);
    const py = lerp(previous.y, player.y, alpha);
    survivor.place(
      px,
      py,
      player.heading,
      lerp(previous.travelled, player.travelled, alpha),
      speedOf(player),
      player.sprinting,
    );

    if (cameraMode === 'follow') {
      // the camera leads a little in the direction of travel
      goal = {
        ...goal,
        x: px + clamp(player.vx * 0.3, -2.5, 2.5),
        z: -(py + clamp(player.vy * 0.3, -2.5, 2.5)),
        distance: Math.min(goal.distance, FOLLOW_MAX_DISTANCE),
      };
    }

    if (now > introUntil && easeRate < 7) easeRate = Math.min(7, easeRate + dt * 6);
    else if (now > introUntil && easeRate > 7) easeRate = Math.max(7, easeRate - dt * 20);
    current = ease(current, goal, dt, easeRate);

    // camera
    const [cx, cy, cz] = cameraPosition(current);
    camera.position.set(cx, cy, cz);
    camera.lookAt(current.x, 0, current.z);

    // see-through hole for whatever stands between the camera and the survivor
    cutPlayer.set(px, 1.1, -py);
    cutaway.update(cutPlayer, camera.position, walking ? 2.4 + current.distance * 0.06 : 0);
    survivor.setRingScale(clamp(current.distance / 36, 1, 5));

    // flashlight: on by itself when it gets dark, and L overrides
    const lit = flashlightOn();
    flashlight.intensity = lit ? 700 * (0.35 + 0.65 * darkness) : 0;
    flashlight.position.set(
      px + Math.cos(player.heading) * 0.3,
      1.5,
      -(py + Math.sin(player.heading) * 0.3),
    );
    flashlight.target.position.set(
      px + Math.cos(player.heading) * 16,
      0,
      -(py + Math.sin(player.heading) * 16),
    );

    if (now - playerAt >= 100) {
      playerAt = now;
      playerEvents.emit({
        x: player.x,
        y: player.y,
        speed: speedOf(player),
        stamina: player.stamina,
        exhausted: player.exhausted,
        sprinting: player.sprinting,
        flashlight: lit,
        camera: cameraMode,
      });
    }

    // shadows follow the view: a box around the target, sized by how far out the camera is
    const radius = clamp(current.distance * 1.25, 150, 720);
    if (radius > shadowRadius * SHADOW_STEP || radius < shadowRadius / SHADOW_STEP) {
      shadowRadius = radius;
      const c = sun.shadow.camera;
      c.left = -radius;
      c.right = radius;
      c.top = radius;
      c.bottom = -radius;
      c.updateProjectionMatrix();
    }
    const texel = (shadowRadius * 2) / SHADOW_SIZE;
    const tx = Math.round(current.x / texel) * texel;
    const tz = Math.round(current.z / texel) * texel;
    sun.target.position.set(tx, 0, tz);
    sun.position.set(
      tx + lightDirection.x * 800,
      lightDirection.y * 800,
      tz + lightDirection.z * 800,
    );

    sky.update(skyPalette(elevation), skyDirection, camera, fog);

    // blink the beacons
    const on = Math.sin(now / 420) > 0.2;
    for (const b of beacons) b.visible = on;

    renderer.render(scene, camera);

    frames++;
    if (now - statsAt >= 500) {
      stats.emit({
        fps: (frames * 1000) / (now - statsAt),
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        buildings: data.buildings.length,
        trees: treeSet.count,
      });
      frames = 0;
      statsAt = now;
    }
    frameId = requestAnimationFrame(frame);
  }

  progress(0.95, 'Lighting');
  // size once before the first frame, then let the observer keep it right
  renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false);
  camera.aspect = Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight);
  camera.updateProjectionMatrix();
  frameId = requestAnimationFrame(frame);
  await nextFrame();
  progress(1, 'Ready');

  return {
    setHour(h) {
      hour = ((h % 24) + 24) % 24;
      applyTime();
    },
    getHour: () => hour,
    sunElevation: () => elevation,
    focus(x, y, distance) {
      setCameraMode('free');
      goal = { ...goal, x, z: -y, distance: distance ?? goal.distance };
      introUntil = 0;
    },
    resetView() {
      goal = cameraMode === 'follow' ? recentred() : { ...home };
      introUntil = 0;
    },
    cameraMode: () => cameraMode,
    setCameraMode,
    toggleFlashlight() {
      flashlightPref = flashlightOn() ? 'off' : 'on';
    },
    onStats: stats.on,
    onPlayer: playerEvents.on,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerEnd);
      canvas.removeEventListener('pointercancel', onPointerEnd);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      stats.clear();
      playerEvents.clear();
      survivor.dispose();
      sun.shadow.map?.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

// ---------- street lamps ----------

const LAMP_WARM = new Color(1, 0.74, 0.42);

/**
 * Poles, lamp heads and a soft pool of light on the road under each, as three instanced meshes. At
 * night the heads glow and the pools fade in; by day they are just dark poles.
 */
function buildLampMeshes(
  set: LampSet,
  glowTexture: Texture,
  own: <T extends { dispose(): void }>(thing: T) => T,
): { group: Object3D; setGlow(amount: number): void } {
  const group = new Object3D();
  if (set.count === 0) return { group, setGlow: () => {} };

  const poleGeometry = own(new CylinderGeometry(0.06, 0.1, 1, 5));
  poleGeometry.translate(0, 0.5, 0);
  const headGeometry = own(new SphereGeometry(0.34, 8, 6));
  const poolGeometry = own(new PlaneGeometry(1, 1));
  poolGeometry.rotateX(-Math.PI / 2);

  const poleMaterial = own(
    new MeshStandardMaterial({ color: 0x3d4247, roughness: 0.6, metalness: 0.4 }),
  );
  const headMaterial = own(
    new MeshStandardMaterial({
      color: 0x9a9a9a,
      emissive: LAMP_WARM,
      emissiveIntensity: 0,
      roughness: 0.4,
    }),
  );
  const poolMaterial = own(
    new MeshBasicMaterial({
      map: glowTexture,
      color: LAMP_WARM,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }),
  );

  const poles = new InstancedMesh(poleGeometry, poleMaterial, set.count);
  const heads = new InstancedMesh(headGeometry, headMaterial, set.count);
  const pools = new InstancedMesh(poolGeometry, poolMaterial, set.count);
  const dummy = new Object3D();
  for (let i = 0; i < set.count; i++) {
    const x = set.data[i * LAMP_STRIDE];
    const y = set.data[i * LAMP_STRIDE + 1];
    const h = set.data[i * LAMP_STRIDE + 2];
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(x, 0, -y);
    dummy.scale.set(1, h, 1);
    dummy.updateMatrix();
    poles.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x, h, -y);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    heads.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x, 0.18, -y);
    dummy.scale.set(17, 1, 17);
    dummy.updateMatrix();
    pools.setMatrixAt(i, dummy.matrix);
  }
  for (const m of [poles, heads, pools]) {
    m.frustumCulled = false;
    m.instanceMatrix.needsUpdate = true;
    group.add(m);
  }
  poles.castShadow = true;
  pools.renderOrder = 4;

  return {
    group,
    setGlow(amount) {
      headMaterial.emissiveIntensity = amount * 5;
      poolMaterial.opacity = amount * 0.9;
      pools.visible = amount > 0.02;
    },
  };
}

// ---------- trees ----------

const TRUNK = srgb(0x5a4632);
const GREENS = [srgb(0x4d7a38), srgb(0x5d8a3e), srgb(0x6b8f3a), srgb(0x3f6b34)];
const AUTUMN = [srgb(0xc9a23a), srgb(0xb8742e), srgb(0xa8b347)];

/** Two instanced meshes (trunks and crowns): thousands of trees in two draw calls. */
function buildTreeMeshes(
  set: TreeSet,
  own: <T extends { dispose(): void }>(thing: T) => T,
  cutaway: Cutaway,
): Object3D {
  const group = new Object3D();
  if (set.count === 0) return group;

  const trunkGeometry = own(new CylinderGeometry(0.16, 0.27, 1, 5));
  trunkGeometry.translate(0, 0.5, 0);
  const crownGeometry = own(new IcosahedronGeometry(1, 1));
  const trunkMaterial = own(
    new MeshStandardMaterial({ color: new Color().setRGB(...TRUNK), roughness: 1 }),
  );
  const crownMaterial = own(new MeshStandardMaterial({ roughness: 0.95, flatShading: true }));
  cutaway.apply(trunkMaterial);
  cutaway.apply(crownMaterial);
  const trunks = new InstancedMesh(trunkGeometry, trunkMaterial, set.count);
  const crowns = new InstancedMesh(crownGeometry, crownMaterial, set.count);
  const dummy = new Object3D();
  const colour = new Color();

  for (let i = 0; i < set.count; i++) {
    const o = i * TREE_STRIDE;
    const x = set.data[o];
    const y = set.data[o + 1];
    const height = set.data[o + 2];
    const crown = set.data[o + 3];
    const tint = set.data[o + 4];
    const tall = set.data[o + 5] === 1;

    const trunkHeight = height * (tall ? 0.2 : 0.42);
    dummy.position.set(x, 0, -y);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, trunkHeight, 1);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);

    const crownHeight = height - trunkHeight * 0.8;
    dummy.position.set(x, trunkHeight * 0.8 + crownHeight / 2, -y);
    dummy.rotation.set(0, tint * 6.28, 0);
    dummy.scale.set(tall ? crown * 0.7 : crown, crownHeight / 2, tall ? crown * 0.7 : crown);
    dummy.updateMatrix();
    crowns.setMatrixAt(i, dummy.matrix);

    const palette = tint > 0.88 ? AUTUMN : GREENS;
    const base = palette[Math.floor(((tint * 997) % 1) * palette.length)];
    const shade = 0.82 + ((tint * 313) % 1) * 0.36;
    crowns.setColorAt(i, colour.setRGB(base[0] * shade, base[1] * shade, base[2] * shade));
  }
  for (const m of [trunks, crowns]) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.instanceMatrix.needsUpdate = true;
    group.add(m);
  }
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  return group;
}
