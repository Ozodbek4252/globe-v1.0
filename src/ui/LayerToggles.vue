<script setup lang="ts">
import type { LayerName, Layers } from '../globe/types';

defineProps<{
  layers: Layers;
  /** night-lights loading message; empty hides it */
  lightsStatus: string;
}>();
defineEmits<{ toggle: [name: LayerName] }>();

const TOGGLES: { name: LayerName; label: string }[] = [
  { name: 'labels', label: 'Labels' },
  { name: 'grid', label: 'Grid' },
  { name: 'cities', label: 'Capitals' },
  { name: 'lights', label: 'Lights' },
  { name: 'spin', label: 'Spin' },
];
</script>

<template>
  <div>
    <p class="label lbl-modes">Layers</p>
    <div class="toggles">
      <button
        v-for="t in TOGGLES"
        :id="'t-' + t.name"
        :key="t.name"
        class="tog"
        :aria-pressed="layers[t.name]"
        @click="$emit('toggle', t.name)"
      >
        {{ t.label }}
      </button>
    </div>
    <p id="lights-status" class="lights-status" :hidden="!lightsStatus">{{ lightsStatus }}</p>
  </div>
</template>

<style>
.toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tog {
  padding: 6px 11px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  font: 500 13.5px var(--f-body);
  cursor: pointer;
}
.tog[aria-pressed='true'] {
  color: var(--ink);
  border-color: #3a4a6a;
  background: rgba(255, 255, 255, 0.05);
}
.tog:focus-visible {
  outline: 2px solid var(--accent);
}
.lights-status {
  margin: 7px 0 0;
  font-size: 12.5px;
  color: var(--muted);
}
</style>
