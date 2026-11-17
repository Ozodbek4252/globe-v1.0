<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import { useGlobe } from './composables/useGlobe';
import { usePlay } from './composables/usePlay';
import { fmtClock, fmtLatLon } from './lib/format';
import { cityHash, parseCityHash } from './map/playable';
import { countryNames } from './map/search';
import CityView from './ui/CityView.vue';
import CountryCard from './ui/CountryCard.vue';
import CountrySearch from './ui/CountrySearch.vue';
import DayNightClock from './ui/DayNightClock.vue';
import HoverTip from './ui/HoverTip.vue';
import LayerToggles from './ui/LayerToggles.vue';
import MapLegend from './ui/MapLegend.vue';
import ModeDropdown from './ui/ModeDropdown.vue';
import PicksList from './ui/PicksList.vue';
import PlayCard from './ui/PlayCard.vue';
import ZoomControls from './ui/ZoomControls.vue';

const host = useTemplateRef<HTMLElement>('host');
const g = useGlobe(host);
const play = usePlay();

const names = computed(() => (g.world.value ? countryNames(g.world.value.countries) : []));

const coords = computed(
  () =>
    `CENTER ${fmtLatLon(g.view.value.lat, g.view.value.lon)} · ${g.view.value.zoom.toFixed(1)}×`,
);

// The places you can play are pins on the globe (and a list), and what has happened in each shows on
// both: a place you died in has fallen, and its lights go out.
watch(play.markers, (markers) => g.setMarkers(markers), { immediate: true });
watch(play.chosenId, (id) => g.setChosenMarker(id), { immediate: true });

/** Open a place's card; from the list or a pin, the globe turns to show it. */
function choose(id: string | null): void {
  play.choose(id);
  const place = play.chosen.value;
  if (place) g.flyToPoint(place.lat, place.lon, 4);
}
const stopPinClicks = g.onMarkerClick(choose);
onBeforeUnmount(stopPinClicks);

// The wheel joins the two views: zoom into a pin as far as the globe goes and you drop into the
// place; zoom out of a place as far as the city goes and you are back over it on the globe.
const stopZoomIns = g.onZoomIntoMarker((id) => {
  play.choose(id);
  openCity(id);
});
onBeforeUnmount(stopZoomIns);
async function zoomedOut(): Promise<void> {
  const place = cityPlace.value;
  await closeCity();
  if (place) g.flyToPoint(place.lat, place.lon, 12);
}

const playCard = useTemplateRef<{ focus: () => void }>('playCard');

/** What the list says under a place's name: where it is, and how it went. */
function remark(id: string, country: string): string {
  const going = inPlay(id);
  if (going !== null) return `${country} · in play · ${fmtClock(going)}`;
  const outcome = play.outcomes.value[id];
  if (!outcome) return country;
  return `${country} · best ${fmtClock(outcome.best)}${outcome.fallen ? ' · fallen' : ''}`;
}

// The 3D city covers the whole window. `#city=<id>` in the address opens it directly (`#city` alone
// is Tashkent, the first place there was). Leaving for the globe does not end the game: the one city
// you were in stays alive, asleep, and going back to it continues where you left off (paused). Only
// opening another place lets it go (a death does not: the next survivor steps into the same city).
const mountedId = ref<string | null>(null); // the city that exists
const cityId = ref<string | null>(null); // the city that is showing (null: the globe)
const cityOver = ref(false);
const cityTime = ref(0);
const cityPlace = computed(() => play.places.value.find((p) => p.id === mountedId.value) ?? null);
/**
 * Seconds survived in a game that is still going at this place (alive here, or saved in this browser
 * from before), or null if there is none.
 */
const inPlay = (id: string): number | null => {
  if (mountedId.value === id && !cityOver.value && cityTime.value > 0) return cityTime.value;
  return play.outcomes.value[id]?.inPlay ?? null;
};
const setHash = (hash: string): void =>
  history.replaceState(null, '', location.pathname + location.search + hash);

