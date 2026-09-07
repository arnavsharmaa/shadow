import { ID_PREFIXES, type IdPrefix } from "@shadow/schemas";

export interface IdGenerator {
  next(prefix: IdPrefix): string;
}

/** Cryptographically random ids for live recording. */
export function randomIdGenerator(): IdGenerator {
  return {
    next(prefix) {
      return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
    },
  };
}

/** FNV-1a 32-bit hash; small, dependency free and stable across platforms. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic ids derived from a seed. Used by seeds and deterministic
 * replays so the same input always yields byte-identical traces.
 */
export function seededIdGenerator(seed: string): IdGenerator {
  let counter = 0;
  return {
    next(prefix) {
      counter += 1;
      const a = fnv1a(`${seed}:${prefix}:${counter}`).toString(16).padStart(8, "0");
      const b = fnv1a(`${counter}:${prefix}:${seed}:salt`).toString(16).padStart(8, "0");
      const c = fnv1a(`${a}${b}`).toString(16).padStart(8, "0");
      return `${prefix}_${a}${b}${c}`;
    },
  };
}

export { ID_PREFIXES };
