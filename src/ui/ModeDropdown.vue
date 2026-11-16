<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';
import { modeById, MODES, type ModeId } from '../map/modes';

/** Accessible listbox for the map mode: arrow keys, Home/End, Enter/Space, Escape. */
const model = defineModel<ModeId>({ required: true });

const root = useTemplateRef<HTMLElement>('root');
const button = useTemplateRef<HTMLButtonElement>('button');
const list = useTemplateRef<HTMLUListElement>('list');
const items = useTemplateRef<HTMLLIElement[]>('items');

const open = ref(false);
const activeIdx = ref(0);
const listStyle = ref<Record<string, string>>({});

const current = computed(() => modeById(model.value));

function setActive(i: number): void {
  activeIdx.value = (i + MODES.length) % MODES.length;
  items.value?.[activeIdx.value]?.scrollIntoView({ block: 'nearest' });
}

async function openList(): Promise<void> {
  open.value = true;
  // Phone: the list opens upward from the button, above the bottom sheet.
  if (matchMedia('(max-width: 760px)').matches && button.value) {
    const r = button.value.getBoundingClientRect();
    listStyle.value = {
      left: r.left + 'px',
      right: innerWidth - r.right + 'px',
      bottom: innerHeight - r.top + 4 + 'px',
    };
  } else {
    listStyle.value = {};
  }
  await nextTick();
  setActive(MODES.findIndex((m) => m.id === model.value));
  list.value?.focus();
}

function closeList(refocus: boolean): void {
  if (!open.value) return;
  open.value = false;
  if (refocus) button.value?.focus();
}

function choose(id: ModeId): void {
  model.value = id;
  closeList(true);
}

function onButtonKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    void openList();
  }
}

function onListKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setActive(activeIdx.value + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setActive(activeIdx.value - 1);
  } else if (e.key === 'Home') {
    e.preventDefault();
    setActive(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    setActive(MODES.length - 1);
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const mode = MODES[activeIdx.value];
    if (mode) choose(mode.id);
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    closeList(e.key === 'Escape');
  }
}

function onDocumentPointerDown(e: PointerEvent): void {
  if (!(e.target instanceof Node) || !root.value?.contains(e.target)) closeList(false);
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown));
</script>

<template>
  <div>
    <p class="label lbl-modes">Map mode</p>
    <div ref="root" class="dd">
      <button
        id="mode-btn"
        ref="button"
        class="dd-btn"
        type="button"
        aria-haspopup="listbox"
        :aria-expanded="open"
        aria-controls="modes"
        aria-label="Map mode"
        @click="open ? closeList(true) : openList()"
        @keydown="onButtonKey"
      >
        <span class="ico" :style="{ background: current.ico }"></span>
        <span
          ><span class="nm">{{ current.name }}</span
          ><small>{{ current.sub }}</small></span
        >
        <span class="chev"></span>
      </button>
      <ul
        id="modes"
        ref="list"
        class="modes"
        role="listbox"
        aria-label="Map mode"
        tabindex="-1"
        :hidden="!open"
        :style="listStyle"
        :aria-activedescendant="'mode-' + MODES[activeIdx]?.id"
        @keydown="onListKey"
      >
        <li
          v-for="(m, i) in MODES"
          :id="'mode-' + m.id"
          ref="items"
          :key="m.id"
          class="mode"
          :class="{ active: i === activeIdx }"
          role="option"
          :aria-selected="m.id === model"
          @click="choose(m.id)"
          @mousemove="setActive(i)"
        >
          <span class="ico" :style="{ background: m.ico }"></span>
          <span
            ><span class="nm">{{ m.name }}</span
            ><small>{{ m.sub }}</small></span
          >
        </li>
      </ul>
    </div>
  </div>
</template>

<style>
.dd {
  position: relative;
}
.dd-btn {
  width: 100%;
  display: grid;
  grid-template-columns: 22px 1fr 14px;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--space-2);
  color: var(--ink);
  text-align: left;
  cursor: pointer;
  font: 500 15px var(--f-body);
}
.dd-btn:hover {
  border-color: #3a4a6a;
}
.dd-btn:focus-visible {
  outline: 2px solid var(--accent);
}
.dd-btn small {
  display: block;
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 400;
}
.dd-btn .chev {
  width: 8px;
  height: 8px;
  border-right: 2px solid var(--muted);
  border-bottom: 2px solid var(--muted);
  transform: rotate(45deg) translate(-2px, -2px);
  transition: transform 0.15s;
}
.dd-btn[aria-expanded='true'] .chev {
  transform: rotate(-135deg) translate(-2px, -2px);
}
.dd-btn .ico,
.mode .ico {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
}
.modes {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  z-index: 30;
  margin: 0;
  padding: 4px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: min(500px, 72vh);
  overflow-y: auto;
  background: #0f1729;
  border: 1px solid #2b3956;
  border-radius: 10px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
}
.modes:focus {
  outline: none;
}
.mode {
  display: grid;
  grid-template-columns: 22px 1fr;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: none;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
  font: 500 15px var(--f-body);
}
.mode small {
  display: block;
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 400;
}
.mode:hover {
  background: rgba(255, 255, 255, 0.04);
}
.mode.active,
.mode:focus-visible {
  outline: none;
  background: rgba(255, 255, 255, 0.07);
}
.mode[aria-selected='true'] {
  border-color: rgba(240, 181, 74, 0.45);
  background: rgba(240, 181, 74, 0.08);
}

@media (max-width: 760px) {
  .modes {
    position: fixed;
    top: auto;
    max-height: 55vh;
  }
  .dd-btn small,
  .mode small {
    display: none;
  }
}
</style>
