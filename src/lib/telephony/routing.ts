/** Lab-only BYON routing: select tenant by a VERIFIED PBX peer + dialed destination. */
export interface TrustedPbxRoute {
  peerId: string;      // authenticated gateway identity, not a SIP header provided by caller
  calledNumber: string; // canonical E.164 route configured by the business/PBX
  tenantSlug: string;
}

const E164 = /^\+[1-9][0-9]{7,14}$/;
const ROUTE = /^[a-zA-Z0-9_-]{1,64}$/;

export function resolveTrustedPbxRoute(
  authenticatedPeerId: string,
  dialedDestination: string,
  rules: TrustedPbxRoute[]
): string | null {
  if (!ROUTE.test(authenticatedPeerId) || !E164.test(dialedDestination)) return null;
  const matches = rules.filter(rule =>
    rule.peerId === authenticatedPeerId && rule.calledNumber === dialedDestination && ROUTE.test(rule.tenantSlug)
  );
  // Fail closed on ambiguity; caller ID and arbitrary tenant input must NEVER select a route.
  return matches.length === 1 ? matches[0].tenantSlug : null;
}
