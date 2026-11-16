<script setup lang="ts">
import type { TipInfo } from '../composables/useGlobe';

defineProps<{ tip: TipInfo | null }>();
</script>

<template>
  <div
    id="tip"
    class="tip"
    :hidden="!tip"
    :style="tip ? { left: tip.x + 'px', top: tip.y + 'px' } : undefined"
  >
    <template v-if="tip">
      <b>{{ tip.name }}</b><span>{{ tip.value }}</span>
    </template>
  </div>
</template>

<style>
.tip {
  position: fixed;
  pointer-events: none;
  z-index: 20;
  padding: 6px 10px;
  border-radius: 7px;
  background: rgba(8, 12, 22, 0.94);
  border: 1px solid var(--line);
  font-size: 13.5px;
  white-space: nowrap;
  transform: translate(14px, 14px);
}
.tip b {
  font-weight: 700;
}
.tip span {
  color: var(--muted);
  font-family: var(--f-mono);
  font-size: 12px;
  margin-left: 6px;
}
</style>
