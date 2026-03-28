import { env } from "../config/env.js";

export interface KnownLocker {
  address: string;
  label: string;
}

// Conservative seed list. Keep small unless verified.
export const KNOWN_BURN_ADDRESSES = new Set<string>([
  "11111111111111111111111111111111",
  "1nc1nerator11111111111111111111111111111111",
  "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
]);

const SEEDED_LOCKERS: KnownLocker[] = [];

function parseConfiguredLockers(): KnownLocker[] {
  const raw = env.LP_LOCKER_ADDRESSES?.trim();
  if (!raw) return [];

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((address) => ({
      address,
      label: "configured-locker",
    }));
}

export const KNOWN_LOCKER_ADDRESSES: KnownLocker[] = [
  ...SEEDED_LOCKERS,
  ...parseConfiguredLockers(),
];

export function getKnownLockerLabel(address: string): string | undefined {
  return KNOWN_LOCKER_ADDRESSES.find((locker) => locker.address === address)?.label;
}

export function isKnownBurnAddress(address: string): boolean {
  return KNOWN_BURN_ADDRESSES.has(address);
}
