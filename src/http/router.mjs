// Tiny method+path router. Patterns look like '/v1/tasks/:id(hex)/cancel'.
// A handler returns [status, payload, headers?]; throwing maps through
// mapError(). First registered match wins, so register literals first.
const PARAM_RE = /:([A-Za-z]+)(?:\(([^)]*)\))?/g;
const DEFAULT_PARAM = '[A-Za-z0-9_-]+';

export class Router {
  #routes = [];

  add(method, pattern, handler) {
    const names = [];
    const source = pattern.replace(PARAM_RE, (_, name, rx) => { names.push(name); return `(${rx ?? DEFAULT_PARAM})`; });
    this.#routes.push({ method, re: new RegExp(`^${source}$`), names, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  // Returns the matched [status, payload, headers?] tuple, or null for 404.
  async dispatch(method, pathname, input) {
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const m = route.re.exec(pathname);
      if (!m) continue;
      const params = Object.fromEntries(route.names.map((n, i) => [n, m[i + 1]]));
      return route.handler({ ...input, params });
    }
    return null;
  }
}

export function mapError(error) {
  if (error?.message === 'body_too_large') return [413, { error: 'body_too_large' }];
  if (error instanceof SyntaxError) return [400, { error: 'invalid_json' }];
  return [500, { error: 'internal_error' }];
}
