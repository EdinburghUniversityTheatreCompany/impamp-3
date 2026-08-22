/**
 * `1 copy` / `2 copies`, without a plural rule at every call site.
 *
 * English only, and deliberately so: this is the shape every "N of a thing" in
 * the app needs, and a second copy of it in the next panel is how the two
 * drift into saying "1 banks". Reach for it wherever a number is rendered next
 * to the noun it counts — panels, modals, dialogs, and the error strings the
 * library throws — rather than writing the ternary again.
 *
 * It does not cover agreement that is not a count: "1 bank was skipped" against
 * "2 banks were skipped" picks a verb, and the noun beside it already went
 * through here.
 *
 * @param n How many
 * @param singular The word for one of them
 * @param plural The word for any other number of them
 */
export function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
