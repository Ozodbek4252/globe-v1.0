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
  Group,
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
import { utcOffsetHours } from '../lib/sun';
import { buildColliders, findSpawn, type Colliders } from '../sim/colliders';
import { DAY, nightness, OUTDOOR_PEAK, outdoorShare, wrapHour } from '../sim/daylight';
import {
  countPopulation,
  createGame,
  createGameWorld,
  drainEvents,
  GAME,
  interactionAt,
  respawn,
  stepGame,
  validSpot,
  weaponConfig,
  type GameEvent,
  type GameInput,
  type GameOptions,
  type GameWorld,
  type Population,
  type GameState,
  type GameStatus,
  type WeaponName,
} from '../sim/game';
import { sendHunting, spawnZombie, ZKind, ZState } from '../sim/horde';
import { HState, spawnHuman } from '../sim/humans';
import { speedOf, type PlayerState } from '../sim/player';
import { isSavedGame, loadGame, saveGame, type SavedGame } from '../sim/save';
import { CAR, createCar, KIND, kindOf, onRoad, wrecked, type Car } from '../sim/vehicle';
import {
  advanceLedger,
  enterWindow,
  ledgerOutside,
  migrateGame,
  readLedger,
  type Ledger,
  type LedgerEntry,
} from '../sim/window';
import { sceneryTiles, tileAt, tileBounds, tileKey, type TileIndex } from './tiles';
import type { PlaceKind } from '../sim/places';
import { compassName, screenAngle, screenOffset } from './bearings';
import { createCarRenderer } from './cars';
import { createRain } from './rain';
import { createShamblers, createWalkers, LIFE, parkInTile, type Door } from './sceneryLife';
import { createSoundScape, type Groaner } from './sound';
import { weatherFog, weatherPalette } from './weatherLook';
import { senses, type Weather, type WeatherKind } from '../sim/weather';
import { nextWeapon, NO_TOUCH, type TouchAction, type TouchInput } from './touch';
import { createSurvivor } from './character';
import { createCutaway, type Cutaway } from './cutaway';
import { createEffects, type AimMode } from './effects';
import { openestYaw } from './followYaw';
import { createPeopleRenderer } from './people';
import { createPickupMarkers, type PickupMarkers } from './pickups';
import { createPlaceMarkers } from './placeMarkers';
import { createZombieRenderer } from './zombies';
import {
  MAX_DISTANCE,
  MAX_PITCH,
  MIN_DISTANCE,
  MIN_PITCH,
  ease,
  groundAxes,
  keepInBox,
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
import { localSun, skyPalette, sunDirection, sunTimes } from './sunlight';
import {
  createFacadeTextures,
  createGlowTexture,
  createGroundTexture,
  createPerimeterTexture,
  createRoadTexture,
} from './textures';
import { TREE_STRIDE, placeTrees, type TreeSet } from './trees';
import type { CityData, CityTower } from './types';

const FOV = 42;
/** The scene's clock is local time on a fixed autumn day, so the sun is repeatable. */
const REFERENCE_DAY = Date.UTC(2026, 8, 22);

export interface CityStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  buildings: number;
  trees: number;
  /** Zombies standing right now, and how many bodies were drawn this frame. */
  zombies: number;
  zombiesDrawn: number;
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
  /** The state of the game: playing, or dead. */
  phase: GameStatus;
  /** 0 to 100. */
  health: number;
  /** 0 to 100: how well fed. At zero the survivor starves. */
  food: number;
  /** The gun in hand is dry, so a click swings the melee weapon instead. */
  meleeReady: boolean;
  /** The hour of the in-game day (0-24, local time), how dark it is (0 to 1), and whether the day goes by by itself. */
  hour: number;
  night: number;
  cycle: boolean;
  /** The next part of the city is being built (a window of a tiled city is moving). */
  loading: boolean;
  /** The game is paused: nothing moves, hunger and the clock stand still. */
  paused: boolean;
  /** The gun in hand, and whether the armory's guns have been found. */
  weapon: WeaponName;
  hasShotgun: boolean;
  hasRifle: boolean;
  /** How bright the moon is tonight, 0 (new) to 1 (full). */
  moon: number;
  /** Rounds in the magazine, its size, and rounds in reserve (for the gun in hand). */
  ammo: number;
  magazine: number;
  reserve: number;
  /** 0 when not reloading, otherwise how far through the reload it is (0 to 1). */
  reloading: number;
  /** 1 when the shove is ready, rising from 0 as it recharges. */
  shove: number;
  /** Seconds survived. */
  time: number;
  kills: number;
  /** Zombies standing in the streets, and zombies within 40 m. */
  zombies: number;
  near: number;
  /** The city's people now: well, bitten and turning, turned (in the streets and indoors), and at the start. */
  population: { healthy: number; bitten: number; zombies: number; initial: number };
  /** What the survivor could do where they stand: use a door, get into a car (null when nothing). */
  prompt: { label: string; name: string } | null;
  /** At the wheel: what it is, how fast (m/s), the tank (0 to 1), the car's condition (0 to 1); null on foot. */
  car: { kind: string; speed: number; fuel: number; condition: number; wrecked: boolean } | null;
  /** Sound is on (M toggles it). */
  sound: boolean;
  /** The weather now. */
  weather: Weather;
  /** The radar is on: the minimap is available. */
  radarOn: boolean;
  /** The next goal, how far off it is, and where it lies on the screen (radians clockwise from up). */
  objective: { text: string; distance: number; angle: number; compass: string } | null;
  /**
   * Where the nearest of the dead are, when none is near: in the street, inside a building here, or
   * beyond the window in a big city. Null when they are near (you can see them) or there are none.
   */
  threat: {
    text: string;
    distance: number;
    angle: number;
    compass: string;
    where: 'street' | 'inside' | 'beyond';
  } | null;
  /** Which shelter the survivor is hiding in, and how much of its door is left (0 to 1); null outdoors. */
  inside: { name: string; door: number } | null;
}

/** The radar's view of the world, centred on the survivor with "up" ahead of the camera. */
export interface RadarFrame {
  /** Metres from the centre to the edge of the scope. */
  range: number;
  /** Zombies: x (right), y (up) in metres, then 1 if hunting or striking, else 0: flat triples. */
  zombies: Float32Array;
  places: { kind: PlaceKind; x: number; y: number; used: boolean }[];
  /** Where north is on the scope, and which way the survivor faces: radians clockwise from up. */
  north: number;
  heading: number;
}

/** Things that happen in the game that the HUD wants to flash up. Angles are clockwise from screen-up. */
export type GameNotice =
  | { type: 'hurt'; amount: number; angle: number }
  | { type: 'pickup'; kind: 'ammo' | 'medkit' | 'food' }
  /** A shop, clinic or armory was searched (all zero when there was nothing you could use). */
  | {
      type: 'loot';
      ammo: number;
      health: number;
      food: number;
      armory: boolean;
      shotgun: boolean;
      place: string;
    }
  /** The gun in hand changed. */
  | { type: 'weapon'; weapon: WeaponName }
  | { type: 'radar'; place: string }
  | { type: 'enter'; place: string }
  | { type: 'breach'; place: string }
  /** The car: got in, got out, a hard crash (`force` is the speed lost, m/s), the tank ran dry, or it was wrecked. */
  | { type: 'car'; what: 'enter' | 'exit' | 'crash' | 'fuel' | 'wrecked'; force: number }
  /** A new game has begun: forget everything announced. */
  | { type: 'respawn' }
  | { type: 'restart' }
  | {
      type: 'over';
      /** Seconds survived. */
      time: number;
      kills: number;
      shots: number;
      hits: number;
      damageTaken: number;
      /** How many of the city's people were still well when it ended, and how many there were. */
      healthy: number;
      initial: number;
      /** True when the city fell (nobody left in it); false when the survivor died and the city goes on. */
      fallen: boolean;
    };

