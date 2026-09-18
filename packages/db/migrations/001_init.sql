-- ============================================================================
-- Kinetiq platform schema, initial migration.
-- Every entity uses an opaque text ID; usernames are never foreign keys.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Accounts & authentication
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name        TEXT NOT NULL,
  email               TEXT UNIQUE COLLATE NOCASE,
  email_verified      INTEGER NOT NULL DEFAULT 0,
  email_verification_token TEXT,
  password_hash       TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'user',
  bio                 TEXT NOT NULL DEFAULT '',
  avatar_item_ids     TEXT NOT NULL DEFAULT '{}',   -- JSON: category -> item id (equipped)
  avatar_colors       TEXT NOT NULL DEFAULT '{}',   -- JSON: body part -> hex
  avatar_image_id     TEXT,
  status              TEXT NOT NULL DEFAULT 'active', -- active | suspended | deleted
  status_reason       TEXT,
  status_until        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at       TEXT,
  login_count         INTEGER NOT NULL DEFAULT 0,
  failed_login_count  INTEGER NOT NULL DEFAULT 0,
  locked_until        TEXT,
  presence            TEXT NOT NULL DEFAULT 'offline',
  presence_game_id    TEXT,
  presence_realm_id   TEXT,
  presence_updated_at TEXT,
  privacy             TEXT NOT NULL DEFAULT '{}',   -- JSON privacy settings
  settings            TEXT NOT NULL DEFAULT '{}',   -- JSON client/UI settings
  is_developer        INTEGER NOT NULL DEFAULT 0,
  is_verified_creator INTEGER NOT NULL DEFAULT 0,
  total_playtime_seconds INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_users_created ON users (created_at DESC);
CREATE INDEX idx_users_role ON users (role);
CREATE INDEX idx_users_presence ON users (presence);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash  TEXT NOT NULL,
  user_agent    TEXT,
  ip            TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

CREATE TABLE password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pwreset_user ON password_resets (user_id);

CREATE TABLE email_verifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT,
  ip          TEXT,
  successful  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_login_attempts_lookup ON login_attempts (username, created_at DESC);
CREATE INDEX idx_login_attempts_ip ON login_attempts (ip, created_at DESC);

-- Developer API keys
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT '[]',
  last_used_at TEXT,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT
);
CREATE INDEX idx_api_keys_user ON api_keys (user_id);

