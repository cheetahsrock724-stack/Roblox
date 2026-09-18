/**
 * Shared constants: game categories, avatar item categories, moderation actions, privacy scopes,
 * notification kinds, and engine limits used by both server and client.
 */

export const GAME_CATEGORIES = [
  'Adventure',
  'Simulation',
  'Roleplay',
  'Fighting',
  'Racing',
  'Horror',
  'Sandbox',
  'Obby',
  'Shooter',
  'Party',
  'Social',
  'Puzzle',
  'Building',
  'Other',
];

export const DISCOVER_SORTS = ['popular', 'most_played', 'trending', 'new', 'updated', 'recommended'];

export const ASSET_TYPES = ['image', 'mesh', 'model', 'audio', 'animation', 'material', 'package'];

export const ASSET_MODERATION = ['pending', 'approved', 'rejected', 'removed'];

export const AVATAR_CATEGORIES = [
  'head',
  'face',
  'hair',
  'shirt',
  'pants',
  'shoes',
  'hat',
  'accessory',
  'back',
  'bodycolor',
  'package',
];

/** Categories that a player can equip one of at a time. */
export const AVATAR_EXCLUSIVE_CATEGORIES = [
  'head',
  'face',
  'hair',
  'shirt',
  'pants',
  'shoes',
  'hat',
  'back',
  'package',
];

export const GROUP_ROLES = ['owner', 'admin', 'moderator', 'member'];

export const GROUP_PERMISSIONS = {
  owner: ['manage_group', 'manage_roles', 'manage_members', 'manage_games', 'manage_assets', 'post', 'kick'],
  admin: ['manage_roles', 'manage_members', 'manage_games', 'manage_assets', 'post', 'kick'],
  moderator: ['manage_members', 'post', 'kick'],
  member: ['post'],
};

export const MODERATION_ACTIONS = [
  'warn',
  'mute',
  'kick',
  'ban_temporary',
  'ban_permanent',
  'unban',
  'remove_asset',
  'restore_asset',
  'unpublish_game',
  'republish_game',
  'reset_password',
  'note',
];

export const REPORT_CATEGORIES = [
  'harassment',
  'spam',
  'scam',
  'inappropriate_content',
  'ip_infringement',
  'exploiting',
  'underage',
  'other',
];

export const REPORT_STATUSES = ['open', 'under_review', 'actioned', 'dismissed', 'appealed'];

export const NOTIFICATION_KINDS = [
  'friend_request',
  'friend_accepted',
  'game_invite',
  'badge_earned',
  'purchase',
  'creator_update',
  'moderation',
  'group',
  'system',
];

export const PRESENCE_STATUSES = ['offline', 'online', 'creating', 'playing'];

export const PRIVACY_KEYS = [
  'whoCanMessage',
  'whoCanJoin',
  'whoCanSeeInventory',
  'whoCanFriendRequest',
  'whoCanInvite',
  'whoCanSeeActivity',
];

export const PRIVACY_VALUES = ['everyone', 'friends', 'nobody'];

export const USER_ROLES = ['user', 'moderator', 'admin'];

export const TRANSACTION_KINDS = [
  'signup_bonus',
  'daily_bonus',
  'purchase',
  'sale',
  'payout',
  'refund',
  'adjustment',
  'game_pass_purchase',
  'developer_product_purchase',
  'private_server_purchase',
  'marketplace_purchase',
];

export const ENGINE_LIMITS = {
  maxPartsPerWorld: 200_000,
  maxScriptExecutionMs: 50,
  maxScriptInstructionsPerCall: 4_000_000,
  maxRemoteEventBytes: 8 * 1024,
  maxRemoteCallsPerSecond: 60,
  maxDataStoreValueBytes: 64 * 1024,
  maxDataStoreKeysPerGame: 5_000_000,
  maxAssetUploadBytes: 12 * 1024 * 1024,
  maxMeshTriangles: 200_000,
  maxAudioSeconds: 600,
  maxImageDimension: 4096,
  worldSnapshotRateHz: 20,
  realmTickRateHz: 60,
  defaultWalkSpeed: 18,
  defaultRunSpeed: 28,
  defaultJumpPower: 32,
  defaultGravity: -90,
};

/** Object classes creators can insert. Shared by editor, engine, and docs. */
export const INSTANCE_CLASSES = [
  'World',
  'Players',
  'Lighting',
  'SharedStorage',
  'ServerScripts',
  'ClientScripts',
  'UI',
  'Audio',
  'Assets',
  'Folder',
  'Model',
  'Part',
  'Mesh',
  'Light',
  'Camera',
  'Sound',
  'SpawnPoint',
  'Script',
  'Frame',
  'TextLabel',
  'TextButton',
  'ImageLabel',
  'InputField',
  'ScrollingList',
  'ProgressBar',
  'Viewport',
  'ParticleEmitter',
  'VehicleSeat',
  'Interactable',
  'NPC',
  'Badge',
  'Terrain',
  'RemoteEvent',
  'RemoteFunction',
  'DataStore',
  'Truss',
  'Wedge',
];

export const MATERIALS = [
  { id: 'plastic', friction: 0.45, restitution: 0.15, density: 1 },
  { id: 'smoothplastic', friction: 0.25, restitution: 0.2, density: 1 },
  { id: 'metal', friction: 0.4, restitution: 0.1, density: 7.8 },
  { id: 'wood', friction: 0.5, restitution: 0.12, density: 0.7 },
  { id: 'concrete', friction: 0.7, restitution: 0.05, density: 2.4 },
  { id: 'brick', friction: 0.65, restitution: 0.05, density: 2.2 },
  { id: 'glass', friction: 0.2, restitution: 0.35, density: 2.5 },
  { id: 'ice', friction: 0.05, restitution: 0.1, density: 0.9 },
  { id: 'neon', friction: 0.3, restitution: 0.2, density: 1 },
  { id: 'grass', friction: 0.6, restitution: 0.05, density: 1.2 },
  { id: 'sand', friction: 0.55, restitution: 0.02, density: 1.6 },
  { id: 'water', friction: 0.05, restitution: 0, density: 1 },
  { id: 'fabric', friction: 0.6, restitution: 0.02, density: 0.4 },
  { id: 'forcefield', friction: 0.1, restitution: 0.9, density: 0.1 },
];

export const GRAPHICS_PRESETS = ['low', 'medium', 'high', 'auto'];

export default {
  GAME_CATEGORIES,
  DISCOVER_SORTS,
  ASSET_TYPES,
  AVATAR_CATEGORIES,
  ENGINE_LIMITS,
  INSTANCE_CLASSES,
  MODERATION_ACTIONS,
  REPORT_CATEGORIES,
  NOTIFICATION_KINDS,
  PRESENCE_STATUSES,
  PRIVACY_KEYS,
  PRIVACY_VALUES,
  USER_ROLES,
  TRANSACTION_KINDS,
  GRAPHICS_PRESETS,
};
