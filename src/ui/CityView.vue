<script setup lang="ts">
import { markRaw, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef } from 'vue';
import type {
  CameraMode,
  CityScene,
  CityStats,
  CityViewpoint,
  GameNotice,
  GameSetup,
  PlayerStatus,
  RadarFrame,
} from '../city/createCity';
import GameHud from './GameHud.vue';
import RadarScope from './RadarScope.vue';

const props = defineProps<{ cityId: string; title: string }>();
const emit = defineEmits<{ close: [] }>();

const host = useTemplateRef<HTMLElement>('host');
const root = useTemplateRef<HTMLElement>('root');
/** What GameHud exposes (spelled out, so the linter does not have to resolve a .vue type). */
interface HudHandle {
  push(notice: GameNotice): void;
  reset(): void;
}
const hud = useTemplateRef<HudHandle>('hud');
const progress = ref(0);
const status = ref('Loading map data');
const error = ref('');
const ready = ref(false);
const hour = ref(17.4);
const sunElevation = ref(0);
const stats = shallowRef<CityStats | null>(null);
const showStats = ref(false);
const player = shallowRef<PlayerStatus | null>(null);
const radar = shallowRef<RadarFrame | null>(null);

let scene: CityScene | null = null;
let disposed = false;
let stopStats: (() => void) | null = null;
let stopPlayer: (() => void) | null = null;
let stopGame: (() => void) | null = null;
let stopRadar: (() => void) | null = null;

/**
 * Optional deep link, handy for sharing a spot or reproducing a screenshot. Metres are east/north of
 * the city centre; angles are degrees.
 *   ?hour=17.4                        time of day
 *   &view=x,y,yaw,pitch,distance      start with the free camera here
 *   &player=x,y                       put the survivor near this point
 *   &camera=free|follow               which camera to start with
 *   &seed=123                         replay the same game (same outbreak, zombies and supplies)
 *   &zombies=0                        groups of zombies in the streets at the start (default 0)
 *   &patients=3                       where the outbreak starts: people turned in this many buildings (0: a calm city)
 *   &density=7700                     people per square kilometre (default: Tashkent's)
 */
function linkOptions(): {
  hour?: number;
  view?: CityViewpoint;
  camera?: CameraMode;
  player?: { x: number; y: number };
  game?: GameSetup;
  debug?: boolean;
} {
  const q = new URLSearchParams(location.search);
  const out: ReturnType<typeof linkOptions> = {};
  const h = Number(q.get('hour'));
  if (q.has('hour') && Number.isFinite(h)) out.hour = Math.min(24, Math.max(0, h));
  const v = (q.get('view') ?? '').split(',').map(Number);
  if (v.length === 5 && v.every(Number.isFinite)) {
    out.view = { x: v[0], y: v[1], yaw: v[2], pitch: v[3], distance: v[4] };
  }
  const p = (q.get('player') ?? '').split(',').map(Number);
  if (p.length === 2 && p.every(Number.isFinite)) out.player = { x: p[0], y: p[1] };
  const cam = q.get('camera');
  if (cam === 'free' || cam === 'follow') out.camera = cam;
  const game: GameSetup = {};
  const number = (key: string): number | undefined => {
    const v = q.has(key) ? Number(q.get(key)) : Number.NaN;
    return Number.isFinite(v) ? v : undefined;
  };
  game.seed = number('seed');
  const zombies = number('zombies');
  if (zombies !== undefined && zombies >= 0) game.zombies = Math.min(300, Math.floor(zombies));
  const patients = number('patients');
  if (patients !== undefined && patients >= 0) game.patients = Math.min(40, Math.floor(patients));
  const density = number('density');
  if (density !== undefined && density > 0) game.density = Math.min(30000, density);
  out.game = game;
  if (q.get('debug') === '1') out.debug = true;
  return out;
}

const clock = (h: number): string => {
  const total = Math.round(h * 60) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

function onTime(): void {
  if (!scene) return;
  scene.setHour(hour.value);
  sunElevation.value = Math.round(scene.sunElevation());
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    // Esc opens the pause menu while playing (and closes it); once the game is over it leaves
    if (scene && player.value?.phase === 'playing') scene.togglePause();
    else emit('close');
  } else if (e.key === 'F2') {
    e.preventDefault();
    showStats.value = !showStats.value;
  }
}

