<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { fmtLatLon } from '../lib/format';
import { sunPosition } from '../lib/sun';

/** UTC time and the sub-solar point, shown only in Day & night mode. Refreshes every minute. */
const props = defineProps<{ active: boolean }>();

const now = ref(new Date());
watch(
  () => props.active,
  (active) => {
    if (active) now.value = new Date();
  },
);
const timer = setInterval(() => {
  if (props.active) now.value = new Date();
}, 60000);
onBeforeUnmount(() => clearInterval(timer));

const text = computed(() => {
  const [lon, lat] = sunPosition(now.value);
  return `${now.value.toISOString().slice(11, 16)} UTC · sun over ${fmtLatLon(lat, lon)}`;
});
</script>

<template>
  <div id="clock" class="clock" :hidden="!active">{{ active ? text : '' }}</div>
</template>

<style>
.clock {
  position: absolute;
  left: 18px;
  top: 16px;
  z-index: 2;
  font-family: var(--f-mono);
  font-size: 12.5px;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--line);
  padding: 7px 10px;
  border-radius: 8px;
}

@media (max-width: 760px) {
  .clock {
    top: auto;
    bottom: 18px;
    left: 16px;
  }
}
</style>
