/**
 * Administration & moderation dashboard.
 *
 * Every action here goes through the same public API the platform exposes, and authorisation is
 * enforced server-side (`requireRole`): this page simply refuses to render for ordinary users, but
 * hiding the UI is never what keeps the tools safe.
 */
const KQ = window.KQ;
const h = window.h;

const state = { user: null, tab: 'overview' };

const TABS = [
  ['overview', 'Overview'],
  ['users', 'Users'],
  ['games', 'Games'],
  ['reports', 'Reports'],
  ['assets', 'Assets'],
  ['servers', 'Servers'],
  ['transactions', 'Transactions'],
  ['history', 'Moderation history'],
];

const ACTIONS = [
  'warn', 'mute', 'kick', 'ban_temporary', 'ban_permanent', 'remove_asset', 'unpublish_game',
  'approve_asset', 'restore_asset', 'republish_game', 'reset_password', 'delete_message', 'close_report',
];

const view = document.getElementById('view');

function toast(message, kind = 'info') {
  const node = h('div', { class: `toast toast-${kind}` }, message);
  document.getElementById('toasts').append(node);
  setTimeout(() => node.remove(), 5000);
}

function fmtDate(value) {
  return window.fmt.date(value);
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('b', {}, String(value ?? 0)), h('span', {}, label));
}

function section(title, body) {
  return h('section', { class: 'section' }, h('h2', {}, title), body);
}

function table(columns, rows, renderRow) {
  const head = h('tr', {}, ...columns.map((column) => h('th', {}, column)));
  const body = h('tbody', {}, ...rows.map(renderRow));
  return h('table', { class: 'data-table' }, h('thead', {}, head), body);
}

function actionControls(targetType, target) {
  const action = h('select', {});
  for (const option of ACTIONS) action.append(h('option', { value: option }, option));
  const reason = h('input', { class: 'reason-input', placeholder: 'reason (logged)' });
  const duration = h('input', { class: 'reason-input', type: 'number', min: '5', value: '1440', title: 'duration in minutes' });
  const apply = h('button', {
    class: 'chip primary',
    onclick: async () => {
      try {
        await KQ.post('/api/moderation/actions', {
          targetType,
          targetId: target.id,
          action: action.value,
          reason: reason.value || `${action.value} by ${state.user.username}`,
          durationMinutes: action.value === 'ban_temporary' || action.value === 'mute' ? Number(duration.value) : undefined,
        });
        toast(`${action.value} applied.`);
        route();
      } catch (error) {
        toast(error.message, 'error');
      }
    },
  }, 'Apply');
  return h('div', { class: 'panel-row' }, action, duration, reason, apply);
}

// ------------------------------------------------------------------ tabs

async function renderOverview() {
  const data = await KQ.get('/api/admin/overview');
  const stats = data.stats ?? {};
  const cards = h('div', { class: 'stat-grid' },
    stat('Users', stats.users), stat('New users today', stats.newUsersToday),
    stat('Games', stats.games), stat('Published', stats.publishedGames),
    stat('Live servers', stats.servers), stat('Players in servers', stats.playersInServers),
    stat('Visits', stats.visits), stat('Open reports', data.moderation?.openReports ?? 0),
    stat('Actions taken', data.moderation?.totalActions ?? 0), stat('Bans active', data.moderation?.activeBans ?? 0),
  );
  const realms = h('div', { class: 'list' }, ...(data.realms ?? []).map((realm) =>
    h('div', { class: 'row' },
      h('div', {}, h('div', {}, `${realm.gameName} v${realm.versionNumber} · ${realm.region}`),
        h('div', { class: 'dim' }, `${realm.id} · ${realm.mode} · ${realm.playerCount}/${realm.maxPlayers} players · ${realm.uptimeSeconds}s uptime`)),
      h('span', { class: `pill ${realm.status === 'running' ? 'ok' : 'warn'}` }, realm.status),
    )));
  return h('div', {},
    section('Platform', h('div', { class: 'panel' },
      h('div', {}, `${data.platform?.name} ${data.platform?.version} · ${data.platform?.env} · uptime ${data.platform?.uptimeSeconds}s · rss ${data.platform?.memoryMb}MB`))),
    section('Statistics', cards),
    section('Live servers', realms),
  );
}

