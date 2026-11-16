<script setup lang="ts">
import type { PickItem } from '../composables/useGlobe';

defineProps<{
  items: PickItem[];
  /** code of the country the info card shows */
  selected: string | null;
}>();
defineEmits<{
  /** show this country on the card and fly there */
  select: [code: string];
  remove: [code: string];
  clear: [];
}>();
</script>

<template>
  <div id="picks" class="picks">
    <p v-if="!items.length" class="empty">
      Click countries on the globe to select them. Click again to remove.
    </p>
    <template v-else>
      <div class="ph">
        <span>{{ items.length }} selected</span>
        <button class="clear" type="button" @click="$emit('clear')">Clear all</button>
      </div>
      <div class="chips">
        <span
          v-for="item in items"
          :key="item.code"
          class="chip"
          :class="{ on: item.code === selected }"
        >
          <button type="button" class="cn" @click="$emit('select', item.code)">
            {{ item.name }}
          </button>
          <button
            type="button"
            class="cx"
            :aria-label="'Remove ' + item.name"
            @click="$emit('remove', item.code)"
          >
            ×
          </button>
        </span>
      </div>
    </template>
  </div>
</template>

<style>
.picks .empty {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.35;
}
.picks .ph {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 7px;
  font-family: var(--f-display);
  font-size: 12px;
  letter-spacing: 0.14em;
  color: var(--muted);
  text-transform: uppercase;
}
.picks .clear {
  background: none;
  border: 0;
  color: var(--accent);
  font: 500 13px var(--f-body);
  cursor: pointer;
  padding: 0;
  letter-spacing: 0;
  text-transform: none;
}
.picks .chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  max-height: 120px;
  overflow-y: auto;
}
.chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: rgba(240, 181, 74, 0.14);
  border: 1px solid rgba(240, 181, 74, 0.4);
}
.chip.on {
  background: var(--accent);
}
.chip.on button {
  color: var(--accent-ink);
}
.chip button {
  background: none;
  border: 0;
  color: var(--ink);
  cursor: pointer;
  font: 500 13px var(--f-body);
}
.chip .cn {
  padding: 4px 2px 4px 10px;
}
.chip .cx {
  padding: 4px 9px 4px 5px;
  font-size: 15px;
  line-height: 1;
  color: var(--muted);
}
.chip button:focus-visible,
.picks .clear:focus-visible {
  outline: 2px solid var(--accent);
  border-radius: 999px;
}
</style>
