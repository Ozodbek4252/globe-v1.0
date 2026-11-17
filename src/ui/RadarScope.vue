<script setup lang="ts">
import { computed, onMounted, useTemplateRef, watch } from 'vue';
import type { RadarFrame } from '../city/createCity';
import { cssColour } from '../city/placeStyle';

const props = defineProps<{ frame: RadarFrame | null }>();

const SIZE = 176;
const canvas = useTemplateRef<HTMLCanvasElement>('canvas');

const hunting = computed(() => {
  const z = props.frame?.zombies;
  if (!z) return 0;
  let n = 0;
  for (let i = 2; i < z.length; i += 3) if (z[i] === 1) n++;
  return n;
});
const count = computed(() => (props.frame ? props.frame.zombies.length / 3 : 0));
const label = computed(() =>
  props.frame
    ? `Radar: ${count.value} zombies within ${props.frame.range} metres, ${hunting.value} hunting you.`
    : 'Radar offline',
);

function draw(): void {
  const el = canvas.value;
  const f = props.frame;
  if (!el || !f) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (el.width !== SIZE * dpr) {
    el.width = SIZE * dpr;
    el.height = SIZE * dpr;
  }
  const g = el.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, SIZE, SIZE);
  const c = SIZE / 2;
  const R = c - 4;
  const k = (R - 8) / f.range; // pixels per metre

  // the scope: a dark disc with faint range rings and a north mark
  g.fillStyle = 'rgba(5, 14, 26, 0.82)';
  g.beginPath();
  g.arc(c, c, R, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(74, 168, 255, 0.28)';
  g.lineWidth = 1;
  for (const frac of [1 / 3, 2 / 3]) {
    g.beginPath();
    g.arc(c, c, (R - 8) * frac, 0, Math.PI * 2);
    g.stroke();
  }
  g.strokeStyle = 'rgba(74, 168, 255, 0.7)';
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(c, c, R, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'rgba(160, 200, 255, 0.9)';
  g.font = '600 10px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('N', c + Math.sin(f.north) * (R - 7), c - Math.cos(f.north) * (R - 7));

  // places: a diamond in the role's colour, pinned to the rim when beyond the scope
  for (const p of f.places) {
    let x = p.x * k;
    let y = -p.y * k;
    const d = Math.hypot(x, y);
    const edge = R - 8;
    const off = d > edge;
    if (off) {
      x = (x / d) * edge;
      y = (y / d) * edge;
    }
    g.globalAlpha = p.used ? 0.3 : off ? 0.55 : 1;
    g.fillStyle = cssColour(p.kind);
    const s = off ? 3.2 : 4.6;
    g.beginPath();
    g.moveTo(c + x, c + y - s);
    g.lineTo(c + x + s, c + y);
    g.lineTo(c + x, c + y + s);
    g.lineTo(c + x - s, c + y);
    g.closePath();
    g.fill();
  }
  g.globalAlpha = 1;

  // people: green, solid when with you and hollow while they are still hiding
  for (let i = 0; i < f.people.length; i += 3) {
    const x = f.people[i] * k;
    const y = -f.people[i + 1] * k;
    const d = Math.hypot(x, y);
    const edge = R - 6;
    const px = d > edge ? (x / d) * edge : x;
    const py = d > edge ? (y / d) * edge : y;
    g.beginPath();
    g.arc(c + px, c + py, 3.2, 0, Math.PI * 2);
    if (f.people[i + 2] === 1) {
      g.fillStyle = '#7dff8f';
      g.fill();
    } else {
      g.strokeStyle = d > edge ? 'rgba(125, 255, 143, 0.55)' : '#7dff8f';
      g.lineWidth = 1.6;
      g.stroke();
    }
  }

  // the helicopter's landing place, once it has been heard
  if (f.landing) {
    const x = f.landing.x * k;
    const y = -f.landing.y * k;
    const d = Math.hypot(x, y);
    const edge = R - 9;
    const px = c + (d > edge ? (x / d) * edge : x);
    const py = c + (d > edge ? (y / d) * edge : y);
    g.fillStyle = '#ffd27a';
    g.beginPath();
    g.arc(px, py, 7, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#2a1c05';
    g.font = '700 9px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('H', px, py + 0.5);
  }

  // zombies: red dots, brighter and larger when they are on your trail
  for (let i = 0; i < f.zombies.length; i += 3) {
    const x = f.zombies[i] * k;
    const y = -f.zombies[i + 1] * k;
    if (x * x + y * y > (R - 3) * (R - 3)) continue;
    const hunt = f.zombies[i + 2] === 1;
    g.fillStyle = hunt ? '#ff3b2a' : '#a8342c';
    g.beginPath();
    g.arc(c + x, c + y, hunt ? 2.4 : 1.8, 0, Math.PI * 2);
    g.fill();
  }

  // the next wave: a chevron on the rim in the direction it comes from
  if (f.wave) {
    const a = f.wave.angle;
    const ax = c + Math.sin(a) * (R - 2);
    const ay = c - Math.cos(a) * (R - 2);
    g.save();
    g.translate(ax, ay);
    g.rotate(a);
    g.fillStyle = f.wave.seconds < 10 ? '#ff4b3a' : '#e8a13a';
    g.beginPath();
    g.moveTo(0, 2);
    g.lineTo(-7, 12);
    g.lineTo(0, 8);
    g.lineTo(7, 12);
    g.closePath();
    g.fill();
    g.restore();
  }

  // the survivor, in the middle, facing the way they face
  g.save();
  g.translate(c, c);
  g.rotate(f.heading);
  g.fillStyle = '#ffe9a8';
  g.beginPath();
  g.moveTo(0, -6);
  g.lineTo(4.5, 5);
  g.lineTo(0, 2.5);
  g.lineTo(-4.5, 5);
  g.closePath();
  g.fill();
  g.restore();
}

onMounted(draw);
watch(() => props.frame, draw);
</script>

<template>
  <figure v-if="frame" class="radar-scope">
    <canvas ref="canvas" role="img" :aria-label="label" :width="SIZE" :height="SIZE"></canvas>
    <figcaption v-if="frame.wave" :class="{ soon: frame.wave.seconds < 10 }">
      Wave in {{ Math.ceil(frame.wave.seconds) }}s · {{ frame.wave.size }}
    </figcaption>
    <figcaption v-else>{{ count }} nearby</figcaption>
  </figure>
</template>

<style>
.radar-scope {
  position: absolute;
  top: 70px;
  left: 16px;
  margin: 0;
  display: grid;
  justify-items: center;
  gap: 4px;
  pointer-events: none;
  filter: drop-shadow(0 4px 14px rgba(0, 0, 0, 0.55));
}
.radar-scope canvas {
  width: 176px;
  height: 176px;
}
.radar-scope figcaption {
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel);
  font: 500 11px var(--f-mono);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.radar-scope figcaption.soon {
  color: #ff7a66;
  border-color: rgba(255, 90, 70, 0.55);
}
@media (max-width: 760px) {
  .radar-scope {
    top: 150px;
  }
  .radar-scope canvas {
    width: 132px;
    height: 132px;
  }
}
</style>