async function renderUsers() {
  const query = document.getElementById('user-query')?.value ?? '';
  const data = await KQ.get(`/api/admin/users?limit=50${query ? `&q=${encodeURIComponent(query)}` : ''}`);
  const search = h('input', { id: 'user-query', placeholder: 'search usernames…', value: query });
  const go = h('button', { class: 'chip', onclick: () => route() }, 'Search');
  const rows = table(['User', 'Role', 'Status', 'Credits', 'Created', 'Moderation'], data.users ?? [], (user) =>
    h('tr', {},
      h('td', {}, h('div', {}, user.displayName ?? user.username), h('div', { class: 'dim' }, `@${user.username} · ${user.id}`)),
      h('td', {}, h('div', { class: 'panel-row' },
        (() => {
          const select = h('select', { onchange: async (event) => {
            try {
              await KQ.post(`/api/admin/users/${user.id}/role`, { role: event.target.value });
              toast(`Role updated to ${event.target.value}.`);
            } catch (error) {
              toast(error.message, 'error');
            }
          } });
          for (const role of ['user', 'moderator', 'admin']) select.append(h('option', { value: role, selected: user.role === role }, role));
          return select;
        })())),
      h('td', {}, h('span', { class: `pill ${user.status === 'active' ? 'ok' : 'bad'}` }, user.status)),
      h('td', {}, String(user.credits ?? 0)),
      h('td', {}, fmtDate(user.createdAt)),
      h('td', {}, actionControls('user', user)),
    ));
  return section('Users', h('div', {},
    h('div', { class: 'panel-row', style: { marginBottom: '10px' } }, search, go),
    rows,
  ));
}

async function renderGames() {
  const data = await KQ.get('/api/admin/games?limit=50');
  return section('Games', table(['Game', 'Creator', 'State', 'Stats', 'Moderation'], data.games ?? [], (game) =>
    h('tr', {},
      h('td', {}, h('div', {}, game.name), h('div', { class: 'dim' }, `${game.id} · ${game.genre}`)),
      h('td', {}, game.ownerName ?? '—'),
      h('td', {}, h('span', { class: `pill ${game.isPublished ? 'ok' : 'warn'}` }, game.isPublished ? 'published' : 'draft'),
        game.isPublic ? h('span', { class: 'pill' }, 'public') : h('span', { class: 'pill bad' }, 'unlisted')),
      h('td', {}, `${game.visitCount ?? 0} visits · ${game.likeCount ?? 0} likes`),
      h('td', {}, actionControls('game', game)),
    )));
}

