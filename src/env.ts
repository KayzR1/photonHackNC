/** Reads an optional env var, falling back when it's unset OR left blank (`KEY=` in a .env file sets it to ""). */
export function envStr(name: string, fallback: string): string {
  const value = process.env[name];
  return value ? value : fallback;
}

export function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
