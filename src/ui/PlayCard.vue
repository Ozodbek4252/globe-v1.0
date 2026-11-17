<script setup lang="ts">
import { computed, useTemplateRef } from 'vue';
import { fmtClock } from '../lib/format';
import type { Outcome, Playable } from '../map/playable';

/** `inPlay`: seconds survived in a game still going at this place (it can be continued), or null. */
const props = defineProps<{
  place: Playable | null;
  outcome: Outcome | undefined;
  inPlay?: number | null;
}>();
defineEmits<{ play: []; close: [] }>();

const playButton = useTemplateRef<HTMLButtonElement>('playButton');
defineExpose({ focus: () => playButton.value?.focus() });

const fallen = computed(() => props.outcome?.fallen === true);
const people = computed(() =>
  props.place ? Math.round(props.place.density).toLocaleString('en-US') : '',
);
</script>

<template>
  <div
    v-if="place"
    id="play-card"
    class="card play-card"
    role="group"
    :aria-label="`Play ${place.name}`"
  >
    <div class="top">
      <div>
        <h2>{{ place.name }}</h2>
        <div class="formal">
          {{ place.country }} · {{ place.kind === 'village' ? 'village' : 'city' }}
        </div>
      </div>
      <button class="x" aria-label="Close" @click="$emit('close')">×</button>
    </div>
    <p v-if="place.blurb" class="blurb">{{ place.blurb }}</p>
    <dl>
      <dt>People</dt>
      <dd>{{ people }} per km²</dd>
      <template v-if="inPlay !== null && inPlay !== undefined">
        <dt>Now</dt>
        <dd class="going">in play · {{ fmtClock(inPlay) }}</dd>
      </template>
      <dt>Best</dt>
      <dd>{{ outcome ? fmtClock(outcome.best) : 'not played yet' }}</dd>
      <template v-if="outcome">
        <dt>Last time</dt>
        <dd :class="{ lost: fallen }">{{ fallen ? 'fell · lights out' : 'still standing' }}</dd>
      </template>
    </dl>
    <button id="enter-city" ref="playButton" class="enter" type="button" @click="$emit('play')">
      <span>{{
        inPlay !== null && inPlay !== undefined ? 'Continue' : fallen ? 'Try again' : 'Play here'
      }}</span>
      <small>A real map from OpenStreetMap. Stay alive as long as you can.</small>
    </button>
  </div>
</template>

<style>
.play-card {
  top: auto;
  right: auto;
  bottom: 16px;
  left: max(16px, env(safe-area-inset-left, 0px));
}
.play-card .blurb {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 13.5px;
  line-height: 1.4;
}
.play-card dd.going {
  color: #ffd27a;
}
.play-card dd.lost {
  color: #ff8b7d;
}
.play-card .enter {
  margin-top: 14px;
}
@media (max-width: 760px) {
  .play-card {
    bottom: 64px;
  }
}
</style>