async function renderReports() {
  const data = await KQ.get('/api/moderation/reports?limit=50');
  const rows = table(['Report', 'Target', 'Category', 'Status', 'Actions'], data.reports ?? [], (report) =>
    h('tr', {},
      h('td', {}, h('div', {}, `#${report.id.slice(-6)}`), h('div', { class: 'dim' }, `by ${report.reporterUsername ?? report.reporterId} · ${fmtDate(report.createdAt)}`)),
      h('td', {}, h('div', {}, report.targetType), h('div', { class: 'dim' }, report.targetId)),
      h('td', {}, report.category, h('div', { class: 'dim' }, (report.details ?? '').slice(0, 120))),
      h('td', {}, h('span', { class: `pill ${report.status === 'open' ? 'warn' : 'ok'}` }, report.status)),
      h('td', {}, h('div', { class: 'panel-row' },
        h('button', { class: 'chip', onclick: async () => {
          try {
            await KQ.post(`/api/moderation/reports/${report.id}`, { status: 'under_review' });
            toast('Report claimed.');
            route();
          } catch (error) { toast(error.message, 'error'); }
        } }, 'Review'),
        h('button', { class: 'chip', onclick: async () => {
          try {
            await KQ.post(`/api/moderation/reports/${report.id}`, { status: 'dismissed', resolution: 'No violation found.' });
            toast('Report dismissed.');
            route();
          } catch (error) { toast(error.message, 'error'); }
        } }, 'Dismiss'),
        h('button', { class: 'chip primary', onclick: async () => {
          try {
            await KQ.post(`/api/moderation/reports/${report.id}`, { status: 'actioned', resolution: 'Action taken.' });
            toast('Report actioned.');
            route();
          } catch (error) { toast(error.message, 'error'); }
        } }, 'Action'),
        actionControls(report.targetType, { id: report.targetId }),
      )),
    ));
  const appeals = await KQ.get('/api/moderation/appeals?status=open').catch(() => ({ appeals: [] }));
  const appealRows = table(['Appeal', 'User', 'Reason', 'Decision'], appeals.appeals ?? [], (appeal) =>
    h('tr', {},
      h('td', {}, appeal.id, h('div', { class: 'dim' }, fmtDate(appeal.createdAt))),
      h('td', {}, appeal.username ?? appeal.userId),
      h('td', {}, appeal.body ?? appeal.reason ?? ''),
      h('td', {}, h('div', { class: 'panel-row' },
        h('button', { class: 'chip primary', onclick: () => decideAppeal(appeal.id, 'approved') }, 'Approve'),
        h('button', { class: 'chip', onclick: () => decideAppeal(appeal.id, 'denied') }, 'Deny'),
      )),
    ));
  return h('div', {}, section(`Reports (${data.total ?? 0})`, rows), section('Appeals', appealRows));
}

