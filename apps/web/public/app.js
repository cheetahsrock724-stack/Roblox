/**
 * Kinetiq website shell.
 *
 * A single-page app for the whole site: discovery, search, game pages, profiles, friends, avatar
 * editor, inventory, messages, settings, the creator dashboard and the docs. Everything is driven
 * by the public JSON API — the website has no privileged path into the database.
 */

const platform = window.__PLATFORM__ ?? {};

const AVATAR_CATEGORIES = ['head', 'face', 'hair', 'shirt', 'pants', 'shoes', 'accessories', 'hats', 'back', 'bodyColors'];
const PRIVACY_FIELDS = ['whoCanMessage', 'whoCanJoin', 'whoCanSeeInventory', 'whoCanFriendRequest', 'whoCanInvite', 'whoCanSeeActivity'];
const DISCOVER_FILTERS = ['popular', 'most_played', 'trending', 'recommended', 'new', 'updated'];
// The 14 platform categories, mirrored from the server's GAME_CATEGORIES constant.
const GENRES = ['Adventure', 'Simulation', 'Roleplay', 'Fighting', 'Racing', 'Horror', 'Sandbox', 'Obby', 'Shooter', 'Party', 'Social', 'Puzzle', 'Building', 'Other'];
const PRIVACY_VALUES = ['everyone', 'friends', 'followers', 'nobody'];

const state = { user: null, csrf: null };

// ------------------------------------------------------------------ tiny DOM helper

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const div = (props, ...children) => el('div', props, ...children);
const span = (props, ...children) => el('span', props, ...children);
const text = (value) => document.createTextNode(String(value));

function section(title, body, extra = null) {
  return el('section', { class: 'section' }, div({ class: 'section-head' }, el('h2', {}, title), extra), body);
}

function chips(items, activeValue, onPick, classFor = 'chip') {
  const host = div({ class: 'chips' });
  for (const item of items) {
    const value = typeof item === 'string' ? item : item.value;
    const label = typeof item === 'string' ? item.replace(/_/g, ' ') : item.label;
    const active = activeValue !== null && String(activeValue) === String(value);
    host.append(el('button', { class: `${classFor}${active ? ' primary' : ''}`, onclick: () => onPick(value) }, label));
  }
  return host;
}

// ------------------------------------------------------------------ api + misc

async function api(path, options = {}) {
  const headers = {};
  if (state.csrf && options.method && options.method !== 'GET') headers['x-csrf-token'] = state.csrf;
  let body;
  if (options.form) body = options.form;
  else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch(path, { method: options.method ?? 'GET', headers, body, credentials: 'same-origin' });
  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = { raw };
  }
  if (json?.csrfToken) state.csrf = json.csrfToken;
  if (!response.ok) {
    const error = new Error(json?.error?.message ?? `Request failed (${response.status})`);
    error.status = response.status;
    error.code = json?.error?.code;
    throw error;
  }
  return json;
}

