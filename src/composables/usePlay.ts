import { computed, onMounted, ref } from 'vue';
import type { GlobeMarker } from '../globe/types';
import { readStored, writeStored } from '../lib/storage';
import {
  loadPlayable,
  OUTCOMES_KEY,
  parseOutcomes,
  reclaim,
  recordDeath,
  serializeOutcomes,
  type Outcomes,
  type Playable,
} from '../map/playable';

/**
 * The places you can play and what has become of each: which one is chosen, how long you lasted in it,
 * whether it has fallen. What happened is remembered in this browser (localStorage), so the globe is
 * still dark over the places you lost the next time you come back.
 */
export function usePlay() {
  const places = ref<Playable[]>([]);
  const outcomes = ref<Outcomes>(parseOutcomes(readStored(OUTCOMES_KEY)));
  /** The place whose card is open. */
  const chosenId = ref<string | null>(null);
  const loadError = ref('');
  /** The list has arrived (or could not): a place can be opened by its id from then on. */
  const loaded = ref(false);

  onMounted(async () => {
    try {
      places.value = await loadPlayable();
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : 'Could not load the places.';
    } finally {
      loaded.value = true;
    }
  });

  const byId = computed(() => new Map(places.value.map((p) => [p.id, p])));
  const chosen = computed(() => (chosenId.value ? (byId.value.get(chosenId.value) ?? null) : null));

  /** The pins for the globe. */
  const markers = computed<GlobeMarker[]>(() =>
    places.value.map((p) => ({
      id: p.id,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      fallen: outcomes.value[p.id]?.fallen === true,
    })),
  );

  function save(next: Outcomes): void {
    outcomes.value = next;
    writeStored(OUTCOMES_KEY, serializeOutcomes(next));
  }

  return {
    places,
    outcomes,
    chosenId,
    chosen,
    markers,
    loadError,
    loaded,
    choose: (id: string | null): void => {
      chosenId.value = id !== null && byId.value.has(id) ? id : null;
    },
    /** The survivor died in this place, after this many seconds: it falls. */
    died: (id: string, seconds: number): void => save(recordDeath(outcomes.value, id, seconds)),
    /** Take a fallen place back. */
    reclaim: (id: string): void => save(reclaim(outcomes.value, id)),
  };
}
