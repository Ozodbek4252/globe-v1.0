<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';
import type { GameNotice, PlayerStatus } from '../city/createCity';

const props = defineProps<{ player: PlayerStatus | null }>();
const emit = defineEmits<{ restart: []; close: []; resume: [] }>();
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
  tone: 'wave' | 'rescue' | 'radar';
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

const minutes = (seconds: number): string => {
  const total = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;

/** The game tells the HUD what happened; the HUD shows it for a moment. */
function push(n: GameNotice): void {
  const id = ++counter;
  switch (n.type) {
    case 'hurt':
      hits.value = [...hits.value.slice(-3), { id, angle: n.angle }];
      vignette.value++;
      later(() => (hits.value = hits.value.filter((h) => h.id !== id)), 1300);
      break;
    case 'wave':
      banner.value = {
        id,
        tone: 'wave',
        title: `Wave ${n.number}`,
        sub: `${plural(n.size, 'zombie')} coming from the ${n.compass}`,
        angle: n.angle,
      };
      announcement.value = `Wave ${n.number}: ${plural(n.size, 'zombie')} coming from the ${n.compass}.`;
      later(() => banner.value?.id === id && (banner.value = null), 6000);
      break;
    case 'rescue':
      banner.value = {
        id,
        tone: 'rescue',
        title: 'Helicopter inbound',
        sub: `Hold out for ${n.seconds} seconds. The noise is drawing them all.`,
        angle: null,
      };
      announcement.value = `Helicopter inbound. Hold out for ${n.seconds} seconds.`;
      later(() => banner.value?.id === id && (banner.value = null), 7000);
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
        ? `Shotgun found · press 2${got ? ' · ' + got : ''}`
        : got || 'Nothing here you can use right now';
      toast.value = { id, text };
      announcement.value = n.shotgun
        ? `${n.place}: a shotgun and shells. Press 2 to take it out.`
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
    case 'breach': {
      const people =
        n.lost > 0 ? ` ${plural(n.lost, 'person', 'people')} behind it did not survive.` : '';
      banner.value = {
        id,
        tone: 'wave',
        title: 'The door gave way',
        sub: `${n.place} is lost.${people}`,
        angle: null,
      };
      announcement.value = `The door of ${n.place} gave way. The shelter is lost.${people}`;
      later(() => banner.value?.id === id && (banner.value = null), 5500);
      break;
    }
    case 'recruit':
      toast.value = {
        id,
        text:
          n.following === 1
            ? 'A survivor joins you'
            : `A survivor joins you · ${n.following} with you`,
      };
      announcement.value = `A survivor joins you. ${plural(n.following, 'survivor')} with you.`;
      later(() => toast.value?.id === id && (toast.value = null), 2400);
      break;
    case 'sheltered':
      toast.value = { id, text: `${plural(n.count, 'survivor')} safe inside` };
      announcement.value = `${plural(n.count, 'survivor')} went inside ${n.place} with you.`;
      later(() => toast.value?.id === id && (toast.value = null), 2800);
      break;
    case 'civilianDown':
      toast.value = { id, text: 'Someone did not make it' };
      announcement.value = 'A survivor was killed.';
      hits.value = hits.value.slice(-3);
      later(() => toast.value?.id === id && (toast.value = null), 2400);
      break;
    case 'radar':
      banner.value = {
        id,
        tone: 'radar',
        title: 'Radar online',
        sub: 'The horde is on your scope, and so is the direction of the next wave.',
        angle: null,
      };
      announcement.value = 'Radar online. The horde and the next wave are now on your scope.';
      later(() => banner.value?.id === id && (banner.value = null), 6000);
      break;
    case 'restart':
      reset();
      break;
    case 'over':
      over.value = n;
      banner.value = null;
      announcement.value = n.won ? 'Rescued. You survived.' : 'You died.';
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
const survived = computed(() => (over.value ? minutes(over.value.time) : ''));
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
      <div class="hud-top" :class="{ inbound: player.inbound }">
        <span class="hud-label">{{ player.inbound ? 'Helicopter landing in' : 'Rescue in' }}</span>
        <span class="hud-clock">{{ minutes(player.rescueIn) }}</span>
        <span class="hud-sub"
          >Wave {{ player.wave }} · {{ plural(player.zombies, 'zombie') }} out there ·
          {{ plural(player.near, 'zombie') }} near · {{ plural(player.kills, 'kill') }}</span
        >
        <span v-if="player.survivors.total > 0" class="hud-sub hud-people"
          >Survivors: {{ player.survivors.following }} with you ·
          {{ player.survivors.sheltered }} inside · {{ player.survivors.hiding }} hiding ·
          {{ player.survivors.lost }} lost</span
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
          >{{ player.weapon === 'shotgun' ? 'Shotgun' : 'Pistol'
          }}<template v-if="player.hasShotgun">
            · <kbd class="hud-weapon-key">1</kbd><kbd class="hud-weapon-key">2</kbd></template
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
          <button class="city-btn" type="button" @click="emit('restart')">Start again</button>
          <button class="city-btn" type="button" @click="emit('close')">Back to the globe</button>
        </div>
      </div>
    </div>

    <div
      v-if="over"
      class="hud-over"
      role="dialog"
      aria-modal="true"
      :aria-label="over.won ? 'Rescued' : 'You died'"
    >
      <div class="hud-card" :class="{ won: over.won }">
        <h2>{{ over.won ? 'Rescued' : 'You did not make it' }}</h2>
        <p>
          {{
            over.won
              ? 'The helicopter lifts you out of the city.'
              : 'The horde got you before the rescue arrived.'
          }}
        </p>
        <dl>
          <dt>Survived</dt>
          <dd>{{ survived }}</dd>
          <dt>Zombies killed</dt>
          <dd>{{ over.kills }}</dd>
          <dt>Accuracy</dt>
          <dd>{{ accuracy }}% ({{ over.hits }} of {{ over.shots }})</dd>
          <template v-if="over.total > 0">
            <dt>Survivors saved</dt>
            <dd>{{ over.saved }} of {{ over.total }}</dd>
          </template>
          <dt>Waves faced</dt>
          <dd>{{ over.waves }}</dd>
          <dt>Damage taken</dt>
          <dd>{{ over.damageTaken }}</dd>
        </dl>
        <div class="hud-actions">
          <button ref="again" class="city-btn primary" type="button" @click="emit('restart')">
            Play again <kbd>Enter</kbd>
          </button>
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
.hud-top.inbound .hud-clock {
  color: #ffd27a;
  animation: hud-pulse 1s ease-in-out infinite;
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
.hud-banner.rescue {
  border-color: rgba(255, 210, 122, 0.6);
  background: rgba(24, 18, 6, 0.74);
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
.hud-card.won {
  border-color: rgba(255, 210, 122, 0.65);
  background: rgba(16, 14, 8, 0.92);
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
  .hud-top.inbound .hud-clock,
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