async function decideAppeal(id, decision) {
  const notes = prompt('Decision notes:') ?? '';
  try {
    await KQ.post(`/api/moderation/appeals/${id}`, { decision, notes });
    toast(`Appeal ${decision}.`);
    route();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function renderAssets() {
  const data = await KQ.get('/api/admin/assets?limit=60');
  return section('Assets', table(['Asset', 'Owner', 'Type', 'Status', 'Moderation'], data.assets ?? [], (asset) =>
    h('tr', {},
      h('td', {}, h('div', {}, asset.name), h('div', { class: 'dim' }, `${asset.id} · ${Math.round((asset.sizeBytes ?? 0) / 1024)}KB`)),
      h('td', {}, asset.ownerUsername ?? asset.ownerUserId),
      h('td', {}, asset.assetType),
      h('td', {}, h('span', { class: `pill ${asset.moderationStatus === 'approved' ? 'ok' : 'warn'}` }, asset.moderationStatus)),
      h('td', {}, actionControls('asset', asset)),
    )));
}

async function renderServers() {
  const data = await KQ.get('/api/admin/servers');
  return section('Servers', table(['Server', 'Game', 'Version', 'Players', 'Status', 'Actions'], data.servers ?? [], (server) =>
    h('tr', {},
      h('td', {}, server.id ?? server.realmId),
      h('td', {}, server.gameName ?? server.gameId),
      h('td', {}, `v${server.versionNumber ?? '?'}`),
      h('td', {}, `${server.playerCount ?? 0}/${server.maxPlayers ?? 0}`),
      h('td', {}, h('span', { class: `pill ${server.status === 'running' ? 'ok' : 'warn'}` }, server.status)),
      h('td', {}, h('button', { class: 'chip', onclick: async () => {
        try {
          await KQ.post(`/api/admin/servers/${server.id ?? server.realmId}/stop`, {});
          toast('Server stopping.');
          route();
        } catch (error) { toast(error.message, 'error'); }
      } }, 'Stop')),
    )));
}

async function renderTransactions() {
  const data = await KQ.get('/api/admin/transactions?limit=60');
  return section('Transactions', table(['When', 'User', 'Kind', 'Amount', 'Balance after'], data.transactions ?? [], (entry) =>
    h('tr', {},
      h('td', {}, fmtDate(entry.createdAt)),
      h('td', {}, entry.username ?? entry.userId),
      h('td', {}, entry.kind, h('div', { class: 'dim' }, entry.reason ?? '')),
      h('td', {}, h('span', { class: `pill ${entry.amount >= 0 ? 'ok' : 'bad'}` }, String(entry.amount))),
      h('td', {}, String(entry.balanceAfter ?? '—')),
    )));
}

async function renderHistory() {
  const data = await KQ.get('/api/moderation/history?limit=60');
  const actions = table(['When', 'Moderator', 'Action', 'Target', 'Reason'], data.actions ?? [], (entry) =>
    h('tr', {},
      h('td', {}, fmtDate(entry.createdAt)),
      h('td', {}, entry.moderatorUsername ?? entry.moderatorId),
      h('td', {}, h('span', { class: 'pill' }, entry.action)),
      h('td', {}, `${entry.targetType} ${String(entry.targetId).slice(0, 12)}`),
      h('td', {}, entry.reason ?? ''),
    ));
  const audit = await KQ.get('/api/moderation/audit?limit=40').catch(() => ({ entries: [] }));
  const auditTable = table(['When', 'Actor', 'Action', 'Target'], audit.entries ?? [], (entry) =>
    h('tr', {},
      h('td', {}, fmtDate(entry.createdAt)),
      h('td', {}, entry.actorId ?? '—'),
      h('td', {}, entry.action),
      h('td', {}, `${entry.targetType ?? ''} ${entry.targetId ?? ''}`),
    ));
  return h('div', {}, section('Moderation actions', actions), section('Audit log', auditTable));
}

const RENDERERS = {
  overview: renderOverview,
  users: renderUsers,
  games: renderGames,
  reports: renderReports,
  assets: renderAssets,
  servers: renderServers,
  transactions: renderTransactions,
  history: renderHistory,
};

function renderNav() {
  const nav = document.getElementById('admin-nav');
  nav.innerHTML = '';
  for (const [key, label] of TABS) {
    nav.append(h('button', {
      class: `nav-link${state.tab === key ? ' active' : ''}`,
      onclick: () => {
        state.tab = key;
        renderNav();
        route();
      },
    }, label));
  }
}

async function route() {
  view.innerHTML = '';
  view.append(h('div', { class: 'loading' }, 'Loading…'));
  try {
    const node = await RENDERERS[state.tab]();
    view.innerHTML = '';
    view.append(node);
  } catch (error) {
    view.innerHTML = '';
    view.append(h('div', { class: 'panel error' }, h('h3', {}, 'Could not load that panel'),
      h('p', {}, error.message),
      h('p', { class: 'dim' }, 'Administration requires a moderator or administrator account.')));
  }
}

async function boot() {
  try {
    const session = await KQ.session();
    state.user = session.user;
  } catch {
    state.user = null;
  }
  const area = document.getElementById('user-area');
  area.innerHTML = '';
  if (!state.user) {
    view.innerHTML = '';
    view.append(h('div', { class: 'panel auth' },
      h('h2', {}, 'Administration'),
      h('p', { class: 'dim' }, 'Sign in with a moderator or administrator account to continue.'),
      h('a', { class: 'button primary', href: '/#/login' }, 'Go to sign in')));
    return;
  }
  area.append(
    h('span', { class: 'chip' }, `${state.user.displayName ?? state.user.username} (${state.user.role})`),
    h('a', { class: 'chip', href: '/' }, 'Back to site'),
  );
  if (!['moderator', 'admin'].includes(state.user.role)) {
    view.innerHTML = '';
    view.append(h('div', { class: 'panel error' },
      h('h3', {}, 'Insufficient permissions'),
      h('p', {}, 'Your account does not have moderation access. Ask an administrator if you need it.')));
    return;
  }
  renderNav();
  await route();
}

await boot();
