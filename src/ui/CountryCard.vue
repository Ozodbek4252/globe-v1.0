<script setup lang="ts">
import type { CardInfo } from '../map/info';

defineProps<{ info: CardInfo | null }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <div id="card" class="card" :hidden="!info">
    <template v-if="info">
      <div class="top">
        <div>
          <h2>{{ info.title }}</h2>
          <div class="formal">{{ info.subtitle }}</div>
        </div>
        <button class="x" aria-label="Close" @click="$emit('close')">×</button>
      </div>
      <dl>
        <template v-for="[label, value] in info.rows" :key="label">
          <dt>{{ label }}</dt>
          <dd>{{ value }}</dd>
        </template>
      </dl>
      <div class="src">Natural Earth, 2019 estimates. Area measured from simplified borders.</div>
    </template>
  </div>
</template>

<style>
.card {
  position: absolute;
  top: 16px;
  right: max(16px, env(safe-area-inset-right, 0px));
  z-index: 2;
  width: 300px;
  max-width: calc(100% - 32px);
  box-sizing: border-box;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px 16px 14px;
  backdrop-filter: blur(10px);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
}
.card .top {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 10px;
}
.card h2 {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 22px;
  letter-spacing: 0.03em;
  margin: 0;
  line-height: 1.1;
  text-wrap: balance;
}
.card .formal {
  color: var(--muted);
  font-size: 13px;
  margin-top: 3px;
}
.card .x {
  background: none;
  border: 0;
  color: var(--muted);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
.card .x:focus-visible {
  outline: 2px solid var(--accent);
}
.card dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 14px;
  margin: 14px 0 0;
  font-size: 14px;
}
.card dt {
  color: var(--muted);
}
.card dd {
  margin: 0;
  text-align: right;
  font-family: var(--f-mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.card .src {
  margin-top: 12px;
  font-size: 11.5px;
  color: var(--faint);
}

@media (max-width: 760px) {
  .card {
    width: auto;
    left: 16px;
    right: 16px;
    padding: 12px 14px;
  }
  .card dl {
    grid-template-columns: auto 1fr auto 1fr;
    font-size: 13px;
    gap: 4px 10px;
  }
}
</style>
