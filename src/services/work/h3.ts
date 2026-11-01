// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * H3 for the Work routes (workspace decision 0067, rule 8, as amended on the founder's word of 2026-10-31 that the
 * worker's radius decides). A listing and a hirer are known here only by H3 cells: the plane turns them into centres and
 * distances itself, so no position crosses the wire. h3-js 4.5.0, the app's own pin, loads the first time a search needs
 * it: its emscripten module takes 32 MB (its browser build's initial memory), which the plane's other routes never pay.
 */
import type * as H3 from 'h3-js';

let h3: Promise<typeof H3> | undefined;

/** h3-js, loaded once. */
export function loadH3(): Promise<typeof H3> {
  h3 ??= import('h3-js');
  return h3;
}

/** The mean edge of an H3 cell, in kilometres (h3-js `getHexagonEdgeLengthAvg`), at the resolutions the Work routes use. */
export const EDGE_KM: Readonly<Record<4 | 5 | 6, number>> = { 4: 26.07175968, 5: 9.85409099, 6: 3.724532667 };

/**
 * The fewest grid rings whose cells hold a whole circle of `radiusKm` around any point of a cell of the mean size: ring k's
 * nearest cells are 1.5 edges times k away, and a point can sit half an edge from its cell's centre (the app's `geo.ts`).
 */
export function ringsFor(radiusKm: number, res: 4 | 5 | 6): number {
  return Math.ceil((radiusKm + 0.5 * EDGE_KM[res]) / (1.5 * EDGE_KM[res]));
}
