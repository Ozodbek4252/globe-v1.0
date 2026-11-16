<script setup lang="ts">
import { markRaw, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef } from 'vue';
import type { CityScene, CityStats, CityViewpoint } from '../city/createCity';

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

let scene: CityScene | null = null;
let disposed = false;
let stopStats: (() => void) | null = null;

/**
 * Optional deep link: ?hour=17.4&view=x,y,yaw,pitch,distance  (metres east/north of the centre,
 * degrees, metres). Handy for sharing a view or reproducing a screenshot.
 */
function linkOptions(): { hour?: number; view?: CityViewpoint } {
  const q = new URLSearchParams(location.search);
  const out: { hour?: number; view?: CityViewpoint } = {};
  const h = Number(q.get('hour'));
  if (q.has('hour') && Number.isFinite(h)) out.hour = Math.min(24, Math.max(0, h));
  const v = (q.get('view') ?? '').split(',').map(Number);
  if (v.length === 5 && v.every(Number.isFinite)) {
    out.view = { x: v[0], y: v[1], yaw: v[2], pitch: v[3], distance: v[4] };
  }
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
    ready.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'The city could not be loaded.';
  }
});

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('keydown', onKey);
  stopStats?.();
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

      <ul class="city-help" aria-label="Controls">
        <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or drag: move</li>
        <li><kbd>Q</kbd><kbd>E</kbd> or right-drag: turn</li>
        <li><kbd>R</kbd><kbd>F</kbd>: tilt &nbsp; <kbd>Wheel</kbd>: zoom</li>
        <li><kbd>T</kbd> TV tower &nbsp; <kbd>H</kbd> home &nbsp; <kbd>Esc</kbd> globe</li>
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
  .city-credit {
    left: 16px;
    right: auto;
  }
}
</style>
