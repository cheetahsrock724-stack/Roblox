/**
 * Virtual currency: balances, atomic transfers and the transaction ledger.
 *
 * Every balance mutation goes through `postTransaction`, which:
 *   1. runs inside a single SQLite transaction,
 *   2. enforces a non-negative balance with a CHECK constraint plus an explicit guard,
 *   3. records an immutable ledger row (with balance_after for auditing),
 *   4. supports idempotency keys so retries cannot double-charge a player.
 */
import { all, get, run, transaction } from '../db.js';
import { ids, ValidationError, ForbiddenError } from '@kinetiq/shared';

export function getBalance(userId) {
  const row = get('SELECT * FROM currency_balances WHERE user_id = ?', [userId]);
  if (!row) {
    run('INSERT OR IGNORE INTO currency_balances (user_id, balance) VALUES (?, 0)', [userId]);
    return { user_id: userId, balance: 0, lifetime_earned: 0, lifetime_spent: 0, pending_earnings: 0 };
  }
  return row;
}

export function balanceOf(userId) {
  return getBalance(userId).balance;
}

/**
 * @param {object} input
 * @param {string} input.kind
 * @param {string|null} input.fromUserId  payer (may be null for system grants)
 * @param {string|null} input.toUserId    payee (may be null for system sinks)
 * @param {number} input.amount           always positive; direction decided by from/to
 */
