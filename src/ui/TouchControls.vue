<script setup lang="ts">
// Two thumbsticks and a few buttons over the city, for phones and tablets. The left stick walks the
// survivor (at the wheel it is the pedal and the wheel), the right one aims and, pushed far, fires.
// The component only reports what the thumbs do; the scene turns it into game input.
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import type { PlayerStatus } from '../city/createCity';
import { deflection, STICK, stickVector, type TouchAction, type TouchInput } from '../city/touch';

const props = defineProps<{ player: PlayerStatus | null }>();
const emit = defineEmits<{ input: [input: TouchInput]; press: [action: TouchAction] }>();

interface Stick {
  pointer: number | null;
  /** Where the finger went down (the stick's centre for this touch), in client pixels. */
  cx: number;
  cy: number;
  value: [number, number];
}
const left = reactive<Stick>({ pointer: null, cx: 0, cy: 0, value: [0, 0] });
const right = reactive<Stick>({ pointer: null, cx: 0, cy: 0, value: [0, 0] });
const sprint = ref(false);

function report(): void {
  const aimOn = deflection(right.value) > 0;
  const aim: [number, number] | null = aimOn
    ? [right.value[0] / deflection(right.value), right.value[1] / deflection(right.value)]
    : null;
  emit('input', {
    move: [left.value[0], left.value[1]],
    aim,
    fire: deflection(right.value) >= STICK.fireFrom,
    sprint: sprint.value,
  });
}

function down(stick: Stick, e: PointerEvent): void {
  if (stick.pointer !== null) return;
  stick.pointer = e.pointerId;
  stick.cx = e.clientX;
  stick.cy = e.clientY;
  stick.value = [0, 0];
  try {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  } catch {
    // a synthetic event (tests) has no pointer to capture; the stick works the same
  }
  report();
}
function move(stick: Stick, e: PointerEvent): void {
  if (stick.pointer !== e.pointerId) return;
  stick.value = stickVector(e.clientX - stick.cx, e.clientY - stick.cy);
  report();
}
function up(stick: Stick, e: PointerEvent): void {
  if (stick.pointer !== e.pointerId) return;
  stick.pointer = null;
  stick.value = [0, 0];
  report();
}
function knob(stick: Stick): Record<string, string> {
  const r = STICK.radius * 0.75;
  return {
    transform: `translate(${stick.value[0] * r}px, ${-stick.value[1] * r}px)`,
  };
}
function toggleSprint(): void {
  sprint.value = !sprint.value;
  report();
}
function press(action: TouchAction): void {
  emit('press', action);
}

const driving = computed(() => props.player?.car !== null && props.player?.car !== undefined);
const gun = computed(() => {
  const w = props.player?.weapon ?? 'pistol';
  return w === 'pistol' ? 'Pistol' : w === 'shotgun' ? 'Shotgun' : 'Rifle';
});
const moreGuns = computed(() => Boolean(props.player?.hasShotgun || props.player?.hasRifle));

onBeforeUnmount(() => {
  left.value = [0, 0];
  right.value = [0, 0];
  sprint.value = false;
  report();
});
</script>

<template>
  <div class="touch" aria-label="Touch controls">
    <div
      class="stick left"
      :class="{ live: left.pointer !== null }"
      aria-label="Move"
      @pointerdown.prevent="down(left, $event)"
      @pointermove="move(left, $event)"
      @pointerup="up(left, $event)"
      @pointercancel="up(left, $event)"
    >
      <i class="knob" :style="knob(left)"></i>
      <span class="hint">{{ driving ? 'drive' : 'walk' }}</span>
    </div>

    <div
      class="stick right"
      :class="{ live: right.pointer !== null, firing: deflection(right.value) >= STICK.fireFrom }"
      aria-label="Aim and fire"
      @pointerdown.prevent="down(right, $event)"
      @pointermove="move(right, $event)"
      @pointerup="up(right, $event)"
      @pointercancel="up(right, $event)"
    >
      <i class="knob" :style="knob(right)"></i>
      <span class="hint">aim · push to fire</span>
    </div>

    <div class="buttons">
      <button
        v-if="player?.prompt"
        class="tbtn primary wide"
        type="button"
        @pointerdown.prevent="press('interact')"
      >
        {{ player.prompt.label }}
      </button>
      <button
        v-if="!driving"
        class="tbtn"
        type="button"
        aria-label="Reload"
        @pointerdown.prevent="press('reload')"
      >
        Reload
      </button>
      <button
        v-if="!driving"
        class="tbtn"
        type="button"
        aria-label="Shove"
        @pointerdown.prevent="press('shove')"
      >
        Shove
      </button>
      <button
        v-if="!driving"
        class="tbtn"
        :class="{ on: sprint }"
        type="button"
        :aria-pressed="sprint"
        @pointerdown.prevent="toggleSprint"
      >
        Run
      </button>
      <button
        v-if="!driving && moreGuns"
        class="tbtn"
        type="button"
        aria-label="Next gun"
        @pointerdown.prevent="press('weapon')"
      >
        {{ gun }} ↻
      </button>
      <button
        class="tbtn"
        :class="{ on: player?.flashlight }"
        type="button"
        aria-label="Flashlight"
        @pointerdown.prevent="press('flashlight')"
      >
        Light
      </button>
    </div>
  </div>
</template>

<style scoped>
.touch {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 6;
  font-family: var(--mono, ui-monospace, monospace);
  user-select: none;
  -webkit-user-select: none;
}
.stick {
  position: absolute;
  bottom: max(18px, env(safe-area-inset-bottom));
  width: 136px;
  height: 136px;
  border-radius: 50%;
  background: rgba(10, 14, 22, 0.42);
  border: 1px solid rgba(255, 255, 255, 0.22);
  pointer-events: auto;
  touch-action: none;
  display: grid;
  place-items: center;
}
.stick.left {
  left: max(18px, env(safe-area-inset-left));
}
.stick.right {
  right: max(18px, env(safe-area-inset-right));
}
.stick.live {
  border-color: rgba(255, 255, 255, 0.6);
}
.stick.firing {
  border-color: #ffb347;
  box-shadow: 0 0 18px rgba(255, 179, 71, 0.45);
}
.knob {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.78);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
  will-change: transform;
}
.hint {
  position: absolute;
  bottom: -20px;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
  text-shadow: 0 1px 2px #000;
  white-space: nowrap;
}
.buttons {
  position: absolute;
  right: max(18px, env(safe-area-inset-right));
  bottom: calc(max(18px, env(safe-area-inset-bottom)) + 160px);
  display: grid;
  grid-template-columns: repeat(2, 76px);
  gap: 10px;
  pointer-events: auto;
}
.tbtn {
  min-height: 52px;
  padding: 0 10px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: rgba(10, 14, 22, 0.6);
  color: #fff;
  font: inherit;
  font-size: 14px;
  touch-action: none;
}
.tbtn.on {
  background: rgba(255, 255, 255, 0.85);
  color: #0a0e16;
}
.tbtn.primary {
  background: #ffb347;
  color: #1a1206;
  border-color: #ffb347;
  font-weight: 700;
}
.tbtn.wide {
  grid-column: 1 / -1;
}
@media (max-height: 420px) {
  .stick {
    width: 112px;
    height: 112px;
  }
  .knob {
    width: 46px;
    height: 46px;
  }
  .buttons {
    bottom: calc(max(18px, env(safe-area-inset-bottom)) + 130px);
    gap: 8px;
  }
  .tbtn {
    min-height: 44px;
  }
}
</style>
