// Where a prospect is decides what cold email is allowed (research summary, Oct 2026; not legal advice):
//   uk/eu  B2B on legitimate interest to companies; NOT sole traders/partnerships; say where the address came from
//   de/at  prior consent expected even for B2B email -> not supported
//   hold   UAE/Saudi (opt-in rules, no B2B exemption) and Spain/Italy/Poland (disputed) -> not until legal advice
//   us     CAN-SPAM: opt-out + the sender's postal address in every commercial email
//   ca/au  CASL / Spam Act: only addresses the business itself published, relevant to their role
//   in     DPDP Rules phase in to ~May 2027; prefer addresses the person/company published themselves
export function jurisdictionOf(tz) {
  const z = String(tz ?? '');
  if (z === 'Europe/Berlin' || z === 'Europe/Vienna') return 'de';
  if (/^Europe\/(Madrid|Rome|Warsaw)$/.test(z)) return 'hold_eu';
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
  de: { supported: false, why: 'Germany and Austria expect prior consent even for B2B cold email' },
  gulf: { supported: false, why: 'UAE/Saudi rules treat marketing email as opt-in with no B2B exemption; hold this market until you have legal advice' },
  hold_eu: { supported: false, why: 'cold B2B email rules in Spain/Italy/Poland are disputed; hold this market until you have legal advice' },
  ca: { ownSiteOnly: true }, au: { ownSiteOnly: true },
  uk: { noSoleTraders: true }, eu: { noSoleTraders: true }, us: { postalAddress: true },
};
