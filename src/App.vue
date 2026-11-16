<script setup lang="ts">
import { markRaw, onBeforeUnmount, onMounted, shallowRef, useTemplateRef } from 'vue';
import { createGlobe } from './globe/createGlobe';
import type { GlobeApi } from './globe/types';
import { loadWorld } from './map/data';

// Temporary harness for porting step 5.2: the globe and an empty sidebar, no controls yet.
const host = useTemplateRef<HTMLElement>('host');
const globe = shallowRef<GlobeApi | null>(null);

onMounted(async () => {
  const world = markRaw(await loadWorld());
  if (host.value) globe.value = createGlobe(host.value, { world });
});
onBeforeUnmount(() => globe.value?.destroy());
</script>

<template>
  <div class="app">
    <aside></aside>
    <main id="stage"><div ref="host" class="globe-host"></div></main>
  </div>
</template>
