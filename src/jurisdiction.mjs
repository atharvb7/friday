// Where a prospect is decides what cold email is allowed (research summary, Oct 2026; not legal advice):
//   uk/eu  B2B on legitimate interest to companies; NOT sole traders/partnerships; say where the address came from
//   de     prior consent expected even for B2B email -> not supported
//   gulf   UAE/KSA data law treats marketing email to named people as opt-in -> published role addresses only
//   us     CAN-SPAM: opt-out + the sender's postal address in every commercial email
//   ca/au  CASL / Spam Act: only addresses the business itself published, relevant to their role
//   in     DPDP Rules phase in to ~May 2027; prefer addresses the person/company published themselves
export function jurisdictionOf(tz) {
  const z = String(tz ?? '');
  if (z === 'Europe/Berlin') return 'de';
  if (z === 'Europe/London') return 'uk';
  if (z.startsWith('Europe/')) return 'eu';
  if (/^Asia\/(Dubai|Riyadh|Qatar|Bahrain|Kuwait|Muscat)$/.test(z)) return 'gulf';
  if (/^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax|Regina|St_Johns|Montreal|Moncton)$/.test(z)) return 'ca';
  if (/^(America|US)\//.test(z) || z === 'Pacific/Honolulu') return 'us';
  if (z.startsWith('Australia/')) return 'au';
  if (z === 'Asia/Kolkata' || z === 'Asia/Calcutta') return 'in';
  return 'other';
}
export const RULES = {
  de: { supported: false, why: 'Germany expects prior consent even for B2B cold email' },
  gulf: { roleOnly: true }, ca: { ownSiteOnly: true }, au: { ownSiteOnly: true },
  uk: { noSoleTraders: true }, eu: { noSoleTraders: true }, us: { postalAddress: true },
};
