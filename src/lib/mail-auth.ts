/**
 * The sender is authenticated when the receiving MTA recorded a DMARC pass for it.
 * Email Routing adds Authentication-Results. A DKIM pass alone can be for a
 * different signing domain than From (classic spoof) and is not enough.
 */
export function senderAuthenticated(headers: Headers): boolean {
  const ar = (headers.get("authentication-results") || "").toLowerCase();
  return /\bdmarc=pass\b/.test(ar);
}
