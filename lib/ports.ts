/**
 * Port aliases. Shipping instructions and carrier B/Ls habitually name the same
 * berth differently — "NORTH PORT" on an SI is "PORT KELANG(N)" on a carrier B/L.
 * Each entry lists every spelling seen in the wild; the first is the canonical form.
 */
const PORT_ALIASES: string[][] = [
  [
    // The port without a terminal. A certificate of origin names the port; the
    // B/L names the berth. `portRelation` treats that as compatible, not equal.
    'PORT KLANG, MALAYSIA',
    'PORT KLANG',
    'PORT KELANG',
    'PELABUHAN KLANG',
    'KLANG',
    'PORT KLANG MALAYSIA',
    'PORT KELANG MALAYSIA',
  ],
  [
    'PORT KLANG (NORTH PORT), MALAYSIA',
    'NORTH PORT',
    'NORTHPORT',
    'PORT KELANG(N)',
    'PORT KELANG (N)',
    'PORT KLANG(N)',
    'PORT KLANG (N)',
    'PORT KELANG NORTH',
    'PORT KLANG NORTH PORT',
    'NORTH PORT, PORT KLANG',
    'NORTH PORT PORT KELANG',
  ],
  [
    'PORT KLANG (WEST PORT), MALAYSIA',
    'WEST PORT',
    'WESTPORT',
    'PORT KELANG(W)',
    'PORT KELANG (W)',
    'PORT KLANG(W)',
    'PORT KLANG (W)',
    'PORT KLANG WEST PORT',
  ],
  ['NANSHA, CHINA', 'NANSHA', 'NANSHA PORT', 'NANSHA, GUANGZHOU', 'GUANGZHOU NANSHA'],
  ['SHEKOU, CHINA', 'SHEKOU', 'SHEKOU PORT', 'SHENZHEN SHEKOU'],
  ['YANTIAN, CHINA', 'YANTIAN', 'YANTIAN PORT', 'SHENZHEN YANTIAN'],
  ['SHANGHAI, CHINA', 'SHANGHAI', 'SHANGHAI PORT'],
  ['NINGBO, CHINA', 'NINGBO', 'NINGBO PORT'],
  ['PASIR GUDANG, MALAYSIA', 'PASIR GUDANG', 'PASIR GUDANG PORT', 'JOHOR PASIR GUDANG'],
  ['TANJUNG PELEPAS, MALAYSIA', 'TANJUNG PELEPAS', 'PTP', 'PORT TANJUNG PELEPAS'],
  ['PENANG, MALAYSIA', 'PENANG', 'PENANG PORT', 'GEORGETOWN PENANG'],
  ['SINGAPORE', 'SINGAPORE PORT', 'SIN'],
];

/** Loose key: letters and digits only, so "PORT KELANG(N)" == "port kelang n". */
function key(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const LOOKUP = new Map<string, string>();
for (const group of PORT_ALIASES) {
  const canonical = group[0];
  for (const alias of group) LOOKUP.set(key(alias), canonical);
}

/**
 * Resolve a port name to its canonical form. Returns null when the name is not
 * in the alias table, so callers can fall back to plain text comparison rather
 * than silently declaring two unknown ports equal.
 */
export function canonicalPort(name: string): string | null {
  const direct = LOOKUP.get(key(name));
  if (direct) return direct;
  // Country/qualifier suffixes are noise: "PORT KELANG(N), MALAYSIA".
  const trimmed = name.replace(/,\s*(MALAYSIA|CHINA|SINGAPORE|MY|CN)\s*$/i, '');
  return LOOKUP.get(key(trimmed)) ?? null;
}

/**
 * Terminals that sit inside a wider port. Naming the port when the other document
 * names the berth is less specific, not contradictory.
 */
const TERMINAL_OF: Record<string, string> = {
  'PORT KLANG (NORTH PORT), MALAYSIA': 'PORT KLANG, MALAYSIA',
  'PORT KLANG (WEST PORT), MALAYSIA': 'PORT KLANG, MALAYSIA',
};

export type PortRelation = 'same' | 'compatible' | 'different' | 'unknown';

/**
 * How two port names relate. 'compatible' means one names a terminal of the
 * other — worth a note, not a discrepancy.
 */
export function portRelation(a: string, b: string): PortRelation {
  const x = canonicalPort(a);
  const y = canonicalPort(b);
  if (!x || !y) return 'unknown';
  if (x === y) return 'same';
  if (TERMINAL_OF[x] === y || TERMINAL_OF[y] === x) return 'compatible';
  return 'different';
}

/** Every alias the table knows, used by the SI parser to spot a bare port line. */
export function allPortAliases(): string[] {
  return PORT_ALIASES.flat();
}
