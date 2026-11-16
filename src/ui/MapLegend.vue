<script setup lang="ts">
import type { Legend } from '../map/modes';

defineProps<{ legend: Legend }>();
</script>

<template>
  <div id="legend" class="legend" aria-live="polite">
    <template v-if="legend.kind === 'bar'">
      <div class="bar" :style="{ background: legend.gradient }"></div>
      <div class="ticks">
        <span v-for="tick in legend.ticks" :key="tick">{{ tick }}</span>
      </div>
      <div v-if="legend.note" class="note">{{ legend.note }}</div>
    </template>
    <template v-else-if="legend.kind === 'swatches'">
      <div class="sw">
        <span v-for="item in legend.items" :key="item.label"
          ><i
            :style="{
              background: item.color,
              borderRadius: item.round ? '50%' : undefined,
              boxShadow: item.outline ? `inset 0 0 0 1.5px ${item.outline}` : undefined,
            }"
          ></i
          >{{ item.label }}</span
        >
      </div>
      <div v-if="legend.note" class="note">{{ legend.note }}</div>
    </template>
    <div v-else class="note">{{ legend.note }}</div>
  </div>
</template>

<style>
.legend {
  min-height: 54px;
}
.legend .bar {
  height: 10px;
  border-radius: 3px;
}
.legend .ticks {
  display: flex;
  justify-content: space-between;
  font-family: var(--f-mono);
  font-size: 11px;
  color: var(--muted);
  margin-top: 5px;
  font-variant-numeric: tabular-nums;
}
.legend .sw {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px 10px;
  font-size: 13px;
  color: var(--ink);
}
.legend .sw span {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.legend .sw i {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex: none;
}
.legend .note {
  font-size: 12.5px;
  color: var(--muted);
  margin-top: 7px;
  line-height: 1.35;
}
</style>
