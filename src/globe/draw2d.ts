import { range } from 'd3-array';
import { geoCircle, geoDistance, geoGraticule10 } from 'd3-geo';
import type { Feature, FeatureCollection, Geometry, LineString } from 'geojson';
import { antipode, type LonLat } from '../lib/geo';
import { climateBands, climateBase } from '../map/climate';
import { featureOf } from '../map/data';
import type { CountryProps } from '../map/types';
import { createLabelBoxes, drawCapitals, drawCountryLabels } from './labels';
import type { Scene } from './scene';

const TAU = 2 * Math.PI;
const PICK = '#f0b54a';
const SPHERE = { type: 'Sphere' } as const;

const graticule = geoGraticule10();
const equatorLines = [0, 23.44, -23.44, 66.56, -66.56].map((lat) => ({
  lat,
  line: {
    type: 'LineString',
    coordinates: range(-180, 181, 3).map((lon): LonLat => [lon, lat]),
  } satisfies LineString,
}));

type CountryFeature = Feature<Geometry, CountryProps>;

/** Draw one full frame of the globe (everything except the WebGL night lights). */
export function drawScene(scene: Scene): void {
  const { ctx, width, height, dpr } = scene;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = 'round';
  ctx.clearRect(0, 0, width, height);

  const nightCenter = scene.sun ? antipode(scene.sun) : null;
  const land: FeatureCollection<Geometry, CountryProps> = {
    type: 'FeatureCollection',
    features: scene.visible.map((c): CountryFeature => featureOf(c, scene.detailed)),
  };

  drawAtmosphere(scene);
  drawOcean(scene);
  drawLand(scene, land);
  if (scene.layers.grid) drawGrid(scene);
  if (scene.sun) drawNightSide(scene, scene.sun);
  drawLightsDim(scene, nightCenter);
  drawSelection(scene, nightCenter);
  drawShading(scene);

  const boxes = createLabelBoxes();
  if (scene.selected) {
    const p = scene.selected.props;
    const pt = scene.proj([p.lx, p.ly]);
    if (pt) boxes.reserve(pt[0] - 60, pt[1] - 12, 120, 24);
  }
  if (scene.layers.cities) drawCapitals(scene, boxes);
  if (scene.layers.labels) drawCountryLabels(scene, boxes);
}

