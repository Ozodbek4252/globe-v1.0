<script setup lang="ts">
import { ref } from 'vue';

defineProps<{ names: string[] }>();
const emit = defineEmits<{ search: [query: string] }>();

const query = ref('');
</script>

<template>
  <div class="search">
    <label class="label" for="q">Find a country</label>
    <input
      id="q"
      v-model="query"
      list="countries"
      placeholder="e.g. Uzbekistan, Brazil…"
      autocomplete="off"
      @change="emit('search', query)"
      @keydown.enter="emit('search', query)"
    />
    <datalist id="countries">
      <option v-for="name in names" :key="name" :value="name"></option>
    </datalist>
  </div>
</template>

<style>
.search {
  position: relative;
}
.search input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--space-2);
  color: var(--ink);
  font: 500 14.5px var(--f-body);
}
.search input:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>