function openCity(id: string): void {
  // going back to a fallen place lights it up: someone is in there again
  if (play.outcomes.value[id]?.fallen) play.reclaim(id);
  if (mountedId.value !== id) {
    mountedId.value = id;
    cityOver.value = false;
    cityTime.value = 0;
  }
  cityId.value = id;
  setHash(cityHash(id));
}
async function closeCity(): Promise<void> {
  cityId.value = null;
  setHash('');
  await nextTick();
  playCard.value?.focus();
}
const syncFromHash = (): void => {
  const id = parseCityHash(location.hash);
  if (id) openCity(id);
  else void closeCity();
};
watch(cityId, (id) => g.setPaused(id !== null), { immediate: true });
onMounted(() => {
  syncFromHash();
  window.addEventListener('hashchange', syncFromHash);
});
onBeforeUnmount(() => window.removeEventListener('hashchange', syncFromHash));
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
      <div>
        <p class="label lbl-modes">Play</p>
        <ul class="places" aria-label="Places to play">
          <li v-for="p in play.places.value" :key="p.id">
            <button
              type="button"
              class="place"
              :class="{
                on: p.id === play.chosenId.value,
                fallen: play.outcomes.value[p.id]?.fallen,
              }"
              :aria-pressed="p.id === play.chosenId.value"
              :data-place="p.id"
              @click="choose(p.id)"
            >
              <span>{{ p.name }}</span>
              <small>{{ remark(p.id, p.country) }}</small>
            </button>
          </li>
        </ul>
        <p v-if="play.loadError.value" class="places-error" role="alert">
          The list of places could not be loaded.
        </p>
        <p v-else class="places-hint">Pick one here, or click its pin on the globe.</p>
      </div>
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
      <PlayCard
        ref="playCard"
        :place="play.chosen.value"
        :outcome="play.chosen.value ? play.outcomes.value[play.chosen.value.id] : undefined"
        :in-play="play.chosen.value ? inPlay(play.chosen.value.id) : null"
        @play="play.chosen.value && openCity(play.chosen.value.id)"
        @close="play.choose(null)"
      />
      <p v-if="g.loadError.value" class="load-error" role="alert">{{ g.loadError.value }}</p>
    </main>
  </div>
  <HoverTip :tip="g.tip.value" />
  <CityView
    v-if="mountedId && play.loaded.value"
    v-show="cityId === mountedId"
    :key="mountedId"
    :city-id="mountedId"
    :title="cityPlace?.name ?? mountedId"
    :density="cityPlace?.density"
    :tiled="cityPlace?.tiled"
    :active="cityId === mountedId"
    @close="closeCity"
    @zoom-out="zoomedOut"
    @time="
      (seconds) => {
        cityTime = seconds;
        play.markInPlay(mountedId as string, seconds);
      }
    "
    @restarted="
      cityOver = false;
      cityTime = 0;
      play.markInPlay(mountedId as string, 0);
    "
    @over="
      (seconds) => {
        play.died(mountedId as string, seconds);
        cityOver = true;
      }
    "
  />
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
.enter {
  width: 100%;
  display: grid;
  gap: 2px;
  text-align: left;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid rgba(240, 181, 74, 0.45);
  background: rgba(240, 181, 74, 0.08);
  color: var(--ink);
  cursor: pointer;
  font: 500 15px var(--f-body);
}
.enter small {
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 400;
}
.enter:hover {
  background: rgba(240, 181, 74, 0.14);
}
.enter:focus-visible {
  outline: 2px solid var(--accent);
}
.places {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.place {
  width: 100%;
  display: grid;
  gap: 1px;
  text-align: left;
  padding: 7px 10px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  font: 500 14px var(--f-body);
}
.place small {
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.place:hover {
  border-color: #3a4a6a;
}
.place.on {
  border-color: rgba(240, 181, 74, 0.7);
  background: rgba(240, 181, 74, 0.09);
}
.place.fallen span {
  color: #ff8b7d;
}
.place:focus-visible {
  outline: 2px solid var(--accent);
}
.places-hint,
.places-error {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--faint);
}
.places-error {
  color: #ff8b7d;
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
