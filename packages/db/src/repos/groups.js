/** Communities: groups, roles, members and wall posts. */
import { all, get, run, transaction } from '../db.js';
import { ids, GROUP_PERMISSIONS, ForbiddenError } from '@kinetiq/shared';

function slugifyName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'group';
}

export function createGroup({ name, description = '', ownerUserId, isPublic = true, emblemAssetId = null }) {
  return transaction(() => {
    const id = ids.group();
    let slug = slugifyName(name);
    let suffix = 2;
    while (get('SELECT 1 AS x FROM groups WHERE slug = ?', [slug])) {
      slug = `${slugifyName(name)}-${suffix}`;
      suffix += 1;
    }
    run(
      `INSERT INTO groups (id, name, slug, description, owner_user_id, is_public, emblem_asset_id, member_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [id, String(name).slice(0, 60), slug, String(description).slice(0, 2000), ownerUserId, isPublic ? 1 : 0, emblemAssetId],
    );
    run('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', [id, ownerUserId, 'owner']);
    return getGroup(id);
  });
}

export function getGroup(idOrSlug) {
  return get(
    `SELECT gr.*, u.username AS owner_username FROM groups gr LEFT JOIN users u ON u.id = gr.owner_user_id
     WHERE gr.id = ? OR gr.slug = ?`,
    [idOrSlug, idOrSlug],
  );
}

export function listGroups({ query = null, limit = 30, offset = 0, memberUserId = null } = {}) {
  const conditions = [];
  const params = [];
  if (query) {
    conditions.push('(gr.name LIKE ? OR gr.description LIKE ?)');
    params.push(`%${query}%`, `%${query}%`);
  }
  let join = '';
  if (memberUserId) {
    join = 'JOIN group_members gm ON gm.group_id = gr.id AND gm.user_id = ?';
    params.unshift(memberUserId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return all(
    `SELECT gr.*, u.username AS owner_username FROM groups gr
     LEFT JOIN users u ON u.id = gr.owner_user_id ${join} ${where}
     ORDER BY gr.member_count DESC, gr.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
}

export function updateGroup(groupId, patch) {
  const fields = [];
  const params = [];
  for (const [key, column] of Object.entries({
    name: 'name',
    description: 'description',
    isPublic: 'is_public',
    emblemAssetId: 'emblem_asset_id',
  })) {
    if (patch[key] === undefined) continue;
    fields.push(`${column} = ?`);
    params.push(typeof patch[key] === 'boolean' ? (patch[key] ? 1 : 0) : patch[key]);
  }
  if (!fields.length) return getGroup(groupId);
  fields.push(`updated_at = datetime('now')`);
  params.push(groupId);
  run(`UPDATE groups SET ${fields.join(', ')} WHERE id = ?`, params);
  return getGroup(groupId);
}

export function groupMember(groupId, userId) {
  return get('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
}

export function groupMembers(groupId, { limit = 100, offset = 0 } = {}) {
  return all(
    `SELECT gm.*, u.username, u.display_name, u.presence, u.avatar_item_ids FROM group_members gm
     JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?
     ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, gm.joined_at
     LIMIT ? OFFSET ?`,
    [groupId, limit, offset],
  );
}

export function joinGroup(groupId, userId, role = 'member') {
  return transaction(() => {
    const existing = groupMember(groupId, userId);
    if (existing) return existing;
    run('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', [groupId, userId, role]);
    run('UPDATE groups SET member_count = member_count + 1 WHERE id = ?', [groupId]);
    return groupMember(groupId, userId);
  });
}

export function leaveGroup(groupId, userId) {
  return transaction(() => {
    const member = groupMember(groupId, userId);
    if (!member) return false;
    if (member.role === 'owner') throw new ForbiddenError('The group owner cannot leave; transfer ownership first.');
    run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    run('UPDATE groups SET member_count = MAX(0, member_count - 1) WHERE id = ?', [groupId]);
    return true;
  });
}

export function setMemberRole(groupId, userId, role) {
  run('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?', [role, groupId, userId]);
  return groupMember(groupId, userId);
}

export function kickMember(groupId, userId) {
  return leaveGroup(groupId, userId);
}

export function hasPermission(groupId, userId, permission) {
  const member = groupMember(groupId, userId);
  if (!member) return false;
  return (GROUP_PERMISSIONS[member.role] ?? []).includes(permission);
}

export function createPost(groupId, authorId, body, { pinned = false } = {}) {
  const id = `pst_${ids.group().slice(4, 18)}`;
  run('INSERT INTO group_posts (id, group_id, author_id, body, pinned) VALUES (?, ?, ?, ?, ?)', [
    id,
    groupId,
    authorId,
    String(body).slice(0, 4000),
    pinned ? 1 : 0,
  ]);
  return get('SELECT * FROM group_posts WHERE id = ?', [id]);
}

export function listPosts(groupId, { limit = 30, offset = 0 } = {}) {
  return all(
    `SELECT p.*, u.username, u.display_name FROM group_posts p LEFT JOIN users u ON u.id = p.author_id
     WHERE p.group_id = ? ORDER BY p.pinned DESC, p.created_at DESC LIMIT ? OFFSET ?`,
    [groupId, limit, offset],
  );
}

export function deletePost(postId, userId, isGroupAdmin = false) {
  const post = get('SELECT * FROM group_posts WHERE id = ?', [postId]);
  if (!post) return false;
  if (post.author_id !== userId && !isGroupAdmin) return false;
  run('DELETE FROM group_posts WHERE id = ?', [postId]);
  return true;
}
