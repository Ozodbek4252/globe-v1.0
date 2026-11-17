<script setup lang="ts">
import { markRaw, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef } from 'vue';
import type {
  CameraMode,
  CityScene,
  CityStats,
  CityViewpoint,
  PlayerStatus,
} from '../city/createCity';

const props = defineProps<{ cityId: string; title: string }>();
const emit = defineEmits<{ close: [] }>();

const host = useTemplateRef<HTMLElement>('host');
const root = useTemplateRef<HTMLElement>('root');
const progress = ref(0);
const status = ref('Loading map data');
const error = ref('');
const ready = ref(false);
const hour = ref(17.4);
const sunElevation = ref(0);
const stats = shallowRef<CityStats | null>(null);
const showStats = ref(false);
const player = shallowRef<PlayerStatus | null>(null);

let scene: CityScene | null = null;
let disposed = false;
let stopStats: (() => void) | null = null;
let stopPlayer: (() => void) | null = null;

/**
 * Optional deep link, handy for sharing a spot or reproducing a screenshot. Metres are east/north of
 * the city centre; angles are degrees.
 *   ?hour=17.4                        time of day
 *   &view=x,y,yaw,pitch,distance      start with the free camera here
 *   &player=x,y                       put the survivor near this point
 *   &camera=free|follow               which camera to start with
 */
function linkOptions(): {
  hour?: number;
  view?: CityViewpoint;
  camera?: CameraMode;
  player?: { x: number; y: number };
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
    emit('close');
  } else if (e.key.toLowerCase() === 'p' && !(e.target instanceof HTMLInputElement)) {
    showStats.value = !showStats.value;
  }
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
    sunElevation.value = Math.round(created.sunElevation());
    stopStats = created.onStats((s) => (stats.value = s));
    stopPlayer = created.onPlayer((s) => (player.value = s));
    ready.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'The city could not be loaded.';
  }
});

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('keydown', onKey);
  stopStats?.();
  stopPlayer?.();
  scene?.destroy();
  scene = null;
});
</script>

<template>
  <div ref="root" class="cityview" role="dialog" aria-label="3D city view" tabindex="-1">
    <div ref="host" class="city-host"></div>

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
          <li><kbd>Q</kbd><kbd>E</kbd> or drag: turn camera &nbsp; <kbd>Wheel</kbd> zoom</li>
          <li><kbd>L</kbd> flashlight &nbsp; <kbd>V</kbd> free camera</li>
          <li><kbd>H</kbd> recentre &nbsp; <kbd>Esc</kbd> globe</li>
        </template>
        <template v-else>
          <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or drag: move camera</li>
          <li><kbd>Q</kbd><kbd>E</kbd> or right-drag: turn &nbsp; <kbd>R</kbd><kbd>F</kbd> tilt</li>
          <li><kbd>T</kbd> TV tower &nbsp; <kbd>V</kbd> back to survivor</li>
          <li><kbd>H</kbd> home &nbsp; <kbd>Esc</kbd> globe</li>
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