function fmtCount(value) {
  const n = Number(value ?? 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDate(value) {
  if (!value) return '—';
  const raw = String(value);
  const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleDateString();
}

function credits(value) {
  return `${platform.currencySymbol ?? '◈'} ${Number(value ?? 0).toLocaleString()}`;
}

function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  const node = div({ class: `toast toast-${kind}` }, message);
  host.append(node);
  setTimeout(() => node.remove(), 4200);
}

function thumbGradient(game) {
  const palette = ['#3d5afe', '#00e5c0', '#ff8a3d', '#8f6bff', '#ff5c8a', '#1fbf75'];
  const source = String(game?.name ?? 'game');
  const index = [...source].reduce((sum, char) => sum + char.charCodeAt(0), 0) % palette.length;
  return `linear-gradient(135deg, ${palette[index]}, ${palette[(index + 2) % palette.length]})`;
}

function gameCard(game) {
  const thumb = div({ class: 'card-thumb', style: { background: thumbGradient(game) } }, String(game.name).slice(0, 1));
  const body = div({ class: 'card-body' },
    div({ class: 'card-title' }, game.name),
    div({ class: 'card-meta' },
      span({}, `by ${game.ownerName ?? 'unknown'}`),
      span({}, `${fmtCount(game.activePlayers)} playing`),
      span({}, `${fmtCount(game.visitCount)} visits`),
    ),
    div({ class: 'card-meta dim' }, game.genre, game.tags?.length ? `· ${game.tags.slice(0, 3).join(', ')}` : ''),
  );
  return el('a', { class: 'card game-card', href: `#/game/${game.id}` }, thumb, body);
}

function grid(games) {
  return div({ class: 'grid' }, ...(games ?? []).map(gameCard));
}

function rows(entries, builder) {
  return div({ class: 'list' }, ...(entries ?? []).map(builder).filter(Boolean));
}

function simpleRow(title, subtitle, trailing) {
  return div({ class: 'row' }, div({}, div({}, title), subtitle ? div({ class: 'dim' }, subtitle) : null), trailing ?? null);
}

// ------------------------------------------------------------------ router

const ROUTES = {
  home: renderHome,
  discover: renderDiscover,
  search: renderSearch,
  game: renderGame,
  profile: renderProfile,
  friends: renderFriends,
  messages: renderMessages,
  notifications: renderNotifications,
  avatar: renderAvatar,
  inventory: renderInventory,
  settings: renderSettings,
  creator: renderCreator,
  docs: renderDocs,
  login: renderLogin,
  register: renderRegister,
  reset: renderReset,
};

function currentQuery() {
  const parts = location.hash.split('?');
  return new URLSearchParams(parts[1] ?? '');
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = raw.split('?')[0].split('/');
  if (!name || !ROUTES[name]) return { name: 'home', params: {} };
  return { name, params: { id: rest.join('/') } };
}

async function route() {
  const { name, params } = parseHash();
  const view = document.getElementById('view');
  view.innerHTML = '';
  view.append(div({ class: 'loading' }, 'Loading…'));
  try {
    const node = await ROUTES[name](params);
    view.innerHTML = '';
    view.append(node);
    window.scrollTo(0, 0);
  } catch (error) {
    view.innerHTML = '';
    view.append(div({ class: 'panel error' }, el('h3', {}, 'Something went wrong'), el('p', {}, error.message)));
  }
  document.querySelectorAll('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.route === name));
}

window.addEventListener('hashchange', () => { route(); });

// ------------------------------------------------------------------ chrome

async function refreshUser() {
  try {
    const data = await api('/api/auth/me');
    state.user = data.user;
    if (data.csrfToken) state.csrf = data.csrfToken;
  } catch {
    state.user = null;
  }
  renderUserArea();
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST', body: {} });
  } catch {
    /* session may already be gone */
  }
  state.user = null;
  await refreshUser();
  location.hash = '#/home';
}

function renderUserArea() {
  const area = document.getElementById('user-area');
  area.innerHTML = '';
  if (state.user) {
    area.append(
      el('a', { class: 'chip', href: `#/profile/${state.user.id}` }, state.user.displayName ?? state.user.username),
      span({ class: 'chip currency' }, credits(state.user.credits ?? 0)),
      el('a', { class: 'chip', href: '#/creator' }, platform.editorName ?? 'Creator'),
      state.user.role && state.user.role !== 'user' ? el('a', { class: 'chip admin', href: '/admin' }, 'Admin') : null,
      el('button', { class: 'chip', onclick: () => logout() }, 'Log out'),
    );
  } else {
    area.append(
      el('a', { class: 'chip', href: '#/login' }, 'Log in'),
      el('a', { class: 'chip primary', href: '#/register' }, 'Sign up'),
    );
  }
}

// ------------------------------------------------------------------ home + discovery

async function renderHome() {
  const home = await api('/api/home');
  const node = div({});
  node.append(el('header', { class: 'hero' },
    el('h1', {}, platform.name ?? 'Kinetiq'),
    el('p', {}, platform.tagline ?? 'Build worlds. Play together.'),
    div({ class: 'hero-actions' },
      el('a', { class: 'button primary', href: '#/discover' }, 'Discover games'),
      el('a', { class: 'button', href: '#/creator' }, `Open ${platform.editorName ?? 'the editor'}`),
    ),
  ));

  const featured = home.featured ?? [];
  if (featured.length) node.append(section('Featured', grid(featured)));
  const playing = home.friendsPlaying ?? [];
  if (playing.length) node.append(section('Friends are playing', grid(playing)));
  const recommended = home.recommended ?? [];
  if (recommended.length) node.append(section('Recommended for you', grid(recommended)));
  const popular = home.popular ?? [];
  if (popular.length) node.append(section('Popular right now', grid(popular)));
  const trending = home.trending ?? [];
  if (trending.length) node.append(section('Trending', grid(trending)));
  const newest = home.newest ?? [];
  if (newest.length) node.append(section('New releases', grid(newest)));
  const updated = home.updated ?? [];
  if (updated.length) node.append(section('Recently updated', grid(updated)));
  const recentlyPlayed = home.recentlyPlayed ?? [];
  if (recentlyPlayed.length) node.append(section('Recently played', grid(recentlyPlayed)));

  const categories = home.categories ?? [];
  if (categories.length) {
    const links = categories.map((category) => el('a', {
      class: 'chip',
      href: `#/discover?genre=${encodeURIComponent(category.genre)}`,
    }, `${category.genre} (${category.count ?? 0})`));
    node.append(section('Browse by category', div({ class: 'chips' }, ...links)));
  }
  return node;
}

async function renderDiscover() {
  const query = currentQuery();
  const genre = query.get('genre') ?? '';
  const sort = query.get('sort') ?? 'popular';
  const url = `/api/games?limit=48&sort=${encodeURIComponent(sort)}${genre ? `&genre=${encodeURIComponent(genre)}` : ''}`;
  const data = await api(url);
  const genreChips = chips([{ value: '', label: 'All' }, ...GENRES.map((value) => ({ value, label: value }))], genre, (value) => {
    location.hash = value ? `#/discover?genre=${encodeURIComponent(value)}&sort=${sort}` : `#/discover?sort=${sort}`;
  });
  const sortChips = chips(DISCOVER_FILTERS.map((value) => ({ value, label: value.replace('_', ' ') })), sort, (value) => {
    const base = genre ? `genre=${encodeURIComponent(genre)}&` : '';
    location.hash = `#/discover?${base}sort=${value}`;
  });
  return div({},
    section('Discover',
      div({ class: 'filters' }, genreChips, sortChips),
      (data.games ?? []).length ? grid(data.games) : div({ class: 'dim' }, 'No games here yet.'),
    ),
  );
}

async function renderSearch() {
  const query = currentQuery();
  const term = query.get('q') ?? '';
  const input = el('input', { type: 'search', value: term, placeholder: 'Search games, users, groups and items…' });
  const form = el('form', {
    class: 'searchbar',
    onsubmit: (event) => {
      event.preventDefault();
      location.hash = `#/search?q=${encodeURIComponent(input.value)}`;
    },
  }, input, el('button', { class: 'button primary', type: 'submit' }, 'Search'));
  const node = div({}, form);
  if (!term) return node;
  const results = await api(`/api/search?q=${encodeURIComponent(term)}`);
  node.append(
    section(`Games (${results.games?.length ?? 0})`, grid(results.games)),
    section(`People (${results.users?.length ?? 0})`, rows(results.users, (user) => el('a', { class: 'row', href: `#/profile/${user.id}` },
      div({ class: 'avatar-dot' }, String(user.displayName ?? user.username).slice(0, 1)),
      div({}, div({}, user.displayName ?? user.username), div({ class: 'dim' }, `@${user.username}`)),
    ))),
    section(`Groups (${results.groups?.length ?? 0})`, rows(results.groups, (group) => simpleRow(group.name, `${group.memberCount ?? 0} members`))),
    section(`Marketplace (${results.items?.length ?? 0})`, gridMarketItems(results.items)),
  );
  return node;
}

function gridMarketItems(items) {
  return div({ class: 'grid' }, ...(items ?? []).map((item) => div({ class: 'card' },
    div({ class: 'card-thumb', style: { background: item.color ?? '#222c44' } }, String(item.name).slice(0, 1)),
    div({ class: 'card-body' }, div({ class: 'card-title' }, item.name), div({ class: 'card-meta' }, credits(item.price))),
  )));
}

// ------------------------------------------------------------------ game page

async function renderGame({ id }) {
  const { game } = await api(`/api/games/${id}`);
  const node = div({});

  const creatorLink = game.creator
    ? el('a', { href: `#/profile/${game.creator.id}` }, game.creator.username)
    : text(game.ownerName ?? 'unknown');
  const titleRow = div({ class: 'dim' }, 'by ', creatorLink, ` · ${game.genre} · v${game.currentVersion ?? 1}`);

  const stats = div({ class: 'stats-row' },
    div({}, el('b', {}, fmtCount(game.activePlayers)), span({ class: 'dim' }, ' playing')),
    div({}, el('b', {}, fmtCount(game.visitCount)), span({ class: 'dim' }, ' visits')),
    div({}, el('b', {}, fmtCount(game.likeCount)), span({ class: 'dim' }, ' likes')),
    div({}, el('b', {}, fmtCount(game.favoriteCount)), span({ class: 'dim' }, ' favorites')),
  );

  const actions = div({ class: 'hero-actions' },
    el('button', { class: 'button primary big', onclick: () => playGame(game.id) }, `▶ Play (${fmtCount(game.activePlayers)})`),
    el('button', { class: 'button', onclick: () => toggleLike(game.id) }, game.engagement?.liked ? '👍 Liked' : '👍 Like'),
    el('button', { class: 'button', onclick: () => toggleFavorite(game.id) }, game.engagement?.favorited ? '★ Favorited' : '☆ Favorite'),
    el('button', { class: 'button', onclick: () => reportGame(game.id) }, 'Report'),
  );

  const header = div({ class: 'game-header' },
    div({ class: 'game-hero', style: { background: thumbGradient(game) } }),
    div({ class: 'game-info' }, el('h1', {}, game.name), titleRow, chips(game.tags ?? [], null, () => {}), stats, actions),
  );

  const about = section('About', div({ class: 'panel' },
    el('p', {}, game.description || 'No description yet.'),
    div({ class: 'dim small' }, `Created ${fmtDate(game.createdAt)} · Updated ${fmtDate(game.updatedAt)}`),
  ));

  const servers = div({ class: 'list' });
  const list = await api(`/api/games/${game.id}/servers`);
  for (const server of list.servers ?? []) {
    servers.append(div({ class: 'row' },
      div({}, div({}, `${server.region} · ${server.playerCount}/${server.maxPlayers}`), div({ class: 'dim' }, server.status)),
      el('button', { class: 'chip', onclick: () => playGame(game.id, { serverId: server.id }) }, 'Join'),
    ));
  }
  if (!(list.servers ?? []).length) servers.append(div({ class: 'dim' }, 'No servers running — playing will start a new one.'));

  const badges = rows(game.badges, (badge) => div({ class: 'row' },
    div({}, div({}, `🏅 ${badge.name}`), div({ class: 'dim' }, badge.description ?? '')),
  ));

  const products = rows(game.products, (product) => div({ class: 'row' },
    div({}, div({}, product.name), div({ class: 'dim' }, `${product.kind} · ${credits(product.price)}`)),
    el('button', { class: 'chip primary', onclick: () => buyProduct(product.id) }, 'Buy'),
  ));

  const versions = rows(game.versions, (version) => div({ class: 'row' },
    div({}, div({}, `v${version.versionNumber} ${version.published ? '· live' : '· draft'}`), div({ class: 'dim' }, version.changelog || 'No notes')),
  ));

  node.append(header, div({ class: 'two-col' },
    div({}, about, section('Servers', servers), section('Similar games', grid(game.similar))),
    div({}, section('Badges', badges), section('Passes & products', products), section('Version history', versions)),
  ));
  return node;
}

async function playGame(gameId, { serverId = null } = {}) {
  if (!state.user) {
    toast('Log in to play.', 'warn');
    location.hash = '#/login';
    return;
  }
  try {
    const join = await api(`/api/games/${gameId}/join`, { method: 'POST', body: serverId ? { serverId } : {} });
    const url = `/client?game=${encodeURIComponent(gameId)}&server=${encodeURIComponent(join.serverId)}&token=${encodeURIComponent(join.joinToken)}`;
    location.href = url;
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function toggleLike(gameId) {
  const result = await api(`/api/games/${gameId}/like`, { method: 'POST', body: {} });
  toast(result.liked ? 'Liked' : 'Like removed');
  route();
}

async function toggleFavorite(gameId) {
  const result = await api(`/api/games/${gameId}/favorite`, { method: 'POST', body: {} });
  toast(result.favorited ? 'Added to favorites' : 'Removed from favorites');
  route();
}

async function reportGame(gameId) {
  const reason = prompt('Describe the problem (reports go to moderators):');
  if (!reason) return;
  try {
    await api('/api/reports', { method: 'POST', body: { targetType: 'game', targetId: gameId, category: 'inappropriate_content', description: reason } });
    toast('Report submitted.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function buyProduct(productId) {
  try {
    const result = await api(`/api/products/${productId}/purchase`, { method: 'POST', body: {} });
    toast(`Purchased for ${credits(result.totalPrice ?? result.price ?? 0)}`);
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ------------------------------------------------------------------ profiles + social

async function renderProfile({ id }) {
  const { user } = await api(`/api/users/${id}`);
  const isSelf = state.user?.id === user.id;

  const stats = div({ class: 'stats-row' },
    div({}, el('b', {}, fmtCount(user.friendCount)), span({ class: 'dim' }, ' friends')),
    div({}, el('b', {}, fmtCount(user.followerCount)), span({ class: 'dim' }, ' followers')),
    div({}, el('b', {}, fmtCount(user.followingCount)), span({ class: 'dim' }, ' following')),
    div({}, el('b', {}, fmtCount(user.placeCount)), span({ class: 'dim' }, ' places')),
  );

  const actions = div({ class: 'hero-actions' });
  if (!isSelf && state.user) {
    actions.append(
      el('button', { class: 'button primary', onclick: () => addFriend(user.id) }, 'Add friend'),
      el('button', { class: 'button', onclick: () => follow(user.id) }, 'Follow'),
      el('button', { class: 'button', onclick: () => messageUser(user) }, 'Message'),
    );
  }
  if (isSelf) {
    actions.append(
      el('a', { class: 'button', href: '#/settings' }, 'Settings'),
      el('a', { class: 'button', href: '#/inventory' }, 'Inventory'),
      el('a', { class: 'button', href: '#/creator' }, 'Create'),
    );
  }

  return div({},
    div({ class: 'profile-header' },
      div({ class: 'avatar-large' }, String(user.displayName ?? user.username).slice(0, 1)),
      div({}, el('h1', {}, user.displayName ?? user.username),
        div({ class: 'dim' }, `@${user.username} · joined ${fmtDate(user.createdAt)} · ${user.presence ?? 'Offline'}`),
        el('p', {}, user.bio || 'No bio yet.'),
        user.badges?.length ? div({ class: 'chips' }, ...user.badges.map((badge) => span({ class: 'chip' }, `🏅 ${badge.name}`))) : null,
        stats, actions),
    ),
    section(`${user.displayName ?? user.username}'s games`, grid(user.games)),
    section('Favorites', grid(user.favorites)),
  );
}

async function addFriend(userId) {
  try {
    await api('/api/friends/requests', { method: 'POST', body: { userId } });
    toast('Friend request sent.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function follow(userId) {
  try {
    await api(`/api/users/${userId}/follow`, { method: 'POST', body: {} });
    toast('Now following.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function messageUser(user) {
  const body = prompt(`Message to ${user.username}:`);
  if (!body) return;
  try {
    await api('/api/messages', { method: 'POST', body: { userId: user.id, body } });
    toast('Message sent.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function renderFriends() {
  if (!state.user) return renderLogin();
  const [friends, requests] = await Promise.all([api('/api/friends'), api('/api/friends/requests')]);
  let playing = { playing: [] };
  try {
    playing = await api('/api/users/me/friends-playing');
  } catch {
    /* presence is optional */
  }

  const playingCards = (playing.playing ?? []).map((entry) => div({ class: 'card' },
    div({ class: 'card-thumb', style: { background: thumbGradient(entry.game) } }, String(entry.user?.username ?? '?').slice(0, 1)),
    div({ class: 'card-body' },
      div({ class: 'card-title' }, entry.user?.displayName ?? entry.user?.username),
      div({ class: 'card-meta' }, `playing ${entry.game?.name ?? 'a game'}`),
      el('button', { class: 'chip primary', onclick: () => playGame(entry.game.id) }, 'Join friend'),
    ),
  ));

  const requestRows = rows(requests.incoming, (request) => div({ class: 'row' },
    div({}, div({}, request.user?.displayName ?? request.user?.username), div({ class: 'dim' }, `@${request.user?.username}`)),
    div({ class: 'chips' },
      el('button', { class: 'chip primary', onclick: () => respondRequest(request.id, 'accept') }, 'Accept'),
      el('button', { class: 'chip', onclick: () => respondRequest(request.id, 'decline') }, 'Decline'),
    ),
  ));

  const friendRows = rows(friends.friends, (friend) => el('a', { class: 'row', href: `#/profile/${friend.id}` },
    div({ class: 'avatar-dot' }, String(friend.displayName ?? friend.username).slice(0, 1)),
    div({}, div({}, friend.displayName ?? friend.username), div({ class: 'dim' }, friend.presence ?? 'Offline')),
  ));

  return div({},
    section('Friends playing now', div({ class: 'grid' }, ...playingCards)),
    section(`Friend requests (${requests.incoming?.length ?? 0})`, requestRows),
    section(`Friends (${friends.friends?.length ?? 0})`, friendRows),
  );
}

async function respondRequest(id, action) {
  try {
    await api(`/api/friends/requests/${id}/respond`, { method: 'POST', body: { action } });
    toast(action === 'accept' ? 'Friend added.' : 'Request declined.');
    route();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function renderMessages() {
  if (!state.user) return renderLogin();
  const threads = await api('/api/messages/threads');
  const node = section('Messages', rows(threads.threads, (thread) => div({ class: 'row' },
    div({}, div({}, thread.participant?.displayName ?? thread.participant?.username ?? thread.title ?? 'Conversation'),
      div({ class: 'dim' }, thread.lastMessage ?? 'No messages yet')),
    el('button', { class: 'chip', onclick: () => openThread(thread) }, 'Open'),
  )));
  node.append(div({ class: 'panel', id: 'thread-panel' }));
  return node;
}

async function openThread(thread) {
  const data = await api(`/api/messages/${thread.id}`);
  const panel = document.getElementById('thread-panel');
  if (!panel) return;
  panel.innerHTML = '';
  const input = el('input', { placeholder: 'Write a message…' });
  const form = el('form', {
    class: 'searchbar',
    onsubmit: async (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      try {
        await api('/api/messages', { method: 'POST', body: { threadId: thread.id, body: input.value } });
        input.value = '';
        openThread(thread);
      } catch (error) {
        toast(error.message, 'error');
      }
    },
  }, input, el('button', { class: 'button primary', type: 'submit' }, 'Send'));
  panel.append(
    el('h3', {}, thread.participant?.displayName ?? thread.participant?.username ?? 'Conversation'),
    rows(data.messages, (message) => simpleRow(message.body, fmtDate(message.createdAt))),
    form,
  );
}

async function renderNotifications() {
  if (!state.user) return renderLogin();
  const data = await api('/api/notifications');
  const node = section('Notifications', rows(data.notifications, (notification) => simpleRow(notification.title, notification.body ?? '', div({ class: 'dim small' }, fmtDate(notification.createdAt)))));
  api('/api/notifications/read', { method: 'POST', body: {} }).catch(() => {});
  return node;
}

// ------------------------------------------------------------------ avatar + inventory

async function renderAvatar() {
  if (!state.user) return renderLogin();
  const [catalog, inventory] = await Promise.all([api('/api/avatar/catalog'), api('/api/inventory')]);
  const owned = new Set((inventory.items ?? []).map((item) => item.itemId ?? item.id));

  const preview = div({ class: 'avatar-preview panel' },
    div({ class: 'avatar-figure' },
      div({ class: 'figure-head' }, '🙂'),
      div({ class: 'figure-body' }, String(state.user.username).slice(0, 1).toUpperCase()),
    ),
    div({ class: 'dim' }, `Equipped: ${Object.keys(state.user.avatarItems ?? {}).length} items`),
    el('a', { class: 'button', href: '#/inventory' }, 'Inventory'),
  );

  const categorySections = AVATAR_CATEGORIES.map((category) => {
    const items = (catalog.items ?? []).filter((item) => item.category === category);
    const cards = items.map((item) => {
      const isOwned = owned.has(item.id) || item.id === state.user.avatarItems?.[category] || item.price === 0;
      const action = isOwned
        ? el('button', { class: 'chip primary', onclick: () => equipItem(item) }, 'Equip')
        : el('button', { class: 'chip', onclick: () => buyItem(item) }, 'Buy');
      return div({ class: 'card' },
        div({ class: 'card-thumb', style: { background: item.color ?? '#333c57' } }, String(item.name).slice(0, 1)),
        div({ class: 'card-body' },
          div({ class: 'card-title' }, item.name),
          div({ class: 'card-meta' }, item.price > 0 ? credits(item.price) : 'Free'),
          action,
        ),
      );
    });
    return section(category, div({ class: 'grid small' }, ...cards));
  });

  return div({}, section('Avatar', div({ class: 'two-col' }, preview, div({}, ...categorySections))));
}

async function buyItem(item) {
  try {
    await api(`/api/avatar/items/${item.id}/purchase`, { method: 'POST', body: {} });
    toast(`Purchased ${item.name}`);
    route();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function equipItem(item) {
  try {
    const avatarItems = { ...(state.user.avatarItems ?? {}), [item.category]: item.id };
    await api('/api/users/me', { method: 'PATCH', body: { avatarItems } });
    toast(`Equipped ${item.name}`);
    await refreshUser();
    route();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function renderInventory() {
  if (!state.user) return renderLogin();
  const [inventory, balance, transactions] = await Promise.all([
    api('/api/inventory'),
    api('/api/currency/balance'),
    api('/api/currency/transactions?limit=25'),
  ]);

  const claimBonus = async () => {
    try {
      const result = await api('/api/currency/daily-bonus', { method: 'POST', body: {} });
      toast(`Daily bonus: ${credits(result.amount ?? 0)}`);
      route();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  const header = div({ class: 'panel' }, div({ class: 'stats-row' },
    div({}, el('b', {}, credits(balance.balance)), span({ class: 'dim' }, ' balance')),
    el('button', { class: 'chip primary', onclick: claimBonus }, 'Claim daily bonus'),
  ));

  const items = (inventory.items ?? []).map((item) => div({ class: 'card' },
    div({ class: 'card-thumb', style: { background: item.color ?? '#2b3654' } }, String(item.name).slice(0, 1)),
    div({ class: 'card-body' },
      div({ class: 'card-title' }, item.name),
      div({ class: 'card-meta' }, item.category ?? item.kind),
      item.category ? el('button', { class: 'chip primary', onclick: () => equipItem(item) }, 'Equip') : null,
    ),
  ));

  const transactionRows = rows(transactions.transactions, (entry) => div({ class: 'row' },
    div({}, div({}, entry.reason ?? entry.kind), div({ class: 'dim' }, fmtDate(entry.createdAt))),
    el('b', {}, `${entry.amount > 0 ? '+' : ''}${credits(entry.amount)}`),
  ));

  return div({},
    section('Inventory', header),
    section('Items', div({ class: 'grid' }, ...items)),
    section('Transactions', transactionRows),
  );
}

// ------------------------------------------------------------------ settings + creator + docs

async function renderSettings() {
  if (!state.user) return renderLogin();
  const [privacy, sessions, keys] = await Promise.all([
    api('/api/users/me/privacy'),
    api('/api/auth/sessions'),
    api('/api/auth/api-keys'),
  ]);

  const privacyForm = el('form', {
    class: 'panel',
    onsubmit: async (event) => {
      event.preventDefault();
      const body = {};
      for (const field of PRIVACY_FIELDS) body[field] = event.target[field].value;
      try {
        await api('/api/users/me/privacy', { method: 'PATCH', body });
        toast('Privacy updated.');
      } catch (error) {
        toast(error.message, 'error');
      }
    },
  });
  for (const field of PRIVACY_FIELDS) {
    const select = el('select', { name: field });
    for (const option of PRIVACY_VALUES) {
      select.append(el('option', { value: option, selected: (privacy.privacy?.[field] ?? 'everyone') === option }, option));
    }
    const label = `Who can ${field.replace('whoCan', '').replace(/([A-Z])/g, ' $1').toLowerCase().trim()}`;
    privacyForm.append(el('label', { class: 'field' }, span({}, label), select));
  }
  privacyForm.append(el('button', { class: 'button primary', type: 'submit' }, 'Save privacy'));

  const passwordForm = el('form', {
    class: 'searchbar',
    onsubmit: async (event) => {
      event.preventDefault();
      try {
        await api('/api/auth/password/change', { method: 'POST', body: {
          currentPassword: event.target.current.value,
          newPassword: event.target.next.value,
        } });
        toast('Password changed.');
        event.target.reset();
      } catch (error) {
        toast(error.message, 'error');
      }
    },
  },
    el('input', { name: 'current', type: 'password', placeholder: 'Current password' }),
    el('input', { name: 'next', type: 'password', placeholder: 'New password' }),
    el('button', { class: 'button', type: 'submit' }, 'Change password'),
  );

  const account = div({ class: 'panel' },
    div({}, `Signed in as @${state.user.username} (${state.user.role})`),
    div({ class: 'dim' }, `Member since ${fmtDate(state.user.createdAt)}`),
    passwordForm,
  );

  const sessionRows = rows(sessions.sessions, (session) => simpleRow(session.userAgent ?? 'Unknown device', `last seen ${fmtDate(session.lastSeenAt)}`));

  const keyRows = rows(keys.keys, (key) => simpleRow(key.name, `key ${String(key.id).slice(0, 12)}…`));
  const keyPanel = div({ class: 'panel' }, keyRows, el('button', {
    class: 'chip primary',
    onclick: async () => {
      const name = prompt('Key name?') ?? 'key';
      try {
        const created = await api('/api/auth/api-keys', { method: 'POST', body: { name } });
        alert(`Copy this key now — it will not be shown again:\n\n${created.secret}`);
        route();
      } catch (error) {
        toast(error.message, 'error');
      }
    },
  }, 'Create API key'));

  return div({},
    section('Account', account),
    section('Privacy', privacyForm),
    section(`Sessions (${sessions.sessions?.length ?? 0})`, sessionRows),
    section('Developer API keys', keyPanel),
  );
}

async function renderCreator() {
  if (!state.user) return renderLogin();
  const projects = await api('/api/creator/projects');
  const cards = (projects.projects ?? []).map((project) => div({ class: 'card' },
    div({ class: 'card-thumb', style: { background: thumbGradient(project) } }, String(project.name).slice(0, 1)),
    div({ class: 'card-body' },
      div({ class: 'card-title' }, project.name),
      div({ class: 'card-meta' }, project.isPublished ? 'live' : 'draft', `· ${fmtCount(project.playCount ?? 0)} plays`),
      div({ class: 'chips' },
        el('a', { class: 'chip primary', href: `/editor?project=${project.id}` }, 'Edit'),
        el('a', { class: 'chip', href: `#/game/${project.id}` }, 'View page'),
      ),
    ),
  ));
  return div({},
    section(`${platform.editorName ?? 'Creator'} dashboard`,
      div({ class: 'panel' },
        el('button', { class: 'button primary', onclick: () => createProject() }, 'New project'),
        div({ class: 'dim small' }, 'Projects are saved as drafts until you publish them; every publish keeps the previous version playable.'),
      )),
    section('Your projects', div({ class: 'grid' }, ...cards)),
  );
}

async function createProject() {
  const name = prompt('Project name?', 'My New Game');
  if (!name) return;
  try {
    const created = await api('/api/creator/projects', { method: 'POST', body: { name, genre: 'Sandbox' } });
    location.href = `/editor?project=${created.game.id}`;
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function renderDocs() {
  const topics = [
    ['Getting started', 'Create an account, open the editor and publish your first world in a few minutes.'],
    ['Creating a game', 'Worlds are trees of instances: Parts, Models, Lights, Sounds, UI and scripts.'],
    ['Scripting', 'Server scripts run inside the realm; client scripts run in each player’s sandbox.'],
    ['Objects & properties', 'Every class has a documented property set exposed in the editor inspector.'],
    ['Events', 'playerJoined, playerLeft, characterSpawned, objectTouched, buttonClicked, heartbeat, update.'],
    ['Networking', 'Remote events fire between server and client; the server is always authoritative.'],
    ['UI', 'Frames, TextLabels, buttons, images, inputs, scrolling lists, progress bars and viewports.'],
    ['Player data', 'DataStore.open("Name") stores per-player values with quotas and per-game isolation.'],
    ['Assets', 'Upload images, meshes, audio and packages; validated and never executed server-side.'],
    ['Publishing', 'Publish creates an immutable version; older versions stay in the history.'],
    ['Debugging', 'The client dev console (F3) and the editor Output panel show script logs and errors.'],
  ];
  const cards = topics.map(([title, body]) => div({ class: 'card' },
    div({ class: 'card-body' }, div({ class: 'card-title' }, title), div({ class: 'card-meta' }, body)),
  ));
  return section('Documentation', div({ class: 'grid' }, ...cards));
}

// ------------------------------------------------------------------ auth pages

function authSubmit(handler) {
  return async (event) => {
    event.preventDefault();
    try {
      await handler(event.target);
      await refreshUser();
      route();
    } catch (error) {
      toast(error.message, 'error');
    }
  };
}

function renderLogin() {
  const form = el('form', {
    class: 'panel auth',
    onsubmit: authSubmit(async (target) => {
      await api('/api/auth/login', { method: 'POST', body: { username: target.username.value, password: target.password.value } });
      toast('Welcome back!');
      location.hash = '#/home';
    }),
  },
    el('h2', {}, 'Log in'),
    el('label', { class: 'field' }, span({}, 'Username'), el('input', { name: 'username', required: true, autocomplete: 'username' })),
    el('label', { class: 'field' }, span({}, 'Password'), el('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
    el('button', { class: 'button primary', type: 'submit' }, 'Log in'),
    div({ class: 'dim small' }, 'Demo accounts: AriDev, NiaPlays, ModTeam, PlatformAdmin — password demo-Password1!'),
    div({ class: 'chips' }, el('a', { class: 'chip', href: '#/register' }, 'Create an account'), el('a', { class: 'chip', href: '#/reset' }, 'Forgot password')),
  );
  return div({}, form);
}

function renderRegister() {
  const form = el('form', {
    class: 'panel auth',
    onsubmit: authSubmit(async (target) => {
      await api('/api/auth/register', { method: 'POST', body: {
        username: target.username.value,
        password: target.password.value,
        displayName: target.displayName.value || undefined,
        email: target.email.value || undefined,
      } });
      toast('Account created — welcome!');
      location.hash = '#/avatar';
    }),
  },
    el('h2', {}, 'Create your account'),
    el('label', { class: 'field' }, span({}, 'Username'), el('input', { name: 'username', required: true })),
    el('label', { class: 'field' }, span({}, 'Display name'), el('input', { name: 'displayName' })),
    el('label', { class: 'field' }, span({}, 'Email (optional)'), el('input', { name: 'email', type: 'email' })),
    el('label', { class: 'field' }, span({}, 'Password (10+ characters)'), el('input', { name: 'password', type: 'password', required: true, minLength: 10 })),
    el('button', { class: 'button primary', type: 'submit' }, 'Sign up'),
  );
  return div({}, form);
}

function renderReset() {
  const form = el('form', {
    class: 'panel auth',
    onsubmit: async (event) => {
      event.preventDefault();
      try {
        const result = await api('/api/auth/password/reset-request', { method: 'POST', body: { email: event.target.email.value } });
        if (result.resetToken) alert(`Development reset token: ${result.resetToken}`);
        toast('If that email exists, a reset link was sent.');
      } catch (error) {
        toast(error.message, 'error');
      }
    },
  },
    el('h2', {}, 'Reset password'),
    el('label', { class: 'field' }, span({}, 'Email'), el('input', { name: 'email', type: 'email', required: true })),
    el('button', { class: 'button primary', type: 'submit' }, 'Send reset link'),
  );
  return div({}, form);
}

// ------------------------------------------------------------------ boot

function applyBranding() {
  const colors = platform.colors ?? {};
  const root = document.documentElement;
  if (colors.primary) root.style.setProperty('--primary', colors.primary);
  if (colors.accent) root.style.setProperty('--accent', colors.accent);
  if (colors.surface) root.style.setProperty('--surface', colors.surface);
  document.title = `${platform.name ?? 'Kinetiq'} — ${platform.tagline ?? ''}`;
}

document.getElementById('search-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  location.hash = `#/search?q=${encodeURIComponent(event.target.elements.q.value.trim())}`;
});

applyBranding();
await refreshUser();
if (!location.hash) location.hash = '#/home';
await route();
