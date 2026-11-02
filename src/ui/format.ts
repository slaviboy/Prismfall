/** 83456 -> "1:23.45" (minutes:seconds.hundredths). */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 10));
  const hundredths = total % 100;
  const seconds = Math.floor(total / 100) % 60;
  const minutes = Math.floor(total / 6000);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

export function formatScore(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

export function piecesPerSecond(pieces: number, ms: number): string {
  return ms > 0 ? (pieces / (ms / 1000)).toFixed(2) : '0.00';
}

export function percent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function ms(v: number): string {
  return `${Math.round(v)} ms`;
}
