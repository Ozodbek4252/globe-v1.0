<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';
import type { GameNotice, PlayerStatus } from '../city/createCity';
import { fmtClock } from '../lib/format';

const props = defineProps<{ player: PlayerStatus | null }>();
/** `restart`: carry on in the same city (a new survivor after dying); `fresh`: a new city altogether. */
const emit = defineEmits<{ restart: []; fresh: []; close: []; resume: [] }>();

/** A distance as people say it: metres up close, kilometres with one decimal further off. */
const far = (d: number): string =>
  d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;
const resumeButton = useTemplateRef<HTMLButtonElement>('resumeButton');

// when the pause menu opens, put the keyboard on "Resume"
watch(
  () => props.player?.paused,
  (paused) => {
    if (paused) void nextTick(() => resumeButton.value?.focus());
  },
);

type Over = Extract<GameNotice, { type: 'over' }>;

const hits = ref<{ id: number; angle: number }[]>([]);
const vignette = ref(0);
const banner = ref<{
  id: number;
  tone: 'danger' | 'radar';
  title: string;
  sub: string;
  angle: number | null;
} | null>(null);
const toast = ref<{ id: number; text: string } | null>(null);
const over = ref<Over | null>(null);
const announcement = ref('');
const again = useTemplateRef<HTMLButtonElement>('again');

let counter = 0;
const timers = new Set<number>();
function later(fn: () => void, ms: number): void {
  const t = window.setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
}

const clock = fmtClock;
const GUN_NAMES: Record<PlayerStatus['weapon'], string> = {
  pistol: 'Pistol',
  shotgun: 'Shotgun',
  rifle: 'Rifle',
};
const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;
const count = (n: number): string => n.toLocaleString('en-US');