export function postTransaction({
  kind,
  fromUserId = null,
  toUserId = null,
  amount,
  gameId = null,
  assetId = null,
  itemId = null,
  productId = null,
  privateServerId = null,
  description = '',
  metadata = {},
  idempotencyKey = null,
}) {
  const value = Math.trunc(Number(amount));
  if (!Number.isFinite(value) || value <= 0) throw new ValidationError('Transaction amount must be a positive integer.');
  if (idempotencyKey) {
    const existing = get('SELECT * FROM transactions WHERE idempotency_key = ?', [idempotencyKey]);
    if (existing) return { transaction: existing, duplicate: true };
  }
  return transaction(() => {
    let balanceAfter = null;
    if (fromUserId) {
      const balance = getBalance(fromUserId);
      if (balance.balance < value) throw new ForbiddenError('Insufficient funds.');
      balanceAfter = balance.balance - value;
      run(
        `UPDATE currency_balances SET balance = ?, lifetime_spent = lifetime_spent + ?, updated_at = datetime('now')
         WHERE user_id = ?`,
        [balanceAfter, value, fromUserId],
      );
    }
    if (toUserId) {
      const balance = getBalance(toUserId);
      const next = balance.balance + value;
      run(
        `UPDATE currency_balances SET balance = ?, lifetime_earned = lifetime_earned + ?, updated_at = datetime('now')
         WHERE user_id = ?`,
        [next, value, toUserId],
      );
      if (!fromUserId) balanceAfter = next;
    }
    const id = ids.transaction();
    run(
      `INSERT INTO transactions (id, kind, from_user_id, to_user_id, amount, balance_after, game_id, asset_id, item_id,
        product_id, private_server_id, description, metadata, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        kind,
        fromUserId,
        toUserId,
        value,
        balanceAfter,
        gameId,
        assetId,
        itemId,
        productId,
        privateServerId,
        String(description).slice(0, 300),
        JSON.stringify(metadata ?? {}),
        idempotencyKey,
      ],
    );
    return { transaction: get('SELECT * FROM transactions WHERE id = ?', [id]), balanceAfter };
  });
}

/** Convenience: system grants currency to a user (signup bonus, payouts, refunds). */
export function grantCredits(userId, amount, kind = 'adjustment', extra = {}) {
  return postTransaction({ kind, toUserId: userId, amount, description: extra.description ?? kind, ...extra });
}

export function spendCredits(userId, amount, kind = 'purchase', extra = {}) {
  return postTransaction({ kind, fromUserId: userId, amount, description: extra.description ?? kind, ...extra });
}

export function transactionHistory(userId, { limit = 50, offset = 0 } = {}) {
  return all(
    `SELECT t.*, fu.username AS from_username, tu.username AS to_username, g.name AS game_name
     FROM transactions t
     LEFT JOIN users fu ON fu.id = t.from_user_id
     LEFT JOIN users tu ON tu.id = t.to_user_id
     LEFT JOIN games g ON g.id = t.game_id
     WHERE t.from_user_id = ? OR t.to_user_id = ?
     ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
    [userId, userId, limit, offset],
  );
}

export function allTransactions({ limit = 100, offset = 0, kind = null } = {}) {
  const where = kind ? 'WHERE t.kind = ?' : '';
  const params = kind ? [kind] : [];
  const rows = all(
    `SELECT t.*, fu.username AS from_username, tu.username AS to_username, g.name AS game_name
     FROM transactions t
     LEFT JOIN users fu ON fu.id = t.from_user_id
     LEFT JOIN users tu ON tu.id = t.to_user_id
     LEFT JOIN games g ON g.id = t.game_id
     ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const total = get(`SELECT COUNT(*) AS n FROM transactions t ${where}`, params)?.n ?? 0;
  return { rows, total };
}

export function developerEarnings(userId) {
  const row = get(
    `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM transactions
     WHERE to_user_id = ? AND kind IN ('sale','payout','developer_product_purchase','game_pass_purchase','private_server_purchase')`,
    [userId],
  );
  return { total: row?.total ?? 0, count: row?.count ?? 0 };
}

/** Game products: passes (permanent) and developer products (repeatable). */
export function createProduct({ gameId, kind, name, description = '', iconAssetId = null, price = 0 }) {
  const id = ids.product();
  run(
    `INSERT INTO game_products (id, game_id, kind, name, description, icon_asset_id, price)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, gameId, kind, String(name).slice(0, 80), String(description).slice(0, 500), iconAssetId, Math.max(0, Math.trunc(price))],
  );
  return getProduct(id);
}

export function getProduct(productId) {
  return get('SELECT * FROM game_products WHERE id = ?', [productId]);
}

export function listProducts(gameId, { kind = null, includeInactive = false } = {}) {
  const conditions = ['game_id = ?'];
  const params = [gameId];
  if (kind) {
    conditions.push('kind = ?');
    params.push(kind);
  }
  if (!includeInactive) conditions.push('active = 1');
  return all(`SELECT * FROM game_products WHERE ${conditions.join(' AND ')} ORDER BY price ASC`, params);
}

export function updateProduct(productId, patch) {
  const fields = [];
  const params = [];
  for (const [key, column] of Object.entries({ name: 'name', description: 'description', price: 'price', active: 'active', iconAssetId: 'icon_asset_id' })) {
    if (patch[key] === undefined) continue;
    fields.push(`${column} = ?`);
    params.push(typeof patch[key] === 'boolean' ? (patch[key] ? 1 : 0) : patch[key]);
  }
  if (!fields.length) return getProduct(productId);
  params.push(productId);
  run(`UPDATE game_products SET ${fields.join(', ')} WHERE id = ?`, params);
  return getProduct(productId);
}

export function ownsProduct(productId, userId) {
  return Boolean(
    get('SELECT 1 AS x FROM product_ownership WHERE product_id = ? AND user_id = ?', [productId, userId]),
  );
}

export function ownedProducts(gameId, userId) {
  return all(
    `SELECT p.*, o.quantity, o.created_at AS owned_at FROM product_ownership o
     JOIN game_products p ON p.id = o.product_id
     WHERE o.game_id = ? AND o.user_id = ?`,
    [gameId, userId],
  );
}

export function grantProduct(productId, userId, { quantity = 1, gameId = null, consume = false } = {}) {
  return transaction(() => {
    const product = getProduct(productId);
    if (!product) throw new ValidationError('Unknown product.');
    const id = `own_${ids.transaction().slice(4, 20)}`;
    if (consume) {
      const existing = get('SELECT * FROM product_ownership WHERE product_id = ? AND user_id = ?', [productId, userId]);
      if (existing) {
        run('UPDATE product_ownership SET quantity = quantity + ? WHERE id = ?', [quantity, existing.id]);
      } else {
        run(
          `INSERT INTO product_ownership (id, product_id, game_id, user_id, quantity) VALUES (?, ?, ?, ?, ?)`,
          [id, productId, gameId ?? product.game_id, userId, quantity],
        );
      }
    } else {
      run(
        `INSERT OR IGNORE INTO product_ownership (id, product_id, game_id, user_id, quantity) VALUES (?, ?, ?, ?, ?)`,
        [id, productId, gameId ?? product.game_id, userId, quantity],
      );
    }
    return get('SELECT * FROM product_ownership WHERE product_id = ? AND user_id = ?', [productId, userId]);
  });
}

/** Revenue split: creator receives `share` (default 70%) of the purchase price. */
export function creatorShareOf(amount, share) {
  return Math.floor(Math.max(0, amount) * share);
}
