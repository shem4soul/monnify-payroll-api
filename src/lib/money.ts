/**
 * Money is stored and calculated in kobo (integer minor units) to avoid floating point drift.
 * Naira amounts only exist at the API boundary and when talking to Monnify.
 */
export function nairaToKobo(naira: number): number {
  return Math.round(naira * 100);
}

export function koboToNaira(kobo: number): number {
  return kobo / 100;
}
