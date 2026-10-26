// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The locale of a string the token registry reads (workspace
 * `docs/product/engine.md`, Token registry): the language it is written in,
 * the regional variant where the worker's market names one, and the market,
 * the coarse region of the worker's listing (`SnapInput.market`). Clef's band
 * state, the band's candidates and the pivot's message say it (`clef.ts`,
 * `registry.ts`) as context only: no step prefers a label of the string's
 * language or region because of it. ESCO's Portuguese is Portugal's and its
 * Spanish is Spain's, and its Spanish gives "instructor" to the air force
 * officer, so a preference for the string's language would favour those
 * labels too.
 */

/** A coarse region: ISO 3166-1 alpha-2, optionally with a subdivision (`us-tx`, `br-sp`, `mx`). */
const REGION = /^[a-z]{2}(-[a-z0-9]{1,3})?$/;

const LANGUAGES: Readonly<Record<string, string>> = { en: 'English', pt: 'Portuguese', es: 'Spanish' };

interface Country {
  name: string;
  /** English puts "the" before the name. */
  the?: true;
  /** The variant of a language spoken there, by language code, where it has a name. */
  variants?: Readonly<Record<string, string>>;
}

/**
 * The countries the locale names: the launch markets, the rest of Latin
 * America (decision 0066 (6)), and the other countries whose variant of
 * English, Portuguese or Spanish it names. A region elsewhere is said by its
 * code.
 */
const COUNTRIES: Readonly<Record<string, Country>> = {
  us: { name: 'United States', the: true, variants: { en: 'American English' } },
  br: { name: 'Brazil', variants: { pt: 'Brazilian Portuguese' } },
  mx: { name: 'Mexico', variants: { es: 'Mexican Spanish' } },
  ca: { name: 'Canada', variants: { en: 'Canadian English' } },
  gb: { name: 'United Kingdom', the: true, variants: { en: 'British English' } },
  pt: { name: 'Portugal', variants: { pt: 'European Portuguese' } },
  es: { name: 'Spain', variants: { es: 'European Spanish' } },
  ar: { name: 'Argentina' },
  bo: { name: 'Bolivia' },
  cl: { name: 'Chile' },
  co: { name: 'Colombia' },
  cr: { name: 'Costa Rica' },
  cu: { name: 'Cuba' },
  do: { name: 'Dominican Republic', the: true },
  ec: { name: 'Ecuador' },
  gt: { name: 'Guatemala' },
  hn: { name: 'Honduras' },
  ni: { name: 'Nicaragua' },
  pa: { name: 'Panama' },
  pe: { name: 'Peru' },
  pr: { name: 'Puerto Rico' },
  py: { name: 'Paraguay' },
  sv: { name: 'El Salvador' },
  uy: { name: 'Uruguay' },
  ve: { name: 'Venezuela' },
};

export interface StringLocale {
  /** The language the string is written in (`en`, `pt`, `es`). */
  lang: string;
  /** A worker's string: the coarse region of their listing (`br-sp`). */
  market?: string;
}

const countryOf = (region: string | null | undefined): Country | null => (region && REGION.test(region) ? (COUNTRIES[region.slice(0, 2)] ?? null) : null);

/** The language by name, as the variant of the region's country where it has one: `Brazilian Portuguese` for `pt` in `br-sp`, else `Portuguese`. */
export function languageName(lang: string, region?: string | null): string {
  return countryOf(region)?.variants?.[lang] ?? LANGUAGES[lang] ?? lang;
}

/** A region by name: `Brazil (br-sp)`, `the United States (us-tx)`; the code alone where the country is not listed. */
export function regionName(region: string): string {
  const country = countryOf(region);
  return country ? `${country.the ? 'the ' : ''}${country.name} (${region})` : region;
}

/**
 * Who wrote a string, and in what: `written in Brazilian Portuguese by a
 * worker in Brazil (br-sp)`; without a market (a market that is not a
 * region counts as none), `written in Portuguese by a worker or a hirer`.
 */
export function writtenIn(locale: StringLocale): string {
  const market = locale.market && REGION.test(locale.market) ? locale.market : null;
  return market
    ? `written in ${languageName(locale.lang, market)} by a worker in ${regionName(market)}`
    : `written in ${languageName(locale.lang)} by a worker or a hirer`;
}

/**
 * A matched label's locale, as a band candidate shows it: its language
 * (`Spanish` for ESCO's Spanish), and a national layer's region: the variant
 * where it has a name (`American English` for an O*NET title), else the
 * language and the country (`Spanish, Colombia`), or the region's code where
 * the country is not listed. Null when the label's vector names no language.
 */
export function labelLocale(lang: string | null, region?: string | null): string | null {
  if (!lang) return null;
  const language = LANGUAGES[lang] ?? lang;
  if (!region || !REGION.test(region)) return language;
  const country = countryOf(region);
  return country?.variants?.[lang] ?? `${language}, ${country?.name ?? region}`;
}
