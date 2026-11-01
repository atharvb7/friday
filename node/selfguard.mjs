// Friday must never drive Friday: a page or message could talk the computer agent into opening Friday's own
// site in the owner's signed-in browser and pressing Approve on its own request. So the node refuses
// Friday's own addresses (internal browser and xdg-open), typing them, and any click/key/type while Friday's
// own tab is the focused window. Other subdomains (e.g. a portfolio on atharv.fridayy.site) stay allowed.
export const DEFAULT_SELF_HOSTS = ['fridayy.site', 'www.fridayy.site', 'app.fridayy.site'];
let hosts = new Set(DEFAULT_SELF_HOSTS);

export function setSelfHosts(list = []) {
  hosts = new Set([...DEFAULT_SELF_HOSTS, ...list].map((h) => String(h ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')).filter(Boolean));
  return [...hosts];
}

export const isSelfHost = (host) => hosts.has(String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''));

// The host as a whole name in free text ("go to fridayy.site/approvals"), not as part of a longer name.
export function mentionsSelf(text) {
  const s = String(text ?? '').toLowerCase();
  for (const h of hosts) {
    const re = new RegExp(`(^|[^a-z0-9.-])${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`);
    if (re.test(s)) return h;
  }
  return null;
}

// Friday's app tab is titled exactly "Friday" (or "(3) Friday" with unread items); browsers append their name.
const SELF_TITLE = /^(\(\d+\)\s+)?Friday(\s+[-–—]\s+(Google Chrome|Chromium|Brave|Microsoft Edge|Mozilla Firefox|Firefox|Vivaldi|Opera))?$/;
export const isSelfWindow = (title) => SELF_TITLE.test(String(title ?? '').trim());

export const SELF_ERROR = 'friday_own_ui: Friday does not operate its own app or site (that is where approvals are decided). Ask the user to do it.';