/** The game tells the HUD what happened; the HUD shows it for a moment. */
function push(n: GameNotice): void {
  const id = ++counter;
  switch (n.type) {
    case 'hurt':
      hits.value = [...hits.value.slice(-3), { id, angle: n.angle }];
      vignette.value++;
      later(() => (hits.value = hits.value.filter((h) => h.id !== id)), 1300);
      break;
    case 'pickup':
      toast.value = {
        id,
        text: n.kind === 'ammo' ? '+rounds' : n.kind === 'food' ? '+food' : '+40 health',
      };
      later(() => toast.value?.id === id && (toast.value = null), 1600);
      break;
    case 'loot': {
      const got = [
        n.ammo > 0 ? `+${n.ammo} rounds` : '',
        n.health > 0 ? `+${n.health} health` : '',
        n.food > 0 ? `+${n.food} food` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const text = n.shotgun
        ? `Shotgun and rifle found · press 2 or 3${got ? ' · ' + got : ''}`
        : got || 'Nothing here you can use right now';
      toast.value = { id, text };
      announcement.value = n.shotgun
        ? `${n.place}: a shotgun and a rifle, with rounds. Press 2 or 3 to take one out.`
        : got
          ? `${n.place}: ${got}.`
          : `${n.place}: nothing you can use right now.`;
      later(() => toast.value?.id === id && (toast.value = null), n.shotgun ? 3600 : 2200);
      break;
    }
    case 'weapon':
      break; // the ammo panel already shows it
    case 'enter':
      toast.value = { id, text: 'Safe for now. The door will not hold forever.' };
      announcement.value = `Inside ${n.place}. Rest here, but watch the door.`;
      later(() => toast.value?.id === id && (toast.value = null), 3200);
      break;
    case 'breach':
      banner.value = {
        id,
        tone: 'danger',
        title: 'The door gave way',
        sub: `${n.place} is lost. Run.`,
        angle: null,
      };
      announcement.value = `The door of ${n.place} gave way. The shelter is lost.`;
      later(() => banner.value?.id === id && (banner.value = null), 5500);
      break;
    case 'radar':
      banner.value = {
        id,
        tone: 'radar',
        title: 'Radar online',
        sub: 'The horde is on your scope.',
        angle: null,
      };
      announcement.value = 'Radar online. The horde is now on your scope.';
      later(() => banner.value?.id === id && (banner.value = null), 5000);
      break;
    case 'car':
      if (n.what === 'enter') {
        toast.value = { id, text: 'At the wheel · W S pedal · A D steer · F get out' };
        announcement.value =
          'In the car. W forward, S brake and reverse, A and D steer; F to get out.';
        later(() => toast.value?.id === id && (toast.value = null), 3200);
      } else if (n.what === 'crash') {
        toast.value = { id, text: 'Crash' };
        announcement.value = 'You crashed.';
        later(() => toast.value?.id === id && (toast.value = null), 1400);
      } else if (n.what === 'fuel') {
        banner.value = {
          id,
          tone: 'danger',
          title: 'Out of fuel',
          sub: 'This car is done. Find another.',
          angle: null,
        };
        announcement.value = 'The car is out of fuel.';
        later(() => banner.value?.id === id && (banner.value = null), 4500);
      } else if (n.what === 'wrecked') {
        banner.value = {
          id,
          tone: 'danger',
          title: 'The car is wrecked',
          sub: 'It will not go, and it will not keep them out. Get out.',
          angle: null,
        };
        announcement.value = 'The car is wrecked. Get out.';
        later(() => banner.value?.id === id && (banner.value = null), 5000);
      }
      break;
    case 'restart':
      reset();
      break;
    case 'respawn':
      reset();
      toast.value = { id, text: 'A new survivor. The city is as it was left.' };
      announcement.value = 'A new survivor steps out. The city is as it was left.';
      later(() => toast.value?.id === id && (toast.value = null), 4000);
      break;
    case 'over':
      over.value = n;
      banner.value = null;
      announcement.value = n.fallen
        ? `The city has fallen: nobody is left in it. You lasted ${clock(n.time)}.`
        : `You died after ${clock(n.time)}.`;
      void nextTick(() => again.value?.focus());
      break;
  }
}

/** Forget everything shown (a new game has begun). */
function reset(): void {
  hits.value = [];
  banner.value = null;
  toast.value = null;
  over.value = null;
  announcement.value = '';
}

defineExpose({ push, reset });

onBeforeUnmount(() => {
  for (const t of timers) window.clearTimeout(t);
  timers.clear();
});

watch(
  () => props.player?.phase,
  (phase) => {
    if (phase === 'playing' && over.value) over.value = null;
  },
);

const ammoLow = computed(
  () => !!props.player && props.player.ammo <= 3 && props.player.reserve === 0,
);
const hurting = computed(() => !!props.player && props.player.health < 30);
const survived = computed(() => (over.value ? clock(over.value.time) : ''));
const accuracy = computed(() =>
  over.value && over.value.shots > 0 ? Math.round((over.value.hits / over.value.shots) * 100) : 0,
);
</script>

<template>
  <div class="hud" aria-label="Game status">
    <p class="sr-only" role="status" aria-live="polite">{{ announcement }}</p>

    <div v-if="hurting && player?.phase === 'playing'" class="hud-low" aria-hidden="true"></div>
    <div :key="vignette" class="hud-hurt" :class="{ on: vignette > 0 }" aria-hidden="true"></div>
    <div
      v-for="h in hits"
      :key="h.id"
      class="hud-hit"
      aria-hidden="true"
      :style="{ transform: `rotate(${h.angle}rad)` }"
    >
      <i></i>
    </div>

    <template v-if="player">
      <div class="hud-top">
        <span class="hud-label">Survived</span>
        <span class="hud-clock">{{ clock(player.time) }}</span>
        <span class="hud-sub"
          >{{ plural(player.zombies, 'zombie') }} out there ·
          {{ plural(player.near, 'zombie') }} near · {{ plural(player.kills, 'kill') }}</span
        >
        <span class="hud-sub hud-people"
          >The city: {{ count(player.population.healthy) }} well ·
          {{ count(player.population.bitten) }} bitten ·
          {{ count(player.population.zombies) }} turned</span
        >
        <span v-if="player.objective" class="hud-objective">
          <span
            class="hud-arrow"
            aria-hidden="true"
            :style="{ transform: `rotate(${player.objective.angle}rad)` }"
            >▲</span
          >
          {{ player.objective.text }} · {{ Math.round(player.objective.distance) }} m
          {{ player.objective.compass }}
        </span>
        <span v-if="player.threat" class="hud-objective hud-threat">
          <span
            class="hud-arrow"
            aria-hidden="true"
            :style="{ transform: `rotate(${player.threat.angle}rad)` }"
            >▲</span
          >
          {{ player.threat.text }} · {{ far(player.threat.distance) }} {{ player.threat.compass }}
          <kbd>Z</kbd> look
        </span>
      </div>

      <div v-if="player.inside" class="hud-inside">
        <span class="hud-label">Sheltering in {{ player.inside.name }}</span>
        <span
          class="hud-door"
          :class="{ low: player.inside.door < 0.3 }"
          role="progressbar"
          aria-label="Door"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.round(player.inside.door * 100)"
        >
          <i :style="{ width: Math.round(player.inside.door * 100) + '%' }"></i>
          <span>Door {{ Math.round(player.inside.door * 100) }}%</span>
        </span>
      </div>

      <div v-if="player.prompt && player.camera === 'follow'" class="hud-prompt" role="status">
        <kbd>F</kbd>
        <span>{{ player.prompt.label }}</span>
        <small>{{ player.prompt.name }}</small>
      </div>

      <div
        v-if="banner"
        :key="banner.id"
        class="hud-banner"
        :class="banner.tone"
        role="presentation"
      >
        <span
          v-if="banner.angle !== null"
          class="hud-arrow"
          :style="{ transform: `rotate(${banner.angle}rad)` }"
          >▲</span
        >
        <strong>{{ banner.title }}</strong>
        <span>{{ banner.sub }}</span>
      </div>

      <div v-if="toast" :key="toast.id" class="hud-toast">{{ toast.text }}</div>

      <div v-if="player.camera === 'follow'" class="hud-ammo" :class="{ low: ammoLow }">
        <span class="hud-label"
          >{{ GUN_NAMES[player.weapon]
          }}<template v-if="player.hasShotgun || player.hasRifle">
            · <kbd class="hud-weapon-key">1</kbd
            ><kbd v-if="player.hasShotgun" class="hud-weapon-key">2</kbd
            ><kbd v-if="player.hasRifle" class="hud-weapon-key">3</kbd></template
          ></span
        >
        <span class="hud-rounds"
          ><b>{{ player.ammo }}</b
          ><i> / {{ player.reserve }}</i></span
        >
        <span
          v-if="player.reloading > 0"
          class="hud-reload"
          role="progressbar"
          aria-label="Reloading"
        >
          <i :style="{ width: Math.round(player.reloading * 100) + '%' }"></i>
          <span>Reloading</span>
        </span>
        <span v-else-if="player.meleeReady" class="hud-empty"
          >Out of ammo · click to swing<br /><small>kill zombies for drops</small></span
        >
        <span class="hud-shove" :class="{ ready: player.shove >= 1 }">
          <i :style="{ width: Math.round(Math.min(1, player.shove) * 100) + '%' }"></i>
          <span><kbd>Space</kbd> shove</span>
        </span>
      </div>
    </template>

    <div
      v-if="player?.paused && player.phase === 'playing'"
      class="hud-over"
      role="dialog"
      aria-modal="true"
      aria-label="Paused"
    >
      <div class="hud-card paused">
        <h2>Paused</h2>
        <p>Nothing moves while you are here: not the zombies, not hunger.</p>
        <div class="hud-actions">
          <button ref="resumeButton" class="city-btn primary" type="button" @click="emit('resume')">
            Resume <kbd>Esc</kbd>
          </button>
          <button class="city-btn" type="button" @click="emit('fresh')">New city</button>
          <button class="city-btn" type="button" @click="emit('close')">Back to the globe</button>
        </div>
      </div>
    </div>

    <div
      v-if="over"
      class="hud-over"
      role="dialog"
      aria-modal="true"
      :aria-label="over.fallen ? 'The city has fallen' : 'You died'"
    >
      <div class="hud-card">
        <h2 v-if="over.fallen">The city has fallen</h2>
        <h2 v-else>You survived {{ survived }}</h2>
        <p v-if="over.fallen">
          Not a soul is left in it. You lasted {{ survived }}, and there is nothing here to come
          back to.
        </p>
        <p v-else>
          There was no rescue coming. The city goes on without you; the next survivor steps into it.
        </p>
        <dl>
          <dt>Zombies killed</dt>
          <dd>{{ over.kills }}</dd>
          <dt>Accuracy</dt>
          <dd>{{ accuracy }}% ({{ over.hits }} of {{ over.shots }})</dd>
          <dt>The city, still well</dt>
          <dd>{{ count(over.healthy) }} of {{ count(over.initial) }}</dd>
          <dt>Damage taken</dt>
          <dd>{{ over.damageTaken }}</dd>
        </dl>
        <div class="hud-actions">
          <button
            v-if="!over.fallen"
            ref="again"
            class="city-btn primary"
            type="button"
            @click="emit('restart')"
          >
            Next survivor <kbd>Enter</kbd>
          </button>
          <button
            v-if="over.fallen"
            ref="again"
            class="city-btn primary"
            type="button"
            @click="emit('fresh')"
          >
            New city <kbd>Enter</kbd>
          </button>
          <button v-else class="city-btn" type="button" @click="emit('fresh')">New city</button>
          <button class="city-btn" type="button" @click="emit('close')">Back to the globe</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
.hud {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* ---- being hurt */
.hud-hurt {
  position: absolute;
  inset: 0;
  opacity: 0;
  background: radial-gradient(ellipse at center, transparent 45%, rgba(190, 20, 20, 0.55) 100%);
}
.hud-hurt.on {
  animation: hud-hurt 0.7s ease-out;
}
@keyframes hud-hurt {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
.hud-low {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at center, transparent 55%, rgba(150, 10, 10, 0.4) 100%);
  animation: hud-pulse 1.6s ease-in-out infinite;
}
@keyframes hud-pulse {
  50% {
    opacity: 0.45;
  }
}
.hud-hit {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  animation: hud-fade 1.3s ease-out forwards;
}
.hud-hit i {
  position: absolute;
  left: -70px;
  top: -190px;
  width: 140px;
  height: 36px;
  border-radius: 50% 50% 0 0 / 100% 100% 0 0;
  background: radial-gradient(ellipse at 50% 0%, rgba(230, 40, 30, 0.95), rgba(230, 40, 30, 0) 72%);
}
@keyframes hud-fade {
  to {
    opacity: 0;
  }
}

/* ---- the clock */
.hud-top {
  position: absolute;
  top: 74px;
  left: 50%;
  transform: translateX(-50%);
  display: grid;
  justify-items: center;
  gap: 1px;
  text-align: center;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.85);
}
.hud-label {
  font: 600 11px var(--f-display);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--muted);
}
.hud-clock {
  font: 600 34px var(--f-mono);
  font-variant-numeric: tabular-nums;
  line-height: 1.05;
  color: var(--ink);
}
.hud-sub {
  font-size: 12px;
  color: var(--muted);
}
.hud-people {
  color: #b8f0c0;
}
.hud-objective {
  margin-top: 4px;
  padding: 3px 12px;
  border-radius: 999px;
  border: 1px solid rgba(74, 168, 255, 0.5);
  background: rgba(8, 20, 36, 0.7);
  font: 500 12px var(--f-mono);
  color: #bcd9ff;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.hud-objective .hud-arrow {
  display: inline-block;
  color: #4aa8ff;
  font-size: 12px;
  line-height: 1;
}

