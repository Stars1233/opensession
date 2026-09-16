/** Stable display identities, not authorization principals or unique IDs.
 * Keep these ordered vocabularies append-free: changing them renames old agents.
 * 32 × 16 × 16 given names and 32 × 32 surnames = 8,388,608 combinations.
 * Deriving from the full session ID gives old and new sessions the same identity
 * everywhere without a backfill, network request, or exposing a seed externally.
 */
const starts =
  "Al An Ar Bel Ca Cel Da Del El Em Fa Fen Ga Hal Il Ja Ka Kel La Le Ma Mir Na Nel Or Ra Ren Sa Sel Ta Val Ze".split(
    " ",
  );
const middles = "la le li lo ma me mi na ne ni ra re ri sa se vi".split(" ");
const endings = "n r s l m th na ra la el en in on or is yn".split(" ");
const roots =
  "Amber Ash Aspen Birch Brook Cedar Cloud Coral Dawn Dune Ember Fern Flint Frost Glen Hazel Ivy Jade Juniper Lake Lark Maple Mist Moon Moss Oak Pine Rain Reed River Silver Willow".split(
    " ",
  );
const tails =
  "bay bloom branch breeze brook crest dale drift fall field finch ford glade grove haven hill hollow lake leaf light meadow mere moon peak ridge shore song spring star stone vale wind".split(
    " ",
  );

/** FNV-1a with independent domains for names and artwork. */
function hash(seed: string): number {
  let value = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    value = Math.imul(value ^ seed.charCodeAt(i), 16777619);
  }
  return value >>> 0;
}

export function agentIdentity(sessionId: string, familyId = sessionId) {
  let nameBits = hash(`agent-name-v1:${sessionId}`);
  const take = (words: string[]) => {
    const word = words[nameBits % words.length]!;
    nameBits = Math.floor(nameBits / words.length);
    return word;
  };
  const given = `${take(starts)}${take(middles)}${take(endings)}`;
  // Keep the original surname bit positions, so independent agents never
  // change names. Only workers borrow their root agent's surname seed.
  nameBits = Math.floor(hash(`agent-name-v1:${familyId}`) / (32 * 16 * 16));
  const name = `${given} ${take(roots)}${take(tails)}`;
  const art = hash(`agent-avatar-v1:${sessionId}`);
  return { name, seed: art };
}

/** Boring Avatars marble transforms. Adapted from boringdesigners/boring-avatars
 * (MIT), copyright 2021 boringdesigners. License in ui/boring-avatar.LICENSE. */
export function agentMarble(seed: number) {
  const unit = (value: number, range: number, digit?: number) => {
    const magnitude = value % range;
    return digit && Math.floor(value / 10 ** digit) % 2 === 0
      ? -magnitude
      : magnitude;
  };
  return Array.from({ length: 3 }, (_, i) => {
    const value = seed * (i + 1);
    return {
      color: `var(--chart-${((seed + i * 3) % 8) + 1})`,
      x: unit(value, 8, 1),
      y: unit(value, 8, 2),
      scale: 1.2 + unit(value, 4) / 10,
      rotate: unit(value, 360, 1),
    };
  });
}