/** Levers for staging scenes (screenshots, tests). Only present when the scene is made with `debug: true`. */
export interface CityDebug {
  /** Put up to `count` zombies around the survivor, `distance` metres out. Returns how many were placed. */
  spawn(count: number, distance: number, hunting: boolean): number;
  /** Put up to `count` ordinary people in the street around the survivor, `distance` metres out. Returns how many were placed. */
  crowd(count: number, distance: number): number;
  /** Turn `count` people in the building nearest the survivor (the outbreak starts there). Returns false if no building had anyone. */
  infect(count: number): boolean;
  /** Everyone out in the street, and what they are doing (an HState number). */
  people(): { x: number; y: number; state: number }[];
  /** Put the survivor at this spot (city metres). */
  teleport(x: number, y: number): void;
  /** Aim at the nearest zombie by itself instead of at the mouse. */
  autoAim(on: boolean): void;
  /** Take health off the survivor. */
  hurt(amount: number): void;
  /** Set the hour of the day (0-24). */
  setClock(hour: number): void;
  /** Of a tiled city: where the window's centre is (metres east and north of the city's origin), and which tile. */
  window(): { origin: [number, number]; tile: [number, number]; buildings: number } | null;
  /** Of a tiled city: the tiles beyond the window being drawn for the camera, and which are built yet. */
  scenery(): { tx: number; ty: number; built: boolean }[];
  /** Jump the game clock forward. */
  skip(seconds: number): void;
  /** Set the game clock to an exact time. */
  setTime(seconds: number): void;
  /** Put the survivor at the door of the first place of this kind. Returns false if there is none. */
  goTo(kind: PlaceKind): boolean;
  /** Stop the game stepping (the picture keeps drawing), so a scene can be held still. */
  freeze(on: boolean): void;
  /** Put a car (a sedan, or the `KIND` asked for) beside the survivor, pointing their way, with a full tank. Returns its index. */
  summonCar(kind?: number): number;
  /** What the scene is feeding the game right now, and the car being driven. */
  probe(): {
    paused: boolean;
    frozen: boolean;
    move: [number, number];
    keys: string[];
    car: Car | null;
  };
  /** The cars: how many there are, which one is being driven, and the nearest one's distance. */
  cars(): { count: number; driving: number; nearest: number; onRoad: number };
  /** The ledger of a tiled city: how many entries, how many hold a number that is not one, and one such entry. */
  ledger(): { entries: number; broken: number; sample: unknown };
  /** The outbreak takes everyone: all the city's people turn, here and beyond, so the city falls on the next count. */
  wipe(): void;
  /** The numbers worth checking. */
  snapshot(): {
    status: GameStatus;
    health: number;
    ammo: number;
    reserve: number;
    reloading: number;
    alive: number;
    kills: number;
    shots: number;
    time: number;
    /** The hour of the day and how dark it is (0 to 1). */
    clock: number;
    night: number;
    x: number;
    y: number;
    /** Which way the survivor faces, in radians counter-clockwise from east. */
    heading: number;
    radarOn: boolean;
    /** The car being driven (-1 on foot) and its speed (m/s). */
    driving: number;
    carSpeed: number;
    /** How many places have been used up. */
    used: number;
    /** The place id of the shelter the survivor is in (-1 outdoors), and what is left of its door. */
    inside: number;
    door: number;
    /** The city's people: well, bitten, turned; people out in the street; and buildings whose door has been broken. */
    healthy: number;
    bitten: number;
    turned: number;
    streets: number;
    broken: number;
  };
}

/** Setting up a game: all optional (a random game by default). Handy for sharing and for tests. */
export interface GameSetup {
  seed?: number;
  /** Fix the weather (`?weather=rain|fog|clear`); otherwise it comes and goes with the seed. */
  weather?: WeatherKind;
  /** Groups of zombies in the streets at the start (0 for none). */
  zombies?: number;
  /** False to stop the clock where it is, for a still day: the time of day stays what `hour` says. */
  cycle?: boolean;
  /** How many people have turned somewhere in the city to begin with (0 for a calm city). */
  patients?: number;
  /** People per square kilometre. The default is the real density of the city. */
  density?: number;
  /** A game saved earlier (what `CityScene.save()` gave), to carry on from. Anything else is ignored. */
  resume?: unknown;
}

/** A city in tiles, as the scene needs it: the index, and the windows round any tile. */
export interface TiledCity {
  index: TileIndex;
  /** The window of tiles round (tx, ty), as one map with its own centre as origin. */
  loadWindow(tx: number, ty: number): Promise<CityData>;
  /** One tile on its own, as a map with the tile's centre as origin (empty where there is no tile). */
  loadTile(tx: number, ty: number): Promise<CityData>;
  /** Start fetching the window round (tx, ty), so it is at hand when needed. */
  prefetch(tx: number, ty: number): void;
}

export interface CityOptions {
  /** Local hour (0-24) the game starts at; the day then goes by as you play. Default is morning. */
  hour?: number;
  /** How bright the moon is at night, 0 (none) to 1 (full). Default: it follows the game's seed. */
  moon?: number;
  /** Start from this viewpoint instead of the default one, with no fly-in. Implies the free camera. */
  view?: CityViewpoint;
  /** Which camera to start with. Default: follow the survivor (free when `view` is given). */
  camera?: CameraMode;
  /** Put the survivor near this point (city metres) instead of beside the TV tower. */
  player?: { x: number; y: number };
  /** Skip the fly-in and the camera easing. Defaults to the user's reduced-motion setting. */
  reducedMotion?: boolean;
  game?: GameSetup;
  /** For a city in tiles: `data` is the window round the start, and this fetches the next ones. */
  tiled?: TiledCity;
  /** Add the `debug` levers to the scene. */
  debug?: boolean;
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
  /** Turn the sound on or off (it starts on the first key or tap, as browsers require). */
  setSound(on: boolean): void;
  soundOn(): boolean;
  /** What the thumbs are doing on a touch screen (null when there are no touch controls); read each frame beside the keys. */
  setTouch(input: TouchInput | null): void;
  /** A touch button was pressed. */
  touchPress(action: TouchAction): void;
  /** Point the free camera at the nearest of the dead (in the street, indoors, or beyond the window). False when there are none. */
  findZombies(): boolean;
  /** Fires about twice a second. */
  onStats(listener: (stats: CityStats) => void): Unsubscribe;
  /** Fires about ten times a second with the survivor's condition. */
  onPlayer(listener: (status: PlayerStatus) => void): Unsubscribe;
  /** Fires when something happens that the HUD should announce. */
  onGame(listener: (notice: GameNotice) => void): Unsubscribe;
  /** Fires about ten times a second once the radar is on (and once with null when it goes off). */
  onRadar(listener: (frame: RadarFrame | null) => void): Unsubscribe;
  /** Fires when the camera is as far out as it goes and the wheel keeps zooming out: time for the globe. */
  onZoomOut(listener: () => void): Unsubscribe;
  /** Start again: a new random city (`fresh`), or, after dying, a new survivor in the same city. */
  restart(fresh?: boolean): void;
  /** The game as it is now, as plain data, to be stored and given back as `GameSetup.resume`. */
  save(): SavedGame;
  /** Stop or resume the game. The picture keeps drawing; nothing in the game moves. */
  setPaused(paused: boolean): void;
  togglePause(): void;
  /**
   * Put the scene to sleep (nothing is drawn, stepped or listened to) while the globe is showing, and
   * wake it again. It wakes paused, with the pause menu up, so the horde does not get a free bite.
   */
  setSleeping(on: boolean): void;
  debug?: CityDebug;
  destroy(): void;
}