/* ---- hiding indoors */
.hud-inside {
  position: absolute;
  left: 50%;
  bottom: 196px;
  transform: translateX(-50%);
  display: grid;
  justify-items: center;
  gap: 6px;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.85);
}
.hud-door {
  position: relative;
  display: block;
  width: min(300px, 70vw);
  height: 18px;
  border-radius: 9px;
  border: 1px solid rgba(53, 208, 192, 0.6);
  background: var(--panel);
  overflow: hidden;
}
.hud-door i {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, #1f8f84, #35d0c0);
  transition: width 0.3s linear;
}
.hud-door.low i {
  background: #e23a2e;
}
.hud-door span {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font: 600 11px var(--f-mono);
  letter-spacing: 0.06em;
}

/* ---- the door you are standing at */
.hud-prompt {
  position: absolute;
  left: 50%;
  bottom: 122px;
  transform: translateX(-50%);
  display: grid;
  grid-template-columns: auto auto;
  align-items: center;
  column-gap: 10px;
  padding: 8px 16px;
  border-radius: 12px;
  border: 1px solid rgba(240, 181, 74, 0.7);
  background: rgba(20, 16, 8, 0.82);
  backdrop-filter: blur(6px);
  animation: hud-in 0.2s ease-out;
}
.hud-prompt kbd {
  grid-row: span 2;
  padding: 3px 9px;
  border-radius: 6px;
  border: 1px solid #6a5a2a;
  background: #2a2412;
  font: 600 15px var(--f-mono);
  color: #ffe9a8;
}
.hud-prompt span {
  font: 600 15px var(--f-display);
  letter-spacing: 0.04em;
}
.hud-prompt small {
  font-size: 11.5px;
  color: var(--muted);
}

