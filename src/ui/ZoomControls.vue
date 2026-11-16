<script setup lang="ts">
defineEmits<{ zoomIn: []; zoomOut: []; reset: [] }>();
</script>

<template>
  <div class="zoom">
    <button id="zin" aria-label="Zoom in" @click="$emit('zoomIn')">+</button>
    <button id="zout" aria-label="Zoom out" @click="$emit('zoomOut')">−</button>
    <button id="zreset" aria-label="Reset view" style="font-size: 14px" @click="$emit('reset')">
      ⟲
    </button>
  </div>
</template>

<style>
.zoom {
  position: absolute;
  right: max(16px, env(safe-area-inset-right, 0px));
  bottom: 18px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.zoom button {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  font: 500 18px var(--f-mono);
  cursor: pointer;
  backdrop-filter: blur(6px);
}
.zoom button:hover {
  border-color: #3a4a6a;
}
.zoom button:focus-visible {
  outline: 2px solid var(--accent);
}
</style>