/** How far the radar scope sees, in metres. */
const RADAR_RANGE = 140;

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
  const TERRAIN_SIZE = 14000;
  /** One repeat of the ground texture, in metres. */
  const TERRAIN_GRAIN = TERRAIN_SIZE / 300;
  const terrain = new Mesh(
    own(new PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE)),
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
  // aviation beacons on the tall towers
  const beaconMaterial = own(new MeshBasicMaterial({ color: 0xff2a1a, fog: false }));
  const beaconGeometry = own(new SphereGeometry(1.5, 12, 8));

  // ---------- the district: everything built from one map, so that a new window can replace it ----------
  interface District {
    group: Group;
    colliders: Colliders;
    world: GameWorld;
    /** Where the survivor stands (or stood when this district was built). */
    spawn: [number, number];
    placeMarkers: ReturnType<typeof createPlaceMarkers>;
    lamps: ReturnType<typeof buildLampMeshes>;
    /** How many trees were planted. */
    trees: number;
    beacons: Mesh[];
    landmark: CityTower | undefined;
    dispose(): void;
  }

  type Keep = <T extends { dispose(): void }>(thing: T) => T;

  /**
   * The buildings, roads, ground and towers of one map, into `group`, yielding a frame now and then
   * so the page stays alive. What the district and a scenery tile have in common.
   */
  async function raiseStreets(
    map: CityData,
    group: Group,
    keep: Keep,
    say: (fraction: number, label: string) => void,
  ): Promise<void> {
    say(0.08, 'Raising buildings');
    const chunks = chunkBuildings(map.buildings, 250);
    for (let i = 0; i < chunks.length; i++) {
      const { walls, roofs } = buildBuildings(chunks[i]);
      const wallMesh = new Mesh(keep(toGeometry(walls)), wallMaterial);
      const roofMesh = new Mesh(keep(toGeometry(roofs)), roofMaterial);
      for (const m of [wallMesh, roofMesh]) {
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
      }
      if (i % 4 === 3) {
        say(0.08 + 0.5 * ((i + 1) / chunks.length), 'Raising buildings');
        await nextFrame();
      }
    }

    say(0.6, 'Laying roads');
    const roads = buildRoads(map.roads);
    for (const [mesh, material, z] of [
      [roads.paths, pathMaterial, 1],
      [roads.minor, minorRoadMaterial, 2],
      [roads.major, majorRoadMaterial, 3],
    ] as const) {
      const m = new Mesh(keep(toGeometry(mesh)), material);
      m.receiveShadow = true;
      m.renderOrder = z;
      group.add(m);
    }
    const ground = buildGround(map.areas, map.waterways);
    const land = new Mesh(keep(toGeometry(ground.land)), landMaterial);
    land.receiveShadow = true;
    group.add(land);
    const water = new Mesh(keep(toGeometry(ground.water)), waterMaterial);
    water.receiveShadow = true;
    group.add(water);

    // landmarks: the tall towers
    if (map.towers.length > 0) {
      const towers = new Mesh(keep(toGeometry(buildTowers(map.towers))), towerMaterial);
      towers.castShadow = true;
      towers.receiveShadow = true;
      group.add(towers);
    }
    await nextFrame();
  }

  /** A tile beyond the window: there to be looked at, with nothing in it to play. */
  interface Scenery {
    group: Group;
    setGlow(amount: number): void;
    /**
     * Move the tile's people and its turned, and draw them. `share` (0 to 1) is how many of its
     * people are out; the focus is where the camera looks, in the tile's own coordinates.
     */
    tick(
      dt: number,
      seconds: number,
      share: number,
      focusX: number,
      focusY: number,
      distance: number,
    ): void;
    /** The turned the ledger says roam this tile, by door (tile coordinates). */
    roam(doors: readonly Door[]): void;
    dispose(): void;
  }

  /** Build the look of one tile beyond the window: its streets, trees and lamps, and nobody about. */
  async function buildScenery(map: CityData): Promise<Scenery> {
    const owned: { dispose(): void }[] = [];
    const keep: Keep = (thing) => {
      owned.push(thing);
      return thing;
    };
    const group = new Group();
    await raiseStreets(map, group, keep, () => {});
    const occupancy = buildOccupancy(map, 2);
    const lamps = buildLampMeshes(placeLamps(map, occupancy), glowTexture, keep);
    group.add(lamps.group);
    group.add(buildTreeMeshes(placeTrees(map, occupancy), keep, cutaway));
    // life: cars at the kerbs, people on the pavements, the turned the ledger puts here (none yet)
    const [ox, oy] = map.origin ?? [0, 0];
    const seed = (Math.round(ox * 7 + oy * 131) ^ 0x51ce) >>> 0;
    const parked = parkInTile(map.roads, map.halfSize, occupancy, seed);
    const cars = keep(createCarRenderer(Math.max(1, parked.length)));
    cars.update(parked, -1, 0, 0, 0, false);
    group.add(cars.object);
    const walkers = createWalkers(map.roads, seed);
    const folk = keep(createPeopleRenderer(Math.max(1, walkers.count)));
    group.add(folk.object);
    const shamblers = createShamblers(seed);
    const dead = keep(createZombieRenderer(LIFE.shamblersMost));
    group.add(dead.object);
    return {
      group,
      setGlow: (amount) => lamps.setGlow(amount),
      tick(dt, seconds, share, focusX, focusY, distance) {
        walkers.step(dt, share);
        shamblers.step(dt);
        folk.update(walkers.humans, seconds, distance, focusX, focusY);
        dead.update(shamblers.horde, dt, focusX, focusY, distance);
      },
      roam: (doors) => shamblers.set(doors),
      dispose() {
        for (const d of owned) d.dispose();
      },
    };
  }

  /**
   * Build the buildings, roads, ground, trees, lamps, towers and the collision world of one map,
   * yielding a frame now and then so the page stays alive. `near` is where the survivor is to stand
   * (null: beside the tallest tower, or the middle); `report` shows progress (the first time only).
   */
  async function buildDistrict(
    map: CityData,
    near: [number, number] | null,
    report: boolean,
  ): Promise<District> {
    const owned: { dispose(): void }[] = [];
    const keep: Keep = (thing) => {
      owned.push(thing);
      return thing;
    };
    const say = (fraction: number, label: string): void => {
      if (report) progress(fraction, label);
    };
    const group = new Group();
    const mapHalf = map.halfSize;

    // the quarantine perimeter: a faint glowing wall around the edge of a map that stands alone (a
    // window of a bigger city has no edge, only more city beyond the fog)
    if (!map.origin) {
      const wallGeometry = keep(new PlaneGeometry(mapHalf * 2, 26));
      const sides: [number, number, number][] = [
        [0, -mapHalf, 0],
        [0, mapHalf, 0],
        [-mapHalf, 0, Math.PI / 2],
        [mapHalf, 0, Math.PI / 2],
      ];
      for (const [x, z, ry] of sides) {
        const wall = new Mesh(wallGeometry, perimeterMaterial);
        wall.position.set(x, 13, z);
        wall.rotation.y = ry;
        wall.renderOrder = 5;
        group.add(wall);
      }
    }

    await raiseStreets(map, group, keep, say);

    say(0.72, 'Planting trees');
    const occupancy = buildOccupancy(map, 2);
    const lampSet = placeLamps(map, occupancy); // lamps first, so trees keep clear of them
    const lamps = buildLampMeshes(lampSet, glowTexture, keep);
    group.add(lamps.group);
    const treeSet = placeTrees(map, occupancy);
    group.add(buildTreeMeshes(treeSet, keep, cutaway));
    await nextFrame();

    // beacons on the tall towers
    const beacons: Mesh[] = [];
    for (const tower of map.towers) {
      if (tower.height < 100) continue;
      const beacon = new Mesh(beaconGeometry, beaconMaterial);
      beacon.position.set(tower.x, tower.height + 1.2, -tower.y);
      group.add(beacon);
      beacons.push(beacon);
    }

    say(0.8, 'Finding a place to stand');
    const colliders = buildColliders(map, [
      { data: treeSet.data, stride: TREE_STRIDE, count: treeSet.count, radius: 0.35 },
      { data: lampSet.data, stride: LAMP_STRIDE, count: lampSet.count, radius: 0.15 },
    ]);
    const landmark = map.towers.find((t) => t.height >= 100);
    // With no landmark the survivor starts in the street nearest the middle of the map, not on
    // whatever open ground the middle happens to be (in a town of courtyards, a bare back lot).
    const nearestStreet = (): [number, number] => {
      let best: [number, number] = [0, 0];
      let bestD = Infinity;
      for (const r of map.roads) {
        if (!['residential', 'tertiary', 'secondary', 'primary'].includes(r.kind)) continue;
        for (let i = 0; i < r.points.length; i += 2) {
          const d = r.points[i] ** 2 + r.points[i + 1] ** 2;
          if (d < bestD) {
            bestD = d;
            best = [r.points[i], r.points[i + 1]];
          }
        }
      }
      return best;
    };
    const spawn = findSpawn(
      colliders,
      near ?? (landmark ? [landmark.x, landmark.y] : nearestStreet()),
      200,
      near ? 1.5 : 5,
    );
    const world = createGameWorld(colliders, spawn, map.buildings, map.roads);
    const placeMarkers = keep(
      createPlaceMarkers(
        world.places,
        world.places.map((p) => map.buildings[p.building].outer),
      ),
    );
    group.add(placeMarkers.object);
    return {
      group,
      colliders,
      world,
      spawn,
      placeMarkers,
      trees: treeSet.count,
      lamps,
      beacons,
      landmark,
      dispose() {
        for (const d of owned) d.dispose();
      },
    };
  }

  let district = await buildDistrict(
    data,
    options.player ? [options.player.x, options.player.y] : null,
    true,
  );
  scene.add(district.group);
  let colliders = district.colliders;
  let [spawnX, spawnY] = district.spawn;

  // ---------- the game: the city's people, the outbreak, the pistol, supplies ----------
  progress(0.82, 'Gathering the city');
  let gameWorld = district.world;
  const setup = options.game ?? {};
  // a window of a bigger city: where it sits, and what the outbreak has done to every building the
  // game has ever held (buildings keep their state when their tile is not loaded)
  const tiled = options.tiled ?? null;
  let origin: [number, number] = data.origin ?? [0, 0];
  /** A tile beyond the window, drawn for the camera (the scenery section below). */
  interface SceneryTile {
    tx: number;
    ty: number;
    /** Set once the tile has been asked for, so it is asked for once. */
    loading: boolean;
    built: Scenery | null;
    /** No longer wanted: whatever arrives for it is thrown away. */
    dropped: boolean;
    /** The share of its people still well, as the ledger has it (1 when the ledger knows nothing of it). */
    health: number;
  }
  const scenery = new Map<string, SceneryTile>();
  let repaired = 0;
  const ledger: Ledger =
    isSavedGame(setup.resume) && setup.resume.city
      ? readLedger(setup.resume.city.ledger, setup.resume.game.tick, (id, entry, fields) => {
          // a save from an older build: say what was missing, once, so the cause can be found
          if (!repaired++) console.warn('ledger entry repaired', id, fields.join(','), entry);
        })
      : new Map<number, LedgerEntry>();
  if (repaired > 0) console.warn(`${repaired} ledger entries repaired on load`);
  let seed = setup.seed ?? Math.floor(Math.random() * 0xffffffff);
  // the day: it starts at this hour and goes by as you play, an hour a minute; the game needs to know
  // when the sun rises and sets over this place, since that is when the dead are at their worst
  const startHour = options.hour ?? DAY.start;
  const sunToday = sunTimes(
    data.center[0],
    data.center[1],
    REFERENCE_DAY,
    utcOffsetHours(data.center[0]),
  );
  const gameOptions = (): GameOptions => ({
    seed,
    startX: spawnX,
    startY: spawnY,
    clumps: setup.zombies,
    patients: setup.patients,
    density: setup.density,
    startHour,
    cycle: setup.cycle,
    sunrise: sunToday?.sunrise,
    sunset: sunToday?.sunset,
    weather: setup.weather,
  });
  // a saved game is taken up once, where it left off; a restart after that is a new game
  let resume = isSavedGame(setup.resume) ? setup.resume : null;
  const resumed = resume !== null;
  const newGame = (): GameState => {
    if (resume) {
      const saved = resume;
      resume = null;
      seed = saved.options.seed;
      return loadGame(gameWorld, saved);
    }
    return createGame(gameWorld, gameOptions());
  };
  let game = newGame();
  // a saved game whose survivor died: the city is as it was, and a new survivor steps out into it
  if (game.status === 'lost') respawn(game, gameWorld, spawnX, spawnY);
  let player: PlayerState = game.player;
  let previous: PlayerState = player;
  const survivor = createSurvivor();
  scene.add(survivor.object);
  survivor.place(player.x, player.y, player.heading, 0, 0, false);

  const zombies = createZombieRenderer(game.horde.capacity);
  own(zombies);
  scene.add(zombies.object);
  const cars = createCarRenderer(CAR.parkMost + 8);
  own(cars);
  scene.add(cars.object);
  const people = createPeopleRenderer(Math.max(1, game.humans.capacity));
  own(people);
  scene.add(people.object);
  const effects = createEffects();
  own(effects);
  effects.setReducedMotion(reducedMotion);
  scene.add(effects.object);
  const pickupMarkers: PickupMarkers = createPickupMarkers(GAME.pickups.max);
  scene.add(pickupMarkers.object);
  let placeMarkers = district.placeMarkers;
  let markerSpent: boolean[] = gameWorld.places.map(() => false);
  let downAmount = 0;
  let gamePhase: GameStatus = 'playing';
  // a flashlight for the dark
  const flashlight = new SpotLight(0xfff1d6, 0, 70, 0.52, 0.65, 1.4);
  flashlight.castShadow = false;
  scene.add(flashlight, flashlight.target);
  let flashlightPref: 'auto' | 'on' | 'off' = 'auto';
  await nextFrame();

  // ---------- camera rig ----------
  let tower = district.landmark;
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
  // The free camera may wander the whole of a city in tiles (what it looks at is drawn as it goes,
  // see the scenery below), but only the play area of a map that stands alone.
  const cityBounds = tiled ? tileBounds(tiled.index) : null;
  const confine = (rig: Rig): Rig =>
    cityBounds
      ? keepInBox(rig, {
          minX: cityBounds.minX - origin[0],
          maxX: cityBounds.maxX - origin[0],
          minZ: -(cityBounds.maxY - origin[1]),
          maxZ: -(cityBounds.minY - origin[1]),
        })
      : keepInside(rig, half);

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
  let hour = startHour;
  /** The weather the picture was last set for (the sky is redone when it changes enough). */
  let shownWeather: Weather = { kind: 'clear', intensity: 0 };
  const rain = createRain();
  scene.add(rain.object);
  let elevation = 0;
  let darkness = 0; // 0 in daylight, 1 at night: drives the flashlight and the glow
  // The moon tonight: some games are lit by a full one, some have none at all. It follows the seed
  // (so a saved game keeps its moon), unless the link says otherwise.
  const moonOf = (s: number): number =>
    0.5 - 0.5 * Math.cos((((s * 2654435761) >>> 0) / 4294967296) * Math.PI * 2);
  let moon = options.moon ?? moonOf(seed);
  const lightDirection = new Vector3();
  const skyDirection = new Vector3();

  function applyTime(): void {
    const date = REFERENCE_DAY + (hour - utcOffsetHours(data.center[0])) * 3_600_000;
    const angles = localSun(date, data.center[0], data.center[1]);
    elevation = angles.elevation;
    const palette = weatherPalette(skyPalette(angles.elevation, moon), game.weather);
    const fogNow = weatherFog(game.weather);
    fog.near = fogNow.near;
    fog.far = fogNow.far;
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
    district.lamps.setGlow(palette.windowGlow);
    for (const s of scenery.values()) s.built?.setGlow(palette.windowGlow);
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
  // one-shot requests, kept until the first simulation step of a frame takes them
  let reloadQueued = false;
  let shoveQueued = false;
  let interactQueued = false;
  let weaponQueued: 0 | 1 | 2 | 3 = 0;
  let triggerHeld = false;
  // a game taken up from a save starts paused: you look round before the horde moves
  let paused = resumed && game.status === 'playing';
  // Asleep: the scene is kept but neither drawn nor stepped nor listening (the globe is showing).
  let sleeping = false;
  let aimScreen: { x: number; y: number } | null = null;
  // sound: made on the spot (src/city/sound.ts); it may only start on a gesture
  const sounds = createSoundScape();
  let soundSampleIn = 0;
  const groaners: Groaner[] = [];
  let nearCount = 0;
  // a touch screen's thumbs, read each frame beside the keys
  let touch: TouchInput | null = null;
  function touchPress(action: TouchAction): void {
    sounds.unlock();
    if (cameraMode !== 'follow' || game.status !== 'playing') return;
    switch (action) {
      case 'interact':
        interactQueued = true;
        break;
      case 'reload':
        reloadQueued = true;
        break;
      case 'shove':
        shoveQueued = true;
        break;
      case 'weapon':
        weaponQueued = nextWeapon(game.weapon, game.hasShotgun, game.hasRifle);
        break;
      case 'flashlight':
        flashlightPref = flashlightOn() ? 'off' : 'on';
        break;
      default:
        break;
    }
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (sleeping) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    sounds.unlock();
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Enter plays again; on a focused button it already means "press this", so leave it alone there
    // Enter plays on: the next survivor after a death, a new city after the city has fallen
    if (k === 'enter' && game.status !== 'playing' && !(e.target instanceof HTMLButtonElement))
      restart(game.status !== 'lost');
    else if (k === 'p') paused = !paused && game.status === 'playing';
    else if (k === 'r' && cameraMode === 'follow') {
      if (!e.repeat) reloadQueued = true;
    } else if (k === ' ' && cameraMode === 'follow') {
      if (!e.repeat) shoveQueued = true;
    } else if (k === 'f' && cameraMode === 'follow') {
      if (!e.repeat) interactQueued = true; // use the door you are standing at
    } else if ((k === '1' || k === '2' || k === '3') && cameraMode === 'follow') {
      weaponQueued = k === '1' ? 1 : k === '2' ? 2 : 3; // the pistol / the shotgun / the rifle
    } else if (k === 'v') setCameraMode(cameraMode === 'follow' ? 'free' : 'follow');
    else if (k === 'l') flashlightPref = flashlightOn() ? 'off' : 'on';
    else if (k === 'm') sounds.setEnabled(!sounds.enabled());
    else if (k === 'z') findZombies();
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
  const onBlur = (): void => {
    keys.clear();
    triggerHeld = false;
    // hunger and zombies do not wait: if you look away, the game does
    if (game.status === 'playing') paused = true;
  };
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
      goal = confine(pan(goal, (dy * mpp) / Math.sin(goal.pitch), -dx * mpp));
    }
    easeRate = Math.max(easeRate, 14);
  };
  const trackAim = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    const box = canvas.getBoundingClientRect();
    aimScreen = { x: e.clientX - box.left, y: e.clientY - box.top };
  };
  const onPointerDown = (e: PointerEvent): void => {
    canvas.setPointerCapture(e.pointerId);
    sounds.unlock();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    introUntil = 0;
    trackAim(e);
    // with a mouse, the left button is the trigger while walking the survivor
    if (e.pointerType === 'mouse' && e.button === 0 && cameraMode === 'follow') triggerHeld = true;
  };
  const onPointerMove = (e: PointerEvent): void => {
    trackAim(e);
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (pointers.size === 1) {
      const orbit = (e.buttons & 6) !== 0 || ((e.buttons & 1) !== 0 && e.altKey);
      // a mouse in follow mode is aiming: only the right or middle button drags the camera round
      if (!(e.pointerType === 'mouse' && cameraMode === 'follow' && !orbit)) dragBy(dx, dy, orbit);
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
    if (e.pointerType === 'mouse' && (e.button === 0 || e.type === 'pointercancel')) {
      triggerHeld = false;
    }
  };
  const onPointerLeave = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && !pointers.has(e.pointerId)) aimScreen = null;
  };
  // Zooming out past the edge of the city hands you back to the globe: a few more notches of the wheel
  // once the camera is as far out as it goes.
  const zoomOutEvents = createEmitter<void>();
  let wheeledPast = 0;
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const out = e.deltaY * lines;
    const atTheEdge = goal.distance >= MAX_DISTANCE - 1;
    goal = zoom(goal, Math.exp(out * 0.0011));
    if (out > 0 && atTheEdge) {
      wheeledPast += out;
      if (wheeledPast > 450) {
        wheeledPast = 0;
        zoomOutEvents.emit();
      }
    } else wheeledPast = 0;
    introUntil = 0;
  };
  const onContextMenu = (e: Event): void => e.preventDefault();
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);

  // ---------- frame loop ----------
  const stats = createEmitter<CityStats>();
  const playerEvents = createEmitter<PlayerStatus>();
  const notices = createEmitter<GameNotice>();
  const radarFrames = createEmitter<RadarFrame | null>();
  let radarWasOn = false;
  const SIM_STEP = 1 / 60;
  let simClock = 0;
  let playerAt = 0;
  const cutPlayer = new Vector3();

  /** Turn what the game reports into pictures and HUD announcements. */
  function handleEvent(e: GameEvent): void {
    switch (e.type) {
      case 'shot':
        effects.shot(e.x, e.y, e.endX, e.endY, e.hit);
        sounds.shot(game.weapon, e.x, e.y);
        break;
      case 'hit':
        effects.hit(e.x, e.y, e.kill);
        sounds.hit(e.x, e.y, e.kill);
        break;
      case 'noise':
        effects.noise(e.x, e.y, e.radius);
        break;
      case 'hurt':
        sounds.hurt(e.amount);
        notices.emit({
          type: 'hurt',
          amount: e.amount,
          angle: screenAngle(current.yaw, e.fromX - player.x, e.fromY - player.y),
        });
        break;
      case 'reload':
        sounds.reload();
        break;
      case 'reloaded':
        sounds.reloaded();
        break;
      case 'empty':
        sounds.empty();
        break;
      case 'swing':
        sounds.swing();
        break;
      case 'shove':
        sounds.shove();
        break;
      case 'leave':
        sounds.door(false);
        break;
      case 'door':
        sounds.battering(e.fraction);
        break;
      case 'pickup':
        sounds.pickup(e.kind);
        notices.emit({ type: 'pickup', kind: e.kind });
        break;
      case 'loot':
        sounds.loot(e.ammo + e.health + e.food === 0 && !e.shotgun);
        notices.emit({
          type: 'loot',
          ammo: e.ammo,
          health: e.health,
          food: e.food,
          armory: e.armory,
          shotgun: e.shotgun,
          place: gameWorld.places[e.place].name,
        });
        break;
      case 'weapon':
        notices.emit({ type: 'weapon', weapon: e.weapon });
        break;
      case 'radar':
        sounds.radar();
        notices.emit({ type: 'radar', place: gameWorld.places[e.place].name });
        break;
      case 'enter':
        sounds.door(true);
        notices.emit({ type: 'enter', place: gameWorld.places[e.place].name });
        break;
      case 'breach':
        sounds.breach();
        notices.emit({ type: 'breach', place: gameWorld.places[e.place].name });
        break;
      case 'car':
        sounds.car(e.what, e.force);
        if (e.what === 'crash') effects.noise(e.x, e.y, Math.min(12, e.force * 1.5));
        if (e.what !== 'crash' || e.force > CAR.hurtSpeed) {
          notices.emit({ type: 'car', what: e.what, force: e.force });
        }
        break;
      case 'lost':
      case 'fallen': {
        const city = cityPopulation();
        notices.emit({
          type: 'over',
          time: game.time,
          kills: game.stats.kills,
          shots: game.stats.shots,
          hits: game.stats.hits,
          damageTaken: Math.round(game.stats.damageTaken),
          healthy: city.healthy,
          initial: city.initial,
          fallen: e.type === 'fallen',
        });
        break;
      }
      default:
        break; // weapon: announced above; nothing else to show
    }
  }

  // The point on the ground-plane that the mouse is over, at about chest height so that aiming at a
  // zombie's body (not its feet) works from a steep camera. Null with no mouse or the free camera.
  const AIM_HEIGHT = 1;
  const aimRay = new Vector3();
  const aimDirection = new Vector3();
  function aimPoint(): [number, number] | null {
    if (!aimScreen || cameraMode !== 'follow') return null;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w < 1 || h < 1) return null;
    camera.updateMatrixWorld();
    aimRay.set((aimScreen.x / w) * 2 - 1, -(aimScreen.y / h) * 2 + 1, 0.5).unproject(camera);
    aimDirection.copy(aimRay).sub(camera.position).normalize();
    if (aimDirection.y > -0.02) return null; // looking at the sky
    const t = (AIM_HEIGHT - camera.position.y) / aimDirection.y;
    return [camera.position.x + aimDirection.x * t, -(camera.position.z + aimDirection.z * t)];
  }

  let debugAutoAim = false;
  let debugFrozen = false;
  let lastMove: [number, number] = [0, 0];
  /** The game tick the rest of the city was last brought up to date, and how often (20 s). */
  let ledgerTick = game.tick;
  const LEDGER_EVERY = 1200;
  function nearestZombie(): [number, number] | null {
    const h = game.horde;
    let best = -1;
    let bestD = 40 * 40;
    for (let i = 0; i < h.used; i++) {
      if (h.state[i] >= ZState.DEAD) continue;
      const d = (h.x[i] - player.x) ** 2 + (h.y[i] - player.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best < 0 ? null : [h.x[best], h.y[best]];
  }

  /** Begin a new game from the start: a fresh horde, supplies and clock, and the survivor back at the spawn. */
  // ---------- a window of a bigger city: moving it as the survivor walks ----------
  let shifting = false;
  /**
   * The people of the city: the window's, and in a tiled city also everyone the ledger holds beyond
   * it (as last known). `initial` is everyone ever counted, so "still well" is out of a steady number.
   */
  function cityPopulation(): Population {
    const p = game.population;
    if (!tiled) return { ...p };
    const beyond = ledgerOutside(ledger, gameWorld);
    game.beyond = beyond; // so the game knows whether anyone is left out there
    const healthy = p.healthy + beyond.healthy;
    const bitten = p.bitten + beyond.bitten;
    const zombies = p.zombies + beyond.zombies;
    return { healthy, bitten, zombies, initial: healthy + bitten + zombies };
  }
  /** Called each frame: is it time to move the window, or to have the next one ready? */
  function watchWindow(): void {
    if (!tiled) return;
    const [cx, cy] = tileAt(tiled.index, origin[0], origin[1]);
    const [tx, ty] = tileAt(tiled.index, player.x + origin[0], player.y + origin[1]);
    if (tx !== cx || ty !== cy) {
      void shiftWindow(tx, ty);
      return;
    }
    // nearing an edge of the centre tile: have the window beyond it ready
    const edge = tiled.index.tileSize / 2 - 200;
    const ex = Math.abs(player.x) > edge ? Math.sign(player.x) : 0;
    const ey = Math.abs(player.y) > edge ? Math.sign(player.y) : 0;
    if (ex !== 0 || ey !== 0) tiled.prefetch(cx + ex, cy + ey);
  }
  /** Build the window round tile (tx, ty) while the game goes on, then swap it in and carry the game over. */
  async function shiftWindow(tx: number, ty: number): Promise<void> {
    if (!tiled) return;
    shifting = true;
    try {
      const next = await tiled.loadWindow(tx, ty);
      if (destroyed) return;
      const newOrigin: [number, number] = next.origin ?? [0, 0];
      const dx = origin[0] - newOrigin[0];
      const dy = origin[1] - newOrigin[1];
      const built = await buildDistrict(next, [player.x + dx, player.y + dy], false);
      if (destroyed) {
        built.dispose();
        return;
      }
      scene.remove(district.group);
      district.dispose();
      scene.add(built.group);
      game = migrateGame(game, gameWorld, built.world, gameOptions(), [dx, dy], ledger);
      ledgerTick = game.tick; // migrating brought the rest of the city up to date
      player = previous = game.player;
      district = built;
      colliders = built.colliders;
      gameWorld = built.world;
      placeMarkers = built.placeMarkers;
      markerSpent = gameWorld.places.map(() => false);
      tower = built.landmark;
      origin = newOrigin;
      spawnX += dx;
      spawnY += dy;
      goal = { ...goal, x: goal.x + dx, z: goal.z - dy };
      current = { ...current, x: current.x + dx, z: current.z - dy };
      home.x += dx;
      home.z -= dy;
      effects.clear();
      applyTime(); // the new lamps take the glow of the hour
      placeScenery(); // the scenery stays where it is in the city, which has moved under it
      watchScenery(); // and what the new window covers goes
    } finally {
      shifting = false;
    }
  }

  // ---------- scenery: the tiles beyond the window, drawn where the camera looks, not played ----------
  // The game is played in the window round the survivor. The free camera may look past its edge, and
  // what it sees there should be the city, not open ground: those tiles are drawn as they are on the
  // map (streets, trees, lamps), with nobody in them, and let go again when the camera has moved on.
  const tileExists = new Set((tiled?.index.tiles ?? []).map((t) => tileKey(t.tx, t.ty)));
  /** A tile is kept until the camera looks further than this from it: at most a window's worth is held. */
  const SCENERY_KEEP = 1;
  let sceneryBusy = false;
  let sceneryAt = 0;
  let lifeAt = 0;
  /** What the ledger says of each scenery tile: who roams its streets, and how many of its people are left. */
  function roamScenery(): void {
    if (!tiled) return;
    const size = tiled.index.tileSize;
    const half = size / 2;
    for (const s of scenery.values()) {
      if (!s.built) continue;
      const ox = s.tx * size - origin[0];
      const oy = s.ty * size - origin[1];
      const doors: Door[] = [];
      let well = 0;
      let all = 0;
      for (const e of ledger.values()) {
        if (Number.isNaN(e.x)) continue;
        const x = e.x - ox;
        const y = e.y - oy;
        if (Math.abs(x) > half || Math.abs(y) > half) continue;
        well += e.healthy;
        all += e.healthy + e.incubating + e.undead + e.roaming;
        if (e.roaming > 0) doors.push({ x, y, count: e.roaming });
      }
      s.health = all > 0 ? well / all : 1;
      s.built.roam(doors);
    }
  }

  // ---------- finding the dead: where the nearest of them are, for the HUD and the Z key ----------
  interface Threat {
    x: number;
    y: number;
    where: 'street' | 'inside' | 'beyond';
    text: string;
  }
  /** The nearest of the dead to the survivor: in the street, else inside a building here, else beyond the window. */
  function nearestThreat(): Threat | null {
    const px = player.x;
    const py = player.y;
    let best: Threat | null = null;
    let bestD = Infinity;
    const consider = (x: number, y: number, where: Threat['where'], text: string): void => {
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x, y, where, text };
      }
    };
    const h = game.horde;
    for (let i = 0; i < h.used; i++) {
      if (h.state[i] >= ZState.DEAD) continue;
      consider(h.x[i], h.y[i], 'street', 'Zombies');
    }
    if (best) return best;
    const o = game.outbreak;
    for (let b = 0; b < o.count; b++) {
      if (o.undead[b] + o.incubating[b] === 0 || Number.isNaN(o.doorX[b])) continue;
      consider(o.doorX[b], o.doorY[b], 'inside', 'The outbreak, indoors');
    }
    if (best) return best;
    for (const e of ledger.values()) {
      if (Number.isNaN(e.x) || e.undead + e.incubating + e.roaming === 0) continue;
      consider(e.x, e.y, 'beyond', 'The outbreak, beyond the window');
    }
    return best;
  }
  /** Point the free camera at the nearest of the dead. Returns false when there are none anywhere. */
  function findZombies(): boolean {
    const t = nearestThreat();
    if (!t) return false;
    setCameraMode('free');
    goal = { ...goal, x: t.x, z: -t.y, distance: Math.min(goal.distance, 140) };
    introUntil = 0;
    return true;
  }
  /** Put each built tile where its centre is in the window's coordinates. */
  function placeScenery(): void {
    if (!tiled) return;
    const size = tiled.index.tileSize;
    for (const s of scenery.values()) {
      s.built?.group.position.set(s.tx * size - origin[0], 0, -(s.ty * size - origin[1]));
    }
  }
  function dropScenery(key: string, s: SceneryTile): void {
    s.dropped = true;
    scenery.delete(key);
    if (s.built) {
      scene.remove(s.built.group);
      s.built.dispose();
    }
  }
  /** A few times a second: which tiles beyond the window the camera looks at now, and tidying the rest. */
  function watchScenery(): void {
    if (!tiled) return;
    const index = tiled.index;
    const looking = tileAt(index, current.x + origin[0], -current.z + origin[1]);
    const centre = tileAt(index, origin[0], origin[1]);
    for (const [key, s] of scenery) {
      const far = Math.max(Math.abs(s.tx - looking[0]), Math.abs(s.ty - looking[1])) > SCENERY_KEEP;
      const covered = Math.abs(s.tx - centre[0]) <= 1 && Math.abs(s.ty - centre[1]) <= 1;
      if (far || covered) dropScenery(key, s);
    }
    for (const [tx, ty] of sceneryTiles(looking, centre, 1)) {
      const key = tileKey(tx, ty);
      if (tileExists.has(key) && !scenery.has(key)) {
        scenery.set(key, { tx, ty, loading: false, built: null, dropped: false, health: 1 });
      }
    }
    void pumpScenery();
  }
  /** Build the scenery tiles that are waiting, one at a time, between the frames; the window comes first. */
  async function pumpScenery(): Promise<void> {
    if (sceneryBusy || !tiled) return;
    sceneryBusy = true;
    try {
      for (;;) {
        if (destroyed) return;
        if (shifting) {
          await nextFrame();
          continue;
        }
        const next = [...scenery.values()].find((s) => !s.loading);
        if (!next) return;
        next.loading = true;
        let map: CityData;
        try {
          map = await tiled.loadTile(next.tx, next.ty);
        } catch {
          continue; // left as asked-for: not tried again until the camera has been away and back
        }
        if (destroyed || next.dropped) continue;
        const built = await buildScenery(map);
        if (destroyed || next.dropped) {
          built.dispose();
          continue;
        }
        next.built = built;
        built.setGlow(darkness);
        scene.add(built.group);
        placeScenery();
      }
    } finally {
      sceneryBusy = false;
    }
  }

  function restart(fresh = true): void {
    if (!fresh && game.status === 'lost') {
      // the city goes on: a new survivor in it, where the outbreak has got to. The start may be in a
      // part of the city that is not loaded now: then the middle of the window is the start.
      const startHere =
        Math.abs(spawnX) < colliders.half - 50 && Math.abs(spawnY) < colliders.half - 50;
      respawn(game, gameWorld, startHere ? spawnX : 0, startHere ? spawnY : 0);
      notices.emit({ type: 'respawn' });
    } else {
      seed = Math.floor(Math.random() * 0xffffffff);
      game = newGame();
      moon = options.moon ?? moonOf(seed); // another night, another moon
      applyTime();
      notices.emit({ type: 'restart' });
    }
    player = previous = game.player;
    gamePhase = 'playing';
    paused = false;
    downAmount = 0;
    survivor.setDown(0);
    effects.clear();
    reloadQueued = shoveQueued = interactQueued = false;
    weaponQueued = 0;
    simClock = 0;
    goal = cameraMode === 'follow' ? recentred() : { ...home };
    easeRate = Math.max(easeRate, 10);
    // (announced above, before the picture was reset)
  }
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
    if (destroyed || sleeping) return; // asleep: the loop stops here and is started again on waking
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
      goal = confine(pan(goal, forward * speed * dt, sideways * speed * dt));
      easeRate = Math.max(easeRate, 9);
      introUntil = 0;
    }
    const turn = Number(keys.has('e')) - Number(keys.has('q'));
    // R reloads when walking the survivor, so it only tilts the camera in the free view
    const tilt = cameraMode === 'free' ? Number(keys.has('r')) - Number(keys.has('f')) : 0;
    if (turn || tilt) goal = rotate(goal, turn * 1.5 * dt, tilt * 0.9 * dt);

    // The game runs on a fixed 60 Hz clock, so it plays out identically at any frame rate. "Forward"
    // is up the screen: the direction the camera looks, flattened onto the ground.
    const axes = groundAxes(current.yaw);
    const walking = cameraMode === 'follow';
    // on a touch screen the thumbs add to the keys: the left stick walks, the right one aims and fires
    const thumbs = touch ?? NO_TOUCH;
    const fwd = clamp(forward + thumbs.move[1], -1, 1);
    const side = clamp(sideways + thumbs.move[0], -1, 1);
    let aim: readonly [number, number] | null = debugAutoAim ? nearestZombie() : aimPoint();
    if (!debugAutoAim && walking && thumbs.aim) {
      const [ax, ay] = thumbs.aim; // a direction on the screen: 25 m that way from the survivor
      aim = [
        player.x + (ax * axes.right[0] + ay * axes.forward[0]) * 25,
        player.y - (ax * axes.right[1] + ay * axes.forward[1]) * 25,
      ];
    }
    const input: GameInput = {
      moveX: walking ? fwd * axes.forward[0] + side * axes.right[0] : 0,
      moveY: walking ? -(fwd * axes.forward[1] + side * axes.right[1]) : 0,
      // at the wheel the same keys are the pedal and the wheel: W forward, S brake, A left, D right
      throttle: walking ? fwd : 0,
      steer: walking ? -side : 0,
      sprint: keys.has('shift') || thumbs.sprint,
      aim,
      fire: walking && (triggerHeld || thumbs.fire),
      reload: reloadQueued,
      shove: shoveQueued,
      interact: interactQueued,
      weapon: weaponQueued,
    };
    lastMove = [input.moveX, input.moveY];
    simClock = debugFrozen || paused ? 0 : simClock + dt;
    const simDt = paused ? 0 : dt; // animations that follow the game stand still too
    let steps = 0;
    while (simClock >= SIM_STEP && steps < 6) {
      previous = player;
      stepGame(game, input, gameWorld, SIM_STEP);
      player = game.player;
      // a reload or shove request counts once, on the first step that sees it
      input.reload = false;
      input.shove = false;
      input.interact = false;
      input.weapon = 0;
      if (steps === 0) {
        reloadQueued = shoveQueued = interactQueued = false;
        weaponQueued = 0;
      }
      for (const e of drainEvents(game)) handleEvent(e);
      simClock -= SIM_STEP;
      steps++;
    }
    if (steps === 6) simClock = 0; // far behind (a stalled tab): do not try to catch up
    // The rest of a big city does not stand still while the survivor stays in one part of it: the
    // outbreak goes on out there, and what it brings to the window's edge comes in.
    if (tiled && game.tick - ledgerTick >= LEDGER_EVERY) {
      ledgerTick = game.tick;
      advanceLedger(ledger, game.tick, game.rng, new Set(gameWorld.buildings.map((b) => b.id)));
      enterWindow(game, gameWorld, ledger);
      cityPopulation();
    }
    // the sky follows the game's clock, however it was set (it changes in steps of about a minute)
    const weatherNow = game.weather;
    if (
      Math.abs(game.clock - hour) > 0.015 ||
      weatherNow.kind !== shownWeather.kind ||
      Math.abs(weatherNow.intensity - shownWeather.intensity) > 0.03
    ) {
      hour = game.clock;
      shownWeather = weatherNow;
      applyTime();
    }
    gamePhase = game.status;
    if (tiled && !shifting && gamePhase === 'playing') watchWindow();

    // sound: the listener is the camera; what goes on (the engine, the horde, steps) follows the game
    sounds.listen(camera.position.x, -camera.position.z, axes.right[0], -axes.right[1]);
    soundSampleIn -= dt;
    if (soundSampleIn <= 0) {
      soundSampleIn = 0.25;
      groaners.length = 0;
      nearCount = 0;
      const h = game.horde;
      for (let i = 0; i < h.used; i++) {
        if (h.state[i] >= ZState.DEAD) continue;
        const dx = h.x[i] - player.x;
        const dy = h.y[i] - player.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 60 * 60) continue;
        if (d2 < 40 * 40) nearCount++;
        if (groaners.length < 24)
          groaners.push({
            x: h.x[i],
            y: h.y[i],
            chasing: h.state[i] === ZState.CHASE || h.state[i] === ZState.ATTACK,
          });
      }
    }
    const drivenCar = game.driving >= 0 ? game.cars[game.driving] : null;
    sounds.update({
      dt: simDt,
      engine: drivenCar
        ? {
            speed: Math.abs(drivenCar.speed),
            top: kindOf(drivenCar).topRoad,
            running: input.throttle !== 0,
            broken: wrecked(drivenCar) || drivenCar.fuel <= 0,
          }
        : null,
      groaners,
      near: nearCount,
      walking: drivenCar ? 0 : speedOf(player) > 1.2 ? (player.sprinting ? 2 : 1) : 0,
      health: game.health,
      night: darkness,
      rain: game.weather.kind === 'rain' ? game.weather.intensity : 0,
      inside: game.inside >= 0,
      playing: gamePhase === 'playing' && !paused && !debugFrozen,
    });
    if (tiled && now - sceneryAt >= 300) {
      sceneryAt = now;
      watchScenery();
    }
    if (tiled && scenery.size > 0 && now - lifeAt >= 2000) {
      lifeAt = now;
      roamScenery();
    }
    const alpha = simClock / SIM_STEP;
    const px = lerp(previous.x, player.x, alpha);
    const py = lerp(previous.y, player.y, alpha);
    // a dead survivor falls over
    downAmount = gamePhase === 'lost' ? Math.min(1, downAmount + dt / 0.6) : 0;
    survivor.setDown(downAmount);
    const driving = game.driving >= 0;
    survivor.object.visible = game.inside < 0 && !driving; // out of sight while sheltering or at the wheel
    survivor.place(
      px,
      py,
      player.heading,
      lerp(previous.travelled, player.travelled, alpha),
      speedOf(player),
      player.sprinting,
    );

    if (cameraMode === 'follow') {
      // the camera leads a little in the direction of travel (a good way ahead of a car)
      const lead = driving ? 14 : 2.5;
      goal = {
        ...goal,
        x: px + clamp(player.vx * 0.5, -lead, lead),
        z: -(py + clamp(player.vy * 0.5, -lead, lead)),
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

    // flashlight: on by itself when it gets dark, and L overrides. At the wheel it is the headlamps.
    const lit = flashlightOn() && game.inside < 0;
    const beamFrom = driving ? kindOf(game.cars[game.driving]).length / 2 : 0.3;
    const beamTo = driving ? 34 : 16;
    flashlight.intensity = lit ? (driving ? 1400 : 420) * (0.35 + 0.65 * darkness) : 0;
    flashlight.angle = driving ? 0.7 : 0.52;
    flashlight.distance = driving ? 110 : 70;
    flashlight.position.set(
      px + Math.cos(player.heading) * beamFrom,
      driving ? 0.8 : 1.5,
      -(py + Math.sin(player.heading) * beamFrom),
    );
    flashlight.target.position.set(
      px + Math.cos(player.heading) * beamTo,
      0,
      -(py + Math.sin(player.heading) * beamTo),
    );

    // the cars, the horde, the people, the supplies and the shots
    cars.update(game.cars, game.driving, px, py, player.heading, lit);
    zombies.update(game.horde, simDt, current.x, -current.z, current.distance);
    people.update(game.humans, now / 1000, current.distance, current.x, -current.z);
    // life in the tiles beyond the window, where the free camera looks
    if (scenery.size > 0 && tiled) {
      // how busy the pavements are: the hour's share of people out against the busiest hour's
      const share = (outdoorShare(game.clock) / OUTDOOR_PEAK) * senses(game.weather).outdoors;
      const size = tiled.index.tileSize;
      for (const s of scenery.values()) {
        if (!s.built) continue;
        const ox = s.tx * size - origin[0];
        const oy = s.ty * size - origin[1];
        s.built.tick(
          simDt,
          now / 1000,
          share * s.health,
          current.x - ox,
          -current.z - oy,
          current.distance,
        );
      }
    }
    rain.update(
      current.x,
      current.z,
      simDt,
      game.weather.kind === 'rain' ? game.weather.intensity : 0,
    );
    pickupMarkers.sync(game.pickups, now / 1000, darkness);
    // a place that is used up, or a shelter whose door has gone, fades
    for (let i = 0; i < markerSpent.length; i++) markerSpent[i] = game.used[i] || game.breached[i];
    placeMarkers.sync(markerSpent, now / 1000, darkness, current.distance);
    const aimMode: AimMode =
      game.reloading > 0 ? 'reloading' : game.ammo === 0 && game.reserve === 0 ? 'empty' : 'ready';
    effects.setAim(
      aim && gamePhase === 'playing' && game.inside < 0 ? aim[0] : null,
      aim ? aim[1] : 0,
      clamp(current.distance / 36, 1, 5),
      aimMode,
    );
    effects.update(simDt);

    if (now - playerAt >= 100) {
      playerAt = now;
      let near = 0;
      const h = game.horde;
      for (let i = 0; i < h.used; i++) {
        if (h.state[i] >= ZState.DEAD) continue; // dead or free
        const dx = h.x[i] - player.x;
        const dy = h.y[i] - player.y;
        if (dx * dx + dy * dy < 1600) near++;
      }

      // what could be done at the door here
      const here = interactionAt(game, gameWorld);

      // the next goal: power up the radar, then whatever the survivor is short of
      const pointAt = (
        text: string,
        x: number,
        y: number,
      ): NonNullable<PlayerStatus['objective']> => ({
        text,
        distance: Math.hypot(x - player.x, y - player.y),
        angle: screenAngle(current.yaw, x - player.x, y - player.y),
        compass: compassName(Math.atan2(y - player.y, x - player.x)),
      });
      const nearestPlace = (kinds: readonly PlaceKind[]): { x: number; y: number } | null => {
        let best: { x: number; y: number } | null = null;
        let bestD = Infinity;
        for (const p of gameWorld.places) {
          if (!kinds.includes(p.kind) || game.used[p.id]) continue;
          const d = Math.hypot(p.x - player.x, p.y - player.y);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        return best;
      };
      let objective: PlayerStatus['objective'] = null;
      if (gamePhase === 'playing') {
        const radarPlace = gameWorld.places.find((p) => p.kind === 'radar');
        const lowOnSupplies = game.food < 40 || game.ammo + game.reserve < 12 || game.health < 40;
        const shop = lowOnSupplies ? nearestPlace(['supplies']) : null;
        const armory = !game.hasShotgun ? nearestPlace(['armory']) : null;
        if (radarPlace && !game.radarOn) {
          objective = pointAt('Power up the radar', radarPlace.x, radarPlace.y);
        } else if (shop) {
          objective = pointAt('Find food and ammunition', shop.x, shop.y);
        } else if (armory) {
          objective = pointAt('Find the armory', armory.x, armory.y);
        }
      }
      // where the dead are, for a survivor who cannot see any
      let threat: PlayerStatus['threat'] = null;
      if (gamePhase === 'playing' && near === 0) {
        const t = nearestThreat();
        if (t) threat = { ...pointAt(t.text, t.x, t.y), where: t.where };
      }

      // the radar scope: everything within range, turned so that "up" is ahead of the camera
      if (game.radarOn) {
        const range = RADAR_RANGE;
        const found: number[] = [];
        for (let i = 0; i < h.used; i++) {
          const s = h.state[i];
          if (s >= ZState.DEAD) continue;
          const dx = h.x[i] - player.x;
          const dy = h.y[i] - player.y;
          if (dx * dx + dy * dy > range * range) continue;
          const [rx, ry] = screenOffset(current.yaw, dx, dy);
          found.push(rx, ry, s === ZState.WANDER ? 0 : 1);
        }
        radarFrames.emit({
          range,
          zombies: Float32Array.from(found),
          places: gameWorld.places.map((p) => {
            const [rx, ry] = screenOffset(current.yaw, p.x - player.x, p.y - player.y);
            return { kind: p.kind, x: rx, y: ry, used: game.used[p.id] };
          }),
          north: screenAngle(current.yaw, 0, 1),
          heading: screenAngle(current.yaw, Math.cos(player.heading), Math.sin(player.heading)),
        });
        radarWasOn = true;
      } else if (radarWasOn) {
        radarFrames.emit(null);
        radarWasOn = false;
      }

      playerEvents.emit({
        x: player.x,
        y: player.y,
        speed: speedOf(player),
        stamina: player.stamina,
        exhausted: player.exhausted,
        sprinting: player.sprinting,
        flashlight: lit,
        camera: cameraMode,
        phase: game.status,
        health: game.health,
        food: game.food,
        meleeReady: game.ammo <= 0 && game.reserve <= 0,
        hour: game.clock,
        night: game.night,
        cycle: game.cycle,
        paused,
        weapon: game.weapon,
        hasShotgun: game.hasShotgun,
        hasRifle: game.hasRifle,
        moon,
        ammo: game.ammo,
        magazine: weaponConfig(game.weapon).mag,
        reserve: game.reserve,
        reloading: game.reloading > 0 ? 1 - game.reloading / weaponConfig(game.weapon).reload : 0,
        shove: 1 - game.shoveCooldown / GAME.shove.cooldown,
        time: game.time,
        kills: game.stats.kills,
        zombies: game.horde.alive,
        near,
        population: cityPopulation(),
        loading: shifting,
        prompt: here ? { label: here.label, name: here.name } : null,
        car:
          game.driving >= 0
            ? {
                kind: kindOf(game.cars[game.driving]).name,
                speed: Math.abs(game.cars[game.driving].speed),
                fuel: game.cars[game.driving].fuel,
                condition: game.cars[game.driving].hp / kindOf(game.cars[game.driving]).hp,
                wrecked: wrecked(game.cars[game.driving]),
              }
            : null,
        radarOn: game.radarOn,
        sound: sounds.enabled(),
        weather: game.weather,
        objective,
        threat,
        inside:
          game.inside >= 0
            ? {
                name: gameWorld.places[game.inside].name,
                door: game.doors[game.inside] / GAME.shelter.door,
              }
            : null,
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
    // the bare ground goes on under the camera wherever it looks, moved by whole grains of its texture
    // so that it never seems to slide
    terrain.position.x = Math.round(current.x / TERRAIN_GRAIN) * TERRAIN_GRAIN;
    terrain.position.z = Math.round(current.z / TERRAIN_GRAIN) * TERRAIN_GRAIN;
    sun.position.set(
      tx + lightDirection.x * 800,
      lightDirection.y * 800,
      tz + lightDirection.z * 800,
    );

    sky.update(skyPalette(elevation), skyDirection, camera, fog);

    // blink the beacons
    const on = Math.sin(now / 420) > 0.2;
    for (const b of district.beacons) b.visible = on;

    renderer.render(scene, camera);

    frames++;
    if (now - statsAt >= 500) {
      stats.emit({
        fps: (frames * 1000) / (now - statsAt),
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        buildings: data.buildings.length,
        trees: district.trees,
        zombies: game.horde.alive,
        zombiesDrawn: zombies.drawn(),
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
      // a time set by hand is the time the game plays at, too: the dead follow the clock, not the picture
      hour = wrapHour(h);
      game.clock = hour;
      game.night = nightness(hour, game.sunrise, game.sunset);
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
    setSound(on) {
      sounds.setEnabled(on);
    },
    soundOn: () => sounds.enabled(),
    setTouch(input) {
      touch = input;
      if (input) sounds.unlock();
    },
    touchPress,
    findZombies,
    onStats: stats.on,
    onPlayer: playerEvents.on,
    onGame: notices.on,
    onRadar: radarFrames.on,
    onZoomOut: zoomOutEvents.on,
    save: () => {
      const saved = saveGame(game, gameOptions());
      if (tiled) saved.city = { origin, ledger: [...ledger] };
      return saved;
    },
    restart,
    setPaused(p) {
      paused = p && game.status === 'playing';
    },
    togglePause() {
      paused = !paused && game.status === 'playing';
    },
    setSleeping(on) {
      if (on) sounds.hush();
      if (on === sleeping) return;
      sleeping = on;
      if (on) {
        keys.clear();
        triggerHeld = false;
        paused = game.status === 'playing'; // and it stays paused on waking, until you say otherwise
      } else {
        cancelAnimationFrame(frameId);
        last = performance.now();
        frameId = requestAnimationFrame(frame);
      }
    },
    debug: options.debug
      ? {
          spawn(count, distance, hunting) {
            let placed = 0;
            for (let k = 0; k < count * 30 && placed < count; k++) {
              const a = Math.random() * Math.PI * 2;
              const r = distance * (0.75 + Math.random() * 0.5);
              const x = player.x + Math.cos(a) * r;
              const y = player.y + Math.sin(a) * r;
              if (!validSpot(gameWorld, x, y, 0.6)) continue;
              const i = spawnZombie(
                game.horde,
                x,
                y,
                k % 6 === 0 ? ZKind.RUNNER : ZKind.WALKER,
                hunting ? ZState.CHASE : ZState.WANDER,
              );
              if (i < 0) break;
              if (hunting) sendHunting(game.horde, i, 300);
              placed++;
            }
            return placed;
          },
          crowd(count, distance) {
            let placed = 0;
            for (let k = 0; k < count * 30 && placed < count; k++) {
              const a = Math.random() * Math.PI * 2;
              const r = distance * (0.6 + Math.random() * 0.8);
              const x = player.x + Math.cos(a) * r;
              const y = player.y + Math.sin(a) * r;
              if (!validSpot(gameWorld, x, y, 0.6)) continue;
              if (spawnHuman(game.humans, x, y, HState.WALK) < 0) break;
              placed++;
            }
            return placed;
          },
          infect(count) {
            const o = game.outbreak;
            let best = -1;
            let bestD = Infinity;
            for (let b = 0; b < o.count; b++) {
              if (o.healthy[b] < count || Number.isNaN(o.doorX[b])) continue;
              const d = Math.hypot(o.doorX[b] - player.x, o.doorY[b] - player.y);
              if (d < bestD) {
                bestD = d;
                best = b;
              }
            }
            if (best < 0) return false;
            o.healthy[best] -= count;
            o.undead[best] += count;
            return true;
          },
          people() {
            const h = game.humans;
            const all: { x: number; y: number; state: number }[] = [];
            for (let i = 0; i < h.used; i++) {
              if (h.state[i] === HState.FREE) continue;
              all.push({ x: h.x[i], y: h.y[i], state: h.state[i] });
            }
            return all;
          },
          teleport(x, y) {
            game.player = { ...game.player, x, y, vx: 0, vy: 0 };
            player = previous = game.player;
          },
          autoAim(on) {
            debugAutoAim = on;
          },
          hurt(amount) {
            game.health -= amount;
          },
          window() {
            if (!tiled) return null;
            return {
              origin: [...origin] as [number, number],
              tile: tileAt(tiled.index, origin[0], origin[1]),
              buildings: gameWorld.buildings.length,
            };
          },
          scenery() {
            return [...scenery.values()].map((s) => ({ tx: s.tx, ty: s.ty, built: !!s.built }));
          },
          setClock(hour) {
            game.clock = wrapHour(hour);
            game.night = nightness(game.clock, game.sunrise, game.sunset);
          },
          skip(seconds) {
            game.time += seconds;
          },
          setTime(seconds) {
            game.time = seconds;
          },
          goTo(kind) {
            const place = gameWorld.places.find((p) => p.kind === kind);
            if (!place) return false;
            game.player = { ...game.player, x: place.x, y: place.y, vx: 0, vy: 0 };
            player = previous = game.player;
            return true;
          },
          freeze(on) {
            debugFrozen = on;
          },
          wipe() {
            const o = game.outbreak;
            for (let b = 0; b < o.count; b++) {
              o.undead[b] += o.healthy[b] + o.incubating[b];
              o.healthy[b] = 0;
              o.incubating[b] = 0;
            }
            // the street's people turn too (counted in the first building, so nobody is lost)
            const h = game.humans;
            for (let i = 0; i < h.used; i++) {
              if (h.state[i] === HState.FREE) continue;
              h.state[i] = HState.FREE;
              h.freeList[h.freeCount++] = i;
              if (o.count > 0) o.undead[0]++;
            }
            h.alive = 0;
            for (const e of ledger.values()) {
              e.undead += e.healthy + e.incubating;
              e.healthy = 0;
              e.incubating = 0;
            }
            countPopulation(game);
            cityPopulation();
          },
          ledger() {
            let broken = 0;
            let sample: unknown = null;
            for (const [id, e] of ledger) {
              // (a door nobody can get to has no position, and that is not a fault)
              const bad = Object.entries(e).some(
                ([k, v]) => k !== 'x' && k !== 'y' && typeof v === 'number' && !Number.isFinite(v),
              );
              if (!bad) continue;
              broken++;
              sample ??= { id, ...e };
            }
            return { entries: ledger.size, broken, sample };
          },
          probe() {
            return {
              paused,
              frozen: debugFrozen,
              move: [...lastMove] as [number, number],
              keys: [...keys],
              car: game.driving >= 0 ? { ...game.cars[game.driving] } : null,
            };
          },
          summonCar(kind = KIND.SEDAN) {
            const p = game.player;
            const ox = -Math.sin(p.heading) * 3;
            const oy = Math.cos(p.heading) * 3;
            game.cars.push(createCar(p.x + ox, p.y + oy, p.heading, 1, kind));
            return game.cars.length - 1;
          },
          cars() {
            let nearest = Infinity;
            let road = 0;
            for (const c of game.cars) {
              nearest = Math.min(nearest, Math.hypot(c.x - game.player.x, c.y - game.player.y));
              if (onRoad(colliders, c.x, c.y)) road++;
            }
            return { count: game.cars.length, driving: game.driving, nearest, onRoad: road };
          },
          snapshot: () => ({
            status: game.status,
            health: game.health,
            ammo: game.ammo,
            reserve: game.reserve,
            reloading: game.reloading,
            alive: game.horde.alive,
            kills: game.stats.kills,
            shots: game.stats.shots,
            time: game.time,
            clock: game.clock,
            night: game.night,
            x: game.player.x,
            y: game.player.y,
            heading: game.player.heading,
            radarOn: game.radarOn,
            driving: game.driving,
            carSpeed: game.driving >= 0 ? game.cars[game.driving].speed : 0,
            used: game.used.filter(Boolean).length,
            inside: game.inside,
            door: game.inside >= 0 ? game.doors[game.inside] : -1,
            healthy: game.population.healthy,
            bitten: game.population.bitten,
            turned: game.population.zombies,
            streets: game.humans.alive,
            broken: game.outbreak.open.reduce((n, v) => n + v, 0),
          }),
        }
      : undefined,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      sounds.dispose();
      rain.dispose();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerEnd);
      canvas.removeEventListener('pointercancel', onPointerEnd);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      stats.clear();
      playerEvents.clear();
      notices.clear();
      radarFrames.clear();
      zoomOutEvents.clear();
      survivor.dispose();
      pickupMarkers.dispose();
      for (const [key, s] of scenery) dropScenery(key, s);
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