function drawAtmosphere({ ctx, width, height, scale: s }: Scene): void {
  const cx = width / 2;
  const cy = height / 2;
  const glow = ctx.createRadialGradient(cx, cy, s * 0.98, cx, cy, s * 1.16);
  glow.addColorStop(0, 'rgba(110,170,255,.32)');
  glow.addColorStop(1, 'rgba(110,170,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, s * 1.16, 0, TAU);
  ctx.fill();
}

function drawOcean({ ctx, path, width, height, scale: s, mode }: Scene): void {
  const cx = width / 2;
  const cy = height / 2;
  const oc = ctx.createRadialGradient(cx - s * 0.35, cy - s * 0.4, s * 0.1, cx, cy, s);
  oc.addColorStop(0, mode.ocean[0]);
  oc.addColorStop(1, mode.ocean[1]);
  ctx.fillStyle = oc;
  ctx.beginPath();
  path(SPHERE);
  ctx.fill();
}

function drawLand(scene: Scene, land: FeatureCollection<Geometry, CountryProps>): void {
  const { ctx, path, mode, width, height } = scene;
  if (mode.id === 'physical' || mode.id === 'daynight') {
    // climate belts clipped to the land, then lakes, rivers and a faint coastline
    ctx.save();
    ctx.beginPath();
    path(land);
    ctx.clip();
    ctx.fillStyle = climateBase();
    ctx.fillRect(0, 0, width, height);
    for (const band of climateBands()) {
      ctx.beginPath();
      path(band.circle);
      ctx.fillStyle = band.color;
      ctx.fill();
    }
    ctx.restore();
    ctx.beginPath();
    path(scene.world.lakes);
    ctx.fillStyle = '#2a6aa0';
    ctx.fill();
    ctx.beginPath();
    path(scene.world.rivers);
    ctx.strokeStyle = 'rgba(70,140,200,.85)';
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.beginPath();
    path(land);
    ctx.strokeStyle = 'rgba(20,30,20,.28)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  } else {
    const { fill } = mode;
    if (fill) {
      for (const country of scene.visible) {
        ctx.beginPath();
        path(featureOf(country, scene.detailed));
        ctx.fillStyle = fill(country);
        ctx.fill();
      }
    }
    ctx.beginPath();
    path(land);
    ctx.strokeStyle = mode.border;
    ctx.lineWidth = mode.bw || 0.6;
    ctx.stroke();
  }
}

function drawGrid({ ctx, path }: Scene): void {
  ctx.beginPath();
  path(graticule);
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 0.6;
  ctx.stroke();
  for (const { lat, line } of equatorLines) {
    ctx.beginPath();
    path(line);
    ctx.strokeStyle = lat === 0 ? 'rgba(240,181,74,.45)' : 'rgba(255,255,255,.16)';
    ctx.setLineDash(lat === 0 ? [] : [3, 4]);
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

/** Day & night: stacked dark caps around the anti-sun point make the twilight, then the sun marker. */
function drawNightSide({ ctx, path, proj, rot }: Scene, sun: LonLat): void {
  const anti = antipode(sun);
  const twilight: [radius: number, alpha: number][] = [
    [90, 0.22],
    [84, 0.14],
    [78, 0.12],
    [72, 0.14],
  ];
  for (const [r, a] of twilight) {
    ctx.beginPath();
    path(geoCircle().center(anti).radius(r)());
    ctx.fillStyle = `rgba(3,8,24,${a})`;
    ctx.fill();
  }
  if (geoDistance(sun, [-rot[0], -rot[1]]) < Math.PI / 2) {
    const p = proj(sun);
    if (p) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], 7, 0, TAU);
      ctx.fillStyle = '#f0b54a';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p[0], p[1], 12, 0, TAU);
      ctx.strokeStyle = 'rgba(240,181,74,.5)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

/** Darken the whole globe so the night lights stand out (Day & night has its own night side). */
function drawLightsDim({ ctx, path, layers }: Scene, nightCenter: LonLat | null): void {
  if (layers.lights && !nightCenter) {
    ctx.beginPath();
    path(SPHERE);
    ctx.fillStyle = 'rgba(2,5,14,.64)';
    ctx.fill();
  }
}

/** Picked countries in amber, then the hover highlight, then the outline of the card's country. */
function drawSelection(scene: Scene, nightCenter: LonLat | null): void {
  const { ctx, path, picks, hovered, selected, layers, detailed } = scene;
  for (const country of picks) {
    ctx.beginPath();
    path(featureOf(country, detailed));
    ctx.fillStyle = PICK;
    ctx.globalAlpha = layers.lights || nightCenter ? 0.45 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(40,24,4,.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (hovered) {
    ctx.beginPath();
    path(featureOf(hovered, detailed));
    ctx.fillStyle = picks.has(hovered) ? 'rgba(255,255,255,.12)' : 'rgba(255,255,255,.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (selected && picks.has(selected)) {
    ctx.beginPath();
    path(featureOf(selected, detailed));
    ctx.strokeStyle = '#fff4dc';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/** 3D look: a soft highlight top-left, darker edge (limb darkening) and a thin rim. */
function drawShading({ ctx, width, height, scale: s }: Scene): void {
  const cx = width / 2;
  const cy = height / 2;
  const hl = ctx.createRadialGradient(
    cx - s * 0.4,
    cy - s * 0.45,
    0,
    cx - s * 0.4,
    cy - s * 0.45,
    s * 1.1,
  );
  hl.addColorStop(0, 'rgba(255,255,255,.10)');
  hl.addColorStop(0.5, 'rgba(255,255,255,0)');
  const limb = ctx.createRadialGradient(cx, cy, s * 0.55, cx, cy, s);
  limb.addColorStop(0, 'rgba(0,0,0,0)');
  limb.addColorStop(1, 'rgba(0,4,14,.5)');
  ctx.beginPath();
  ctx.arc(cx, cy, s, 0, TAU);
  ctx.fillStyle = hl;
  ctx.fill();
  ctx.fillStyle = limb;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, s, 0, TAU);
  ctx.strokeStyle = 'rgba(140,190,255,.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
}