function setPaused(paused: boolean): void {
  scene?.setPaused(paused);
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  root.value?.focus();
  try {
    // Three.js and the city code are only downloaded when the player enters the city.
    const [{ loadCity }, { createCityScene }] = await Promise.all([
      import('../city/load'),
      import('../city/createCity'),
    ]);
    const data = markRaw(await loadCity(props.cityId));
    if (disposed || !host.value) return;
    const link = linkOptions();
    if (link.hour !== undefined) hour.value = link.hour;
    const created = await createCityScene(host.value, data, {
      hour: hour.value,
      view: link.view,
      camera: link.camera,
      player: link.player,
      game: link.game,
      debug: link.debug,
      onProgress: (fraction, label) => {
        progress.value = fraction;
        status.value = label;
      },
    });
    if (disposed) {
      created.destroy();
      return;
    }
    scene = created;
    // with ?debug=1 the scene is reachable from the console as window.__city, for staging scenes
    if (link.debug) (window as unknown as { __city?: CityScene }).__city = created;
    sunElevation.value = Math.round(created.sunElevation());
    stopStats = created.onStats((s) => (stats.value = s));
    stopPlayer = created.onPlayer((s) => (player.value = s));
    stopGame = created.onGame((n) => {
      hud.value?.push(n);
    });
    stopRadar = created.onRadar((f) => {
      radar.value = f;
    });
    ready.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'The city could not be loaded.';
  }
});

function restart(): void {
  scene?.restart(); // the scene announces it, and the HUD clears itself
}

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('keydown', onKey);
  stopStats?.();
  stopPlayer?.();
  stopGame?.();
  stopRadar?.();
  scene?.destroy();
  scene = null;
  delete (window as unknown as { __city?: CityScene }).__city;
});
</script>