/* ---- announcements */
.hud-banner {
  position: absolute;
  top: 224px;
  left: 50%;
  transform: translateX(-50%);
  display: grid;
  justify-items: center;
  gap: 2px;
  padding: 10px 22px;
  border-radius: 10px;
  border: 1px solid rgba(214, 70, 58, 0.55);
  background: rgba(20, 8, 8, 0.72);
  backdrop-filter: blur(6px);
  text-align: center;
  animation: hud-in 0.35s ease-out;
  max-width: min(520px, 90vw);
}
.hud-banner.radar {
  border-color: rgba(74, 168, 255, 0.6);
  background: rgba(6, 16, 30, 0.78);
}
.hud-banner strong {
  font: 700 20px var(--f-display);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.hud-banner span {
  font-size: 13px;
  color: var(--muted);
}
.hud-banner .hud-arrow {
  color: #e8483c;
  font-size: 18px;
  line-height: 1;
}
@keyframes hud-in {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(-8px);
  }
}
.hud-toast {
  position: absolute;
  left: 50%;
  bottom: 178px;
  transform: translateX(-50%);
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(10, 16, 28, 0.8);
  border: 1px solid var(--line);
  font: 600 13px var(--f-mono);
  color: #ffd27a;
  animation: hud-rise 1.6s ease-out forwards;
}
@keyframes hud-rise {
  to {
    opacity: 0;
    transform: translateX(-50%) translateY(-18px);
  }
}