-- ---------------------------------------------------------------------------
-- Games, versions, servers
-- ---------------------------------------------------------------------------
CREATE TABLE games (
  id                TEXT PRIMARY KEY,
  owner_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  owner_group_id    TEXT REFERENCES groups(id) ON DELETE SET NULL,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  genre             TEXT NOT NULL DEFAULT 'Sandbox',
  tags              TEXT NOT NULL DEFAULT '[]',
  icon_asset_id     TEXT,
  thumbnail_asset_id TEXT,
  screenshots       TEXT NOT NULL DEFAULT '[]',
  max_players       INTEGER NOT NULL DEFAULT 12,
  is_public         INTEGER NOT NULL DEFAULT 0,
  is_published      INTEGER NOT NULL DEFAULT 0,
  is_featured       INTEGER NOT NULL DEFAULT 0,
  allow_private_servers INTEGER NOT NULL DEFAULT 1,
  private_server_price INTEGER NOT NULL DEFAULT 0,
  allow_copying     INTEGER NOT NULL DEFAULT 1,
  current_version_id TEXT,
  published_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  universe_id       TEXT,
  play_count        INTEGER NOT NULL DEFAULT 0,
  visit_count       INTEGER NOT NULL DEFAULT 0,
  like_count        INTEGER NOT NULL DEFAULT 0,
  dislike_count     INTEGER NOT NULL DEFAULT 0,
  favorite_count    INTEGER NOT NULL DEFAULT 0,
  active_players    INTEGER NOT NULL DEFAULT 0,
  peak_players      INTEGER NOT NULL DEFAULT 0,
  moderation_status TEXT NOT NULL DEFAULT 'approved',
  settings          TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_games_published ON games (is_published, is_public);
CREATE INDEX idx_games_owner ON games (owner_user_id);
CREATE INDEX idx_games_genre ON games (genre);
CREATE INDEX idx_games_playcount ON games (play_count DESC);
CREATE INDEX idx_games_updated ON games (updated_at DESC);
CREATE INDEX idx_games_created ON games (created_at DESC);
CREATE INDEX idx_games_active ON games (active_players DESC);

CREATE TABLE game_versions (
  id            TEXT PRIMARY KEY,
  game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  label         TEXT,
  changelog     TEXT NOT NULL DEFAULT '',
  manifest      TEXT NOT NULL,            -- JSON project manifest (world + script metadata)
  content_hash  TEXT NOT NULL,
  blob_hash     TEXT,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  script_count  INTEGER NOT NULL DEFAULT 0,
  part_count    INTEGER NOT NULL DEFAULT 0,
  published     INTEGER NOT NULL DEFAULT 0,
  published_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (game_id, version_number)
);
CREATE INDEX idx_versions_game ON game_versions (game_id, version_number DESC);

CREATE TABLE game_scripts (
  id           TEXT PRIMARY KEY,
  version_id   TEXT NOT NULL REFERENCES game_versions(id) ON DELETE CASCADE,
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- server | client | module
  source       TEXT NOT NULL,
  run_on_load  INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_game_scripts_version ON game_scripts (version_id);

CREATE TABLE game_stats_daily (
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  day          TEXT NOT NULL,
  plays        INTEGER NOT NULL DEFAULT 0,
  unique_players INTEGER NOT NULL DEFAULT 0,
  revenue      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, day)
);

CREATE TABLE game_likes (
  game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value      INTEGER NOT NULL DEFAULT 1,  -- 1 like, -1 dislike
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (game_id, user_id)
);

CREATE TABLE game_favorites (
  game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (game_id, user_id)
);

CREATE TABLE game_servers (
  id             TEXT PRIMARY KEY,
  game_id        TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  version_id     TEXT REFERENCES game_versions(id) ON DELETE SET NULL,
  private_server_id TEXT REFERENCES private_servers(id) ON DELETE SET NULL,
  region         TEXT NOT NULL DEFAULT 'local',
  host           TEXT NOT NULL DEFAULT '127.0.0.1',
  port           INTEGER NOT NULL DEFAULT 0,
  join_path      TEXT,
  status         TEXT NOT NULL DEFAULT 'starting',  -- starting | running | draining | stopped | failed
  current_players INTEGER NOT NULL DEFAULT 0,
  max_players    INTEGER NOT NULL DEFAULT 12,
  pid            INTEGER,
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat_at TEXT,
  ended_at       TEXT,
  error          TEXT,
  metadata       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_servers_game ON game_servers (game_id, status);
CREATE INDEX idx_servers_heartbeat ON game_servers (last_heartbeat_at DESC);

CREATE TABLE server_joins (
  id         TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL REFERENCES game_servers(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
  left_at    TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  session_token_hash TEXT
);
CREATE INDEX idx_server_joins_user ON server_joins (user_id, joined_at DESC);
CREATE INDEX idx_server_joins_server ON server_joins (server_id);

CREATE TABLE private_servers (
  id           TEXT PRIMARY KEY,
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT 'Private server',
  join_code    TEXT NOT NULL UNIQUE,
  active       INTEGER NOT NULL DEFAULT 1,
  max_players  INTEGER NOT NULL DEFAULT 12,
  price_paid   INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_private_servers_game ON private_servers (game_id);
CREATE INDEX idx_private_servers_owner ON private_servers (owner_user_id);

CREATE TABLE private_server_members (
  private_server_id TEXT NOT NULL REFERENCES private_servers(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (private_server_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Social graph
-- ---------------------------------------------------------------------------
CREATE TABLE friend_requests (
  id           TEXT PRIMARY KEY,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined | cancelled
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT,
  UNIQUE (from_user_id, to_user_id)
);
CREATE INDEX idx_friend_requests_to ON friend_requests (to_user_id, status);
CREATE INDEX idx_friend_requests_from ON friend_requests (from_user_id, status);

CREATE TABLE friends (
  user_a_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  status      TEXT NOT NULL DEFAULT 'accepted',
  PRIMARY KEY (user_a_id, user_b_id)
);
CREATE INDEX idx_friends_b ON friends (user_b_id);

CREATE TABLE followers (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (follower_id, target_id)
);
CREATE INDEX idx_followers_target ON followers (target_id);
CREATE INDEX idx_followers_follower ON followers (follower_id);

CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (blocker_id, blocked_id)
);

-- ---------------------------------------------------------------------------
-- Messaging, chat, notifications
-- ---------------------------------------------------------------------------
CREATE TABLE message_threads (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'direct', -- direct | group
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE thread_participants (
  thread_id  TEXT NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_read_at TEXT,
  muted      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX idx_thread_participants_user ON thread_participants (user_id);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT REFERENCES message_threads(id) ON DELETE CASCADE,
  sender_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  recipient_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'direct', -- direct | game | system
  body       TEXT NOT NULL,
  body_filtered TEXT,
  game_id    TEXT REFERENCES games(id) ON DELETE SET NULL,
  server_id  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at    TEXT,
  moderation_state TEXT NOT NULL DEFAULT 'visible'
);
CREATE INDEX idx_messages_thread ON messages (thread_id, created_at DESC);
CREATE INDEX idx_messages_recipient ON messages (recipient_id, created_at DESC);
CREATE INDEX idx_messages_game ON messages (game_id, created_at DESC);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT,
  data       TEXT NOT NULL DEFAULT '{}',
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications (user_id, read_at);

-- ---------------------------------------------------------------------------
-- Economy: balances, transactions, products
-- ---------------------------------------------------------------------------
CREATE TABLE currency_balances (
  user_id   TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance   INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_earned INTEGER NOT NULL DEFAULT 0,
  lifetime_spent  INTEGER NOT NULL DEFAULT 0,
  pending_earnings INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE transactions (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  from_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  to_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  amount      INTEGER NOT NULL,
  balance_after INTEGER,
  game_id     TEXT REFERENCES games(id) ON DELETE SET NULL,
  asset_id    TEXT,
  item_id     TEXT,
  product_id  TEXT,
  private_server_id TEXT,
  description TEXT NOT NULL DEFAULT '',
  metadata    TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_transactions_from ON transactions (from_user_id, created_at DESC);
CREATE INDEX idx_transactions_to ON transactions (to_user_id, created_at DESC);
CREATE INDEX idx_transactions_kind ON transactions (kind, created_at DESC);

CREATE TABLE game_products (
  id           TEXT PRIMARY KEY,
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,               -- pass | developer_product
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  icon_asset_id TEXT,
  price        INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_game_products_game ON game_products (game_id, active);

CREATE TABLE product_ownership (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES game_products(id) ON DELETE CASCADE,
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quantity     INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, user_id)
);
CREATE INDEX idx_product_ownership_user ON product_ownership (user_id, game_id);

-- ---------------------------------------------------------------------------
-- Assets & avatar marketplace
-- ---------------------------------------------------------------------------
CREATE TABLE assets (
  id             TEXT PRIMARY KEY,
  owner_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  owner_group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  asset_type     TEXT NOT NULL,             -- image | mesh | model | audio | animation | material | package
  mime_type      TEXT NOT NULL DEFAULT 'application/octet-stream',
  storage_key    TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  hash           TEXT NOT NULL,
  metadata       TEXT NOT NULL DEFAULT '{}',
  moderation_status TEXT NOT NULL DEFAULT 'approved',
  moderation_note TEXT,
  is_public      INTEGER NOT NULL DEFAULT 1,
  is_for_sale    INTEGER NOT NULL DEFAULT 0,
  price          INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  version        INTEGER NOT NULL DEFAULT 1,
  downloads      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_assets_owner ON assets (owner_user_id, created_at DESC);
CREATE INDEX idx_assets_type ON assets (asset_type, is_public);
CREATE INDEX idx_assets_hash ON assets (hash);

CREATE TABLE game_assets (
  game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  asset_id    TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  usage       TEXT NOT NULL DEFAULT 'generic',
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (game_id, asset_id)
);

CREATE TABLE avatar_items (
  id            TEXT PRIMARY KEY,
  creator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  creator_group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL,
  asset_id      TEXT REFERENCES assets(id) ON DELETE SET NULL,
  thumbnail_asset_id TEXT,
  attachment    TEXT NOT NULL DEFAULT '{}',  -- JSON: bone/offset/scale for the mesh on the rig
  colors        TEXT NOT NULL DEFAULT '[]',  -- JSON array of hex strings
  price         INTEGER NOT NULL DEFAULT 0,
  is_limited    INTEGER NOT NULL DEFAULT 0,
  is_for_sale   INTEGER NOT NULL DEFAULT 1,
  stock         INTEGER,
  moderation_status TEXT NOT NULL DEFAULT 'approved',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  sales         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_avatar_items_category ON avatar_items (category, is_for_sale);
CREATE INDEX idx_avatar_items_creator ON avatar_items (creator_user_id);

CREATE TABLE inventory (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                 -- avatar_item | game_item | asset | badge | package
  ref_id     TEXT NOT NULL,
  quantity   INTEGER NOT NULL DEFAULT 1,
  acquired_via TEXT NOT NULL DEFAULT 'grant',
  metadata   TEXT NOT NULL DEFAULT '{}',
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, kind, ref_id)
);
CREATE INDEX idx_inventory_user ON inventory (user_id, kind);

-- ---------------------------------------------------------------------------
-- Badges
-- ---------------------------------------------------------------------------
CREATE TABLE badges (
  id            TEXT PRIMARY KEY,
  game_id       TEXT REFERENCES games(id) ON DELETE CASCADE,
  creator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  icon_asset_id TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  award_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_badges_game ON badges (game_id);

CREATE TABLE player_badges (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id   TEXT NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  awarded_at TEXT NOT NULL DEFAULT (datetime('now')),
  game_id    TEXT REFERENCES games(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, badge_id)
);
CREATE INDEX idx_player_badges_badge ON player_badges (badge_id);

-- ---------------------------------------------------------------------------
-- Groups
-- ---------------------------------------------------------------------------
CREATE TABLE groups (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  slug          TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emblem_asset_id TEXT,
  is_public     INTEGER NOT NULL DEFAULT 1,
  member_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE group_members (
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',
  joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_group_members_user ON group_members (user_id);

CREATE TABLE group_posts (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  author_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  pinned     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_group_posts_group ON group_posts (group_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Persistent player data (per game, isolated)
-- ---------------------------------------------------------------------------
CREATE TABLE player_game_data (
  game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_name TEXT NOT NULL DEFAULT 'default',
  payload    TEXT NOT NULL DEFAULT '{}',
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (game_id, user_id, store_name)
);
CREATE INDEX idx_player_game_data_game ON player_game_data (game_id, updated_at DESC);

CREATE TABLE player_stats (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  visits     INTEGER NOT NULL DEFAULT 0,
  playtime_seconds INTEGER NOT NULL DEFAULT 0,
  last_played_at TEXT,
  PRIMARY KEY (user_id, game_id)
);
CREATE INDEX idx_player_stats_user ON player_stats (user_id, last_played_at DESC);

-- ---------------------------------------------------------------------------
-- Moderation & administration
-- ---------------------------------------------------------------------------
CREATE TABLE reports (
  id            TEXT PRIMARY KEY,
  reporter_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_type   TEXT NOT NULL,     -- user | game | asset | message | group
  target_id     TEXT NOT NULL,
  category      TEXT NOT NULL,
  details       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',
  assigned_to   TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolution    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reports_status ON reports (status, created_at DESC);
CREATE INDEX idx_reports_target ON reports (target_type, target_id);

CREATE TABLE moderation_actions (
  id           TEXT PRIMARY KEY,
  moderator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  action       TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER,
  expires_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  report_id    TEXT REFERENCES reports(id) ON DELETE SET NULL,
  metadata     TEXT NOT NULL DEFAULT '{}',
  active       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_moderation_target ON moderation_actions (target_type, target_id, created_at DESC);
CREATE INDEX idx_moderation_moderator ON moderation_actions (moderator_id, created_at DESC);

CREATE TABLE moderation_appeals (
  id            TEXT PRIMARY KEY,
  action_id     TEXT NOT NULL REFERENCES moderation_actions(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  reviewed_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  review_note   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at   TEXT
);
CREATE INDEX idx_appeals_status ON moderation_appeals (status, created_at DESC);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  target_type TEXT,
  target_id  TEXT,
  metadata   TEXT NOT NULL DEFAULT '{}',
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_actor ON audit_log (actor_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_log (action, created_at DESC);

-- ---------------------------------------------------------------------------
-- Feature flags / platform meta
-- ---------------------------------------------------------------------------
CREATE TABLE platform_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