<template>
  <div ref="root" class="cityview" role="dialog" aria-label="3D city view" tabindex="-1">
    <div
      ref="host"
      class="city-host"
      :class="{ aiming: player?.camera === 'follow' && player?.phase === 'playing' }"
    ></div>

    <div v-if="!ready && !error" class="city-loading" role="status">
      <h2>{{ title }}</h2>
      <div class="bar"><i :style="{ width: Math.round(progress * 100) + '%' }"></i></div>
      <p>{{ status }}…</p>
    </div>

    <div v-if="error" class="city-loading" role="alert">
      <h2>Could not open {{ title }}</h2>
      <p>{{ error }}</p>
      <button class="city-btn" type="button" @click="emit('close')">Back to the globe</button>
    </div>

    <template v-if="ready">
      <RadarScope :frame="radar" />
      <GameHud
        ref="hud"
        :player="player"
        @restart="restart"
        @close="emit('close')"
        @resume="setPaused(false)"
      />
      <button
        v-if="player?.phase === 'playing'"
        class="city-btn city-pause"
        type="button"
        :aria-label="player.paused ? 'Resume' : 'Pause'"
        @click="setPaused(!player.paused)"
      >
        {{ player.paused ? '▶ Resume' : '⏸ Pause' }}
      </button>

      <button
        class="city-btn city-back"
        type="button"
        aria-label="Back to the globe"
        @click="emit('close')"
      >
        ← Globe
      </button>

      <header class="city-title">
        <h2>{{ title }}</h2>
        <p>Real streets and buildings from OpenStreetMap</p>
      </header>

      <div class="city-time">
        <label for="city-hour">Time of day</label>
        <input
          id="city-hour"
          v-model.number="hour"
          type="range"
          min="0"
          max="24"
          step="0.05"
          @input="onTime"
        />
        <output for="city-hour"
          >{{ clock(hour) }} · sun {{ sunElevation >= 0 ? '+' : '' }}{{ sunElevation }}°</output
        >
      </div>

      <div v-if="player" class="city-status">
        <p class="city-mode" aria-live="polite">
          {{ player.camera === 'follow' ? 'Following the survivor' : 'Free camera' }}
          <span>· <kbd>V</kbd> switch</span>
        </p>
        <div
          v-if="player.camera === 'follow'"
          class="health"
          :class="{ low: player.health < 30 }"
          role="progressbar"
          aria-label="Health"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.round(player.health)"
        >
          <i :style="{ width: Math.round(player.health) + '%' }"></i>
          <span>{{ Math.round(player.health) }}</span>
        </div>
        <div
          v-if="player.camera === 'follow'"
          class="food"
          :class="{ low: player.food < 25, empty: player.food <= 0 }"
          role="progressbar"
          aria-label="Food"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.round(player.food)"
        >
          <i :style="{ width: Math.round(player.food) + '%' }"></i>
          <span>{{ player.food <= 0 ? 'Starving' : player.food < 25 ? 'Hungry' : 'Food' }}</span>
        </div>
        <div
          v-if="player.camera === 'follow'"
          class="stamina"
          :class="{ tired: player.exhausted, running: player.sprinting }"
          role="progressbar"
          aria-label="Stamina"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.round(player.stamina * 100)"
        >
          <i :style="{ width: Math.round(player.stamina * 100) + '%' }"></i>
          <span>{{
            player.exhausted ? 'Out of breath' : player.sprinting ? 'Running' : 'Stamina'
          }}</span>
        </div>
      </div>

      <ul class="city-help" aria-label="Controls">
        <template v-if="!player || player.camera === 'follow'">
          <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk &nbsp; <kbd>Shift</kbd> run</li>
          <li>
            <kbd>Mouse</kbd> aim &nbsp; <kbd>Click</kbd> fire &nbsp; <kbd>R</kbd> reload &nbsp;
            <kbd>1</kbd><kbd>2</kbd> gun
          </li>
          <li>
            <kbd>Space</kbd> shove &nbsp; <kbd>F</kbd> use a door &nbsp; <kbd>L</kbd> flashlight
          </li>
          <li><kbd>Q</kbd><kbd>E</kbd> or right-drag: turn camera &nbsp; <kbd>Wheel</kbd> zoom</li>
          <li>
            <kbd>V</kbd> free camera &nbsp; <kbd>H</kbd> recentre &nbsp; <kbd>P</kbd>
            <kbd>Esc</kbd> pause
          </li>
        </template>
        <template v-else>
          <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or drag: move camera</li>
          <li><kbd>Q</kbd><kbd>E</kbd> or right-drag: turn &nbsp; <kbd>R</kbd><kbd>F</kbd> tilt</li>
          <li><kbd>T</kbd> TV tower &nbsp; <kbd>V</kbd> back to survivor</li>
          <li><kbd>H</kbd> home &nbsp; <kbd>P</kbd> <kbd>Esc</kbd> pause</li>
        </template>
      </ul>

      <p class="city-credit">
        Map data ©
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener"
          >OpenStreetMap contributors</a
        >
      </p>

      <dl v-if="showStats && stats" class="city-stats">
        <dt>FPS</dt>
        <dd>{{ Math.round(stats.fps) }}</dd>
        <dt>Draw calls</dt>
        <dd>{{ stats.drawCalls }}</dd>
        <dt>Triangles</dt>
        <dd>{{ stats.triangles.toLocaleString() }}</dd>
        <dt>Buildings</dt>
        <dd>{{ stats.buildings.toLocaleString() }}</dd>
        <dt>Trees</dt>
        <dd>{{ stats.trees.toLocaleString() }}</dd>
        <dt>Zombies</dt>
        <dd>{{ stats.zombies }} ({{ stats.zombiesDrawn }} drawn)</dd>
      </dl>
    </template>
  </div>
</template>

<style>
.cityview {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: #05070d;
  color: var(--ink);
  outline: none;
}
.city-host {
  position: absolute;
  inset: 0;
}
/* with the survivor in hand, the mouse is a gun sight: the 3D reticle replaces the arrow */
.city-host.aiming {
  cursor: crosshair;
}
.city-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 14px;
  text-align: center;
  padding: 24px;
}
.city-loading h2 {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 34px;
  letter-spacing: 0.08em;
  margin: 0;
}
.city-loading p {
  margin: 0;
  color: var(--muted);
  max-width: 36ch;
}
.city-loading .bar {
  width: min(320px, 70vw);
  height: 4px;
  border-radius: 2px;
  background: var(--line);
  overflow: hidden;
}
.city-loading .bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.2s;
}

.city-btn {
  padding: 8px 14px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  font: 500 14px var(--f-body);
  cursor: pointer;
  backdrop-filter: blur(6px);
}
.city-btn:hover {
  border-color: #3a4a6a;
}
.city-btn:focus-visible,
.city-time input:focus-visible,
.city-credit a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.city-back {
  position: absolute;
  top: 16px;
  left: 16px;
}
.city-pause {
  position: absolute;
  top: 16px;
  left: 104px;
  z-index: 2;
}