/* ---- the pistol */
.hud-threat {
  color: #ffb9ad;
}
.hud-threat kbd {
  margin-left: 6px;
}

.hud-ammo {
  position: absolute;
  right: 16px;
  bottom: 40px;
  display: grid;
  justify-items: end;
  gap: 4px;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.85);
}
.hud-rounds {
  font-family: var(--f-mono);
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.hud-rounds b {
  font-size: 40px;
  font-weight: 600;
  color: var(--ink);
}
.hud-rounds i {
  font-style: normal;
  font-size: 18px;
}
.hud-ammo.low .hud-rounds b {
  color: #e8483c;
}
.hud-reload,
.hud-shove {
  position: relative;
  display: block;
  width: 150px;
  height: 14px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--panel);
  overflow: hidden;
}
.hud-reload i,
.hud-shove i {
  position: absolute;
  inset: 0 auto 0 0;
}
.hud-reload i {
  background: #6f86b8;
}
.hud-shove i {
  background: #5b6a86;
}
.hud-shove.ready i {
  background: #5ad17a;
}
.hud-reload span,
.hud-shove span {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font: 500 10px var(--f-mono);
  letter-spacing: 0.08em;
  color: var(--ink);
}
.hud-shove kbd {
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid #2b3956;
  background: #0f1729;
  font: 500 9px var(--f-mono);
}
.hud-weapon-key {
  margin-left: 3px;
  padding: 0 5px;
  border-radius: 3px;
  border: 1px solid #2b3956;
  background: #0f1729;
  font: 500 10px var(--f-mono);
  color: var(--ink);
}
.hud-empty {
  font: 600 12px var(--f-mono);
  color: #e8483c;
  letter-spacing: 0.1em;
}

/* ---- the end */
.hud-over {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(3, 5, 10, 0.62);
  backdrop-filter: blur(3px);
  pointer-events: auto;
}
.hud-card {
  width: min(420px, 100%);
  padding: 26px 28px;
  border-radius: 14px;
  border: 1px solid rgba(214, 70, 58, 0.6);
  background: rgba(14, 8, 10, 0.92);
  text-align: center;
  animation: hud-in-card 0.4s ease-out;
}
.hud-card.paused {
  border-color: rgba(120, 150, 210, 0.6);
  background: rgba(8, 12, 22, 0.92);
}
.hud-card h2 {
  margin: 0 0 6px;
  font: 700 30px var(--f-display);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.hud-card p {
  margin: 0 0 16px;
  color: var(--muted);
}
.hud-card dl {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 18px;
  margin: 0 0 20px;
  text-align: left;
  font-size: 14px;
}
.hud-card dt {
  color: var(--muted);
}
.hud-card dd {
  margin: 0;
  font: 500 14px var(--f-mono);
  text-align: right;
}
.hud-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
}
.hud-actions .primary {
  border-color: var(--accent);
  background: rgba(240, 181, 74, 0.14);
}
.hud-actions kbd {
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid #2b3956;
  background: #0f1729;
  font: 500 11px var(--f-mono);
}
@keyframes hud-in-card {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
}

/* Less motion: no pulsing, sliding or flashing. A hit still shows, as a slow, soft fade. */
@keyframes hud-hurt-soft {
  from {
    opacity: 0.3;
  }
  to {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .hud-low,
  .hud-banner,
  .hud-toast,
  .hud-card {
    animation: none;
  }
  .hud-hurt.on {
    animation: hud-hurt-soft 1.4s ease-out forwards;
  }
  .hud-hit {
    animation-duration: 2.2s;
  }
  .hud-low {
    opacity: 0.35;
  }
}

@media (max-width: 760px) {
  .hud-top {
    top: 118px;
  }
  .hud-clock {
    font-size: 28px;
  }
  .hud-banner {
    top: 240px;
  }
  .hud-ammo {
    bottom: 56px;
  }
}
</style>
