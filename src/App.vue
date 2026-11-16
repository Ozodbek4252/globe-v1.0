<script setup lang="ts">
import { computed, useTemplateRef } from 'vue';
import { useGlobe } from './composables/useGlobe';
import { fmtLatLon } from './lib/format';
import { countryNames } from './map/search';
import CountryCard from './ui/CountryCard.vue';
import CountrySearch from './ui/CountrySearch.vue';
import DayNightClock from './ui/DayNightClock.vue';
import HoverTip from './ui/HoverTip.vue';
import LayerToggles from './ui/LayerToggles.vue';
import MapLegend from './ui/MapLegend.vue';
import ModeDropdown from './ui/ModeDropdown.vue';
import PicksList from './ui/PicksList.vue';
import ZoomControls from './ui/ZoomControls.vue';

const host = useTemplateRef<HTMLElement>('host');
const g = useGlobe(host);

const names = computed(() => (g.world.value ? countryNames(g.world.value.countries) : []));

const coords = computed(
  () =>
    `CENTER ${fmtLatLon(g.view.value.lat, g.view.value.lon)} · ${g.view.value.zoom.toFixed(1)}×`,
);
</script>

<template>
  <div class="app">
    <aside>
      <div class="brand">
        <h1>Atlas Globe</h1>
        <p>Drag to turn, scroll or pinch to zoom, click a country for details.</p>
        <div id="coords" class="coords">{{ coords }}</div>
      </div>
      <CountrySearch :names="names" @search="g.searchCountry" />
      <PicksList
        :items="g.pickItems.value"
        :selected="g.selected.value"
        @select="g.selectCountry"
        @remove="g.togglePick"
        @clear="g.clearPicks"
      />
      <ModeDropdown :model-value="g.modeId.value" @update:model-value="g.setMode" />
      <MapLegend :legend="g.mode.value.legend" />
      <LayerToggles
        :layers="g.layers"
        :lights-status="g.lightsStatus.value"
        @toggle="(name) => g.setLayer(name, !g.layers[name])"
      />
      <div class="foot">
        Data: Natural Earth 1:110m, 1:50m when zoomed in (country figures are 2019 estimates). Night
        lights: NASA Black Marble 2016. Borders are simplified and shown as Natural Earth draws
        them.
      </div>
    </aside>
    <main id="stage">
      <div ref="host" class="globe-host"></div>
      <DayNightClock :active="g.modeId.value === 'daynight'" />
      <ZoomControls @zoom-in="g.zoomIn" @zoom-out="g.zoomOut" @reset="g.resetView" />
      <CountryCard :info="g.card.value" @close="g.closeCard" />
      <p v-if="g.loadError.value" class="load-error" role="alert">{{ g.loadError.value }}</p>
    </main>
  </div>
  <HoverTip :tip="g.tip.value" />
</template>

<style>
.brand h1 {
  font-family: var(--f-display);
  font-weight: 700;
  font-size: 26px;
  letter-spacing: 0.06em;
  margin: 0;
  line-height: 1;
}
.brand p {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 13.5px;
}
.coords {
  font-family: var(--f-mono);
  font-size: 11.5px;
  color: var(--faint);
  margin-top: 8px;
  font-variant-numeric: tabular-nums;
}
.foot {
  margin-top: auto;
  font-size: 12px;
  color: var(--faint);
  line-height: 1.4;
}
.load-error {
  position: absolute;
  inset: 50% 24px auto;
  margin: 0;
  text-align: center;
  color: var(--muted);
}

@media (max-width: 760px) {
  .brand,
  .foot {
    display: none;
  }
}
</style>