.city-title {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  pointer-events: none;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.7);
}
.city-title h2 {
  margin: 0;
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 26px;
  letter-spacing: 0.1em;
}
.city-title p {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: var(--muted);
}

.city-time {
  position: absolute;
  top: 16px;
  right: 16px;
  display: grid;
  gap: 6px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--panel);
  backdrop-filter: blur(6px);
  min-width: 220px;
}
.city-time label {
  font-family: var(--f-display);
  font-size: 12px;
  letter-spacing: 0.14em;
  color: var(--muted);
}
.city-time input {
  width: 100%;
  accent-color: var(--accent);
}
.city-time output {
  font-family: var(--f-mono);
  font-size: 12px;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}

.city-help {
  position: absolute;
  left: 16px;
  bottom: 16px;
  margin: 0;
  padding: 10px 14px;
  list-style: none;
  display: grid;
  gap: 5px;
  font-size: 12.5px;
  color: var(--muted);
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--panel);
  backdrop-filter: blur(6px);
}
.city-help kbd {
  display: inline-block;
  min-width: 18px;
  margin-right: 3px;
  padding: 1px 5px;
  border-radius: 5px;
  border: 1px solid #2b3956;
  background: #0f1729;
  color: var(--ink);
  font: 500 11px var(--f-mono);
  text-align: center;
}

.city-status {
  position: absolute;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  display: grid;
  justify-items: center;
  gap: 8px;
  pointer-events: none;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.8);
}
.city-mode {
  margin: 0;
  font-size: 12.5px;
  color: var(--muted);
}
.city-mode kbd {
  display: inline-block;
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid #2b3956;
  background: #0f1729;
  color: var(--ink);
  font: 500 11px var(--f-mono);
}
.health {
  position: relative;
  width: min(260px, 60vw);
  height: 18px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--panel);
  overflow: hidden;
  backdrop-filter: blur(6px);
}
.health i {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, #8e2b25, #d4443a);
  transition: width 0.15s linear;
}
.health.low i {
  background: #e23a2e;
}
.health span {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font: 600 12px var(--f-mono);
  color: var(--ink);
}
.food {
  position: relative;
  width: min(260px, 60vw);
  height: 14px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--panel);
  overflow: hidden;
  backdrop-filter: blur(6px);
}
.food i {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, #3f78c4, #6ab8ff);
  transition: width 0.3s linear;
}
.food.low i {
  background: #c9843a;
}
.food.empty i {
  background: #c9574d;
}
.food span {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font: 500 10px var(--f-mono);
  letter-spacing: 0.08em;
  color: var(--ink);
}
.stamina {
  position: relative;
  width: min(260px, 60vw);
  height: 16px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  overflow: hidden;
  backdrop-filter: blur(6px);
}
.stamina i {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, #c98a2a, var(--accent));
  transition: width 0.1s linear;
}
.stamina.running i {
  background: linear-gradient(90deg, #e2a250, #ffd27a);
}
.stamina.tired i {
  background: #c9574d;
}
.stamina span {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font: 500 11px var(--f-mono);
  letter-spacing: 0.06em;
  color: var(--ink);
  mix-blend-mode: normal;
}

.city-credit {
  position: absolute;
  right: 16px;
  bottom: 12px;
  margin: 0;
  font-size: 11.5px;
  color: var(--muted);
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.8);
}
.city-credit a {
  color: var(--ink);
}

.city-stats {
  position: absolute;
  top: 96px;
  right: 16px;
  margin: 0;
  padding: 8px 12px;
  display: grid;
  grid-template-columns: auto auto;
  gap: 3px 14px;
  border-radius: 8px;
  background: var(--panel);
  border: 1px solid var(--line);
  font: 500 12px var(--f-mono);
}
.city-stats dt {
  color: var(--muted);
}
.city-stats dd {
  margin: 0;
  text-align: right;
}

@media (max-width: 760px) {
  .city-title {
    top: 68px;
    left: 16px;
    transform: none;
    text-align: left;
  }
  .city-title h2 {
    font-size: 22px;
  }
  .city-time {
    top: 16px;
    right: 16px;
    min-width: 0;
    width: 200px;
    padding: 8px 12px;
  }
  .city-stats {
    top: 124px;
  }
  .city-help {
    display: none;
  }
  .city-status {
    bottom: 44px;
  }
  .city-credit {
    left: 16px;
    right: auto;
  }
}
</style>
