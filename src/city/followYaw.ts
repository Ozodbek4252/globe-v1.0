// Which side the follow camera should sit on, so the first view of the survivor is not blocked by the
// nearest building. Pure: it only reads the collision world.

import { clearance, insideBuilding, type Colliders } from '../sim/colliders';

/** Smallest signed angle that turns `from` into `to`. */
const turn = (from: number, to: number): number => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/**
 * Pick the camera yaw (the cameraRig convention: 0 looks north, so the camera sits to the south)
 * whose line from the survivor back to the camera is the most open: it runs through the fewest
 * buildings. Among equally open choices it keeps the one nearest `preferred`.
 *
 * @param flat how far the camera sits from the survivor along the ground, in metres
 */
export function openestYaw(
  world: Colliders,
  x: number,
  y: number,
  flat: number,
  preferred: number,
): number {
  let best = preferred;
  let bestScore = Infinity;
  let bestTurn = Infinity;
  const candidates = 24;
  for (let i = 0; i < candidates; i++) {
    const yaw = preferred + (i / candidates) * Math.PI * 2;
    // in the camera rig the camera is at (sin yaw, cos yaw) on the ground in Three.js (x, z); city y is -z
    const dx = Math.sin(yaw);
    const dy = -Math.cos(yaw);
    let score = 0;
    for (let d = 2; d <= flat; d += 2) {
      const px = x + dx * d;
      const py = y + dy * d;
      if (insideBuilding(world, px, py)) score += 1;
      else if (clearance(world, px, py, 2) < 1) score += 0.25;
    }
    const away = Math.abs(turn(preferred, yaw));
    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && away < bestTurn)) {
      best = yaw;
      bestScore = score;
      bestTurn = away;
    }
  }
  return best;
}
