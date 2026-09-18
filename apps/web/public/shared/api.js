/**
 * Small client-side API helper shared by the website, the client, the editor and the admin panel.
 * Cookie sessions are used as-is, with the CSRF token echoed back on writes (double-submit).
 */
const KQ = {
  csrfToken: null,

  async request(method, path, body, { raw = false, form = null } = {}) {
    const headers = {};
    if (this.csrfToken && method !== 'GET') headers['x-csrf-token'] = this.csrfToken;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
    if (raw) return response;
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { error: { code: 'bad_response', message: text.slice(0, 300) } };
    }
    if (!response.ok) {
      const error = new Error(json?.error?.message ?? `Request failed (${response.status})`);
      error.status = response.status;
      error.code = json?.error?.code;
      error.details = json?.error?.details;
      throw error;
    }
    return json;
  },

  get(path) {
    return this.request('GET', path);
  },
  post(path, body) {
    return this.request('POST', path, body);
  },
  put(path, body) {
    return this.request('PUT', path, body);
  },
  patch(path, body) {
    return this.request('PATCH', path, body);
  },
  del(path) {
    return this.request('DELETE', path);
  },
  upload(form) {
    return this.request('POST', '/api/assets', null, { form });
  },

  /** Session bootstrap: fetch the signed-in user and CSRF token. */
  async session() {
    const data = await this.get('/api/auth/me');
    this.csrfToken = data.csrfToken ?? this.csrfToken;
    this.user = data.user;
    return data;
  },

  async login(username, password) {
    const data = await this.post('/api/auth/login', { username, password });
    this.csrfToken = data.csrfToken;
    this.user = data.user;
    return data;
  },

  async register(payload) {
    const data = await this.post('/api/auth/register', payload);
    this.csrfToken = data.csrfToken;
    this.user = data.user;
    return data;
  },

  async logout() {
    await this.post('/api/auth/logout', {});
    this.user = null;
    this.csrfToken = null;
  },

  /** Joins a game and returns { connectUrl, ... } for the client. */
  join(gameId, options = {}) {
    return this.post(`/api/games/${encodeURIComponent(gameId)}/join`, options);
  },
};

window.KQ = KQ;

/** Tiny DOM helper used by every page. */
window.h = function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'html') el.innerHTML = value;
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
};

window.fmt = {
  number(value) {
    const n = Number(value ?? 0);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  },
  date(value) {
    if (!value) return '—';
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(`${value}`.replace(' ', 'T') + (String(value).includes('T') ? '' : 'Z'));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
  },
  credits(value) {
    return `${window.__PLATFORM__?.currencySymbol ?? '◈'} ${Number(value ?? 0).toLocaleString()}`;
  },
};
