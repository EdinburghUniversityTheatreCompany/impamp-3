/**
 * `1 copy` / `2 copies`, without a plural rule at every call site.
 *
 * English only, and deliberately so: this is the shape every count in the
 * profile panels needs, and a second copy of it in the next panel is how the
 * two drift into saying "1 banks".
 *
 * @param n How many
 * @param singular The word for one of them
 * @param plural The word for any other number of them
 */
export function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
