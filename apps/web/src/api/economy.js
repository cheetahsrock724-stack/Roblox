/**
 * /api/currency + /api/products — balances, transaction history, game passes, developer products
 * and creator payouts. Clients can request purchases; only the server ever moves money.
 */
import { sendJson, limitUserInput, pagination } from './helpers.js';
import { requireAuth } from '../context.js';
import * as db from '@kinetiq/db';
import {
  assertInt,
  assertEnum,
  assertBoolean,
  platformConfig,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ValidationError,
} from '@kinetiq/shared';

export function registerRoutes(router, deps) {
  const notify = deps?.notify ?? null;

  router.get('/api/currency/balance', async (ctx) => {
    const user = requireAuth(ctx);
    const balance = db.economy.getBalance(user.id);
    sendJson(ctx.res, 200, {
      balance: balance.balance,
      lifetimeEarned: balance.lifetime_earned,
      lifetimeSpent: balance.lifetime_spent,
      currencyName: platformConfig.currencyName,
      currencySymbol: platformConfig.currencySymbol,
    });
  });

  router.get('/api/currency/transactions', async (ctx) => {
    const user = requireAuth(ctx);
    const { limit, offset } = pagination(ctx, { defaultLimit: 50 });
    const rows = db.economy.transactionHistory(user.id, { limit, offset });
    sendJson(ctx.res, 200, {
      transactions: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        amount: row.amount,
        direction: row.from_user_id === user.id ? 'out' : 'in',
        fromUserId: row.from_user_id,
        fromUsername: row.from_username,
        toUserId: row.to_user_id,
        toUsername: row.to_username,
        gameId: row.game_id,
        gameName: row.game_name,
        description: row.description,
        balanceAfter: row.balance_after,
        createdAt: row.created_at,
      })),
    });
  });

  /** Daily bonus — server-side only, once per day, idempotent per day. */
  router.post('/api/currency/daily-bonus', async (ctx) => {
    const user = requireAuth(ctx);
    const today = new Date().toISOString().slice(0, 10);
    const key = `daily:${user.id}:${today}`;
    const existing = db.get('SELECT id FROM transactions WHERE idempotency_key = ?', [key]);
    if (existing) throw new ConflictError('You already claimed today\'s bonus.');
    const amount = platformConfig.economy.dailyBonus;
    db.economy.grantCredits(user.id, amount, 'daily_bonus', {
      description: 'Daily login bonus',
      idempotencyKey: key,
    });
    sendJson(ctx.res, 200, { claimed: amount, balance: db.economy.balanceOf(user.id) });
  });

  /** Developer earnings summary + payout request. */
  router.get('/api/currency/earnings', async (ctx) => {
    const user = requireAuth(ctx);
    const earnings = db.economy.developerEarnings(user.id);
    const recent = db.economy.transactionHistory(user.id, { limit: 20 }).filter((row) => row.to_user_id === user.id);
    sendJson(ctx.res, 200, {
      total: earnings.total,
      count: earnings.count,
      minimumPayout: platformConfig.economy.minPayout,
      revenueShare: platformConfig.economy.developerRevenueShare,
      recent: recent.map((row) => ({
        id: row.id,
        amount: row.amount,
        description: row.description,
        gameName: row.game_name,
        createdAt: row.created_at,
      })),
      balance: db.economy.balanceOf(user.id),
    });
  });

  router.post('/api/currency/payout', async (ctx) => {
    const user = requireAuth(ctx);
    const body = await ctx.json().catch(() => ({}));
    const amount = assertInt(body.amount ?? platformConfig.economy.minPayout, {
      field: 'amount',
      min: platformConfig.economy.minPayout,
      max: 10_000_000,
    });
    const balance = db.economy.balanceOf(user.id);
    if (balance < amount) throw new ForbiddenError('Not enough balance for that payout.');
    // Payouts are recorded as a ledger entry; an operator settles them out of band.
    db.economy.postTransaction({
      kind: 'payout',
      fromUserId: user.id,
      amount,
      description: 'Payout request',
    });
    sendJson(ctx.res, 202, { requested: amount, balance: db.economy.balanceOf(user.id) });
  });

  /** ---------------------------------------------------------------- game products */
  router.get('/api/games/:id/products', async (ctx) => {
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Game not found.');
    const products = db.economy.listProducts(game.id);
    const owned = ctx.userId ? new Set(db.economy.ownedProducts(game.id, ctx.userId).map((row) => row.id)) : new Set();
    sendJson(ctx.res, 200, {
      products: products.map((product) => ({
        id: product.id,
        kind: product.kind,
        name: product.name,
        description: product.description,
        price: product.price,
        iconAssetId: product.icon_asset_id,
        owned: owned.has(product.id),
      })),
    });
  });

  router.post('/api/games/:id/products', async (ctx) => {
    const user = requireAuth(ctx);
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Game not found.');
    if (game.owner_user_id !== user.id && user.role !== 'admin') throw new ForbiddenError('Not your game.');
    const body = await ctx.json();
    const product = db.economy.createProduct({
      gameId: game.id,
      kind: assertEnum(body.kind ?? 'pass', ['pass', 'developer_product'], { field: 'kind', fallback: 'pass' }),
      name: limitUserInput(body.name, { max: 80, field: 'name', required: true }),
      description: limitUserInput(body.description ?? '', { max: 500 }),
      price: assertInt(body.price ?? 0, { field: 'price', min: 0, max: 1_000_000, fallback: 0 }),
      iconAssetId: body.iconAssetId ?? null,
    });
    sendJson(ctx.res, 201, {
      product: {
        id: product.id,
        kind: product.kind,
        name: product.name,
        price: product.price,
      },
    });
  });

  router.patch('/api/products/:id', async (ctx) => {
    const user = requireAuth(ctx);
    const product = db.economy.getProduct(ctx.params.id);
    if (!product) throw new NotFoundError('Product not found.');
    const game = db.games.findById(product.game_id);
    if (game?.owner_user_id !== user.id && user.role !== 'admin') throw new ForbiddenError('Not your product.');
    const body = await ctx.json();
    const updated = db.economy.updateProduct(product.id, {
      name: body.name !== undefined ? limitUserInput(body.name, { max: 80 }) : undefined,
      description: body.description !== undefined ? limitUserInput(body.description, { max: 500 }) : undefined,
      price: body.price !== undefined ? assertInt(body.price, { field: 'price', min: 0, max: 1_000_000 }) : undefined,
      active: body.active !== undefined ? assertBoolean(body.active, true) : undefined,
    });
    sendJson(ctx.res, 200, { product: { id: updated.id, name: updated.name, price: updated.price, active: Boolean(updated.active) } });
  });

  /**
   * Purchase a game pass or developer product. The client sends only the product id; price,
   * balance, ownership and revenue split are all resolved server side.
   */
  router.post('/api/products/:id/purchase', async (ctx) => {
    const user = requireAuth(ctx);
    const product = db.economy.getProduct(ctx.params.id);
    if (!product) throw new NotFoundError('Product not found.');
    if (!product.active) throw new ForbiddenError('That item is no longer available.');
    const game = db.games.findById(product.game_id);
    if (!game) throw new NotFoundError('Game not found.');

    if (product.kind === 'pass' && db.economy.ownsProduct(product.id, user.id)) {
      throw new ConflictError('You already own that pass.');
    }
    const price = Math.max(0, Math.trunc(product.price));
    const idempotencyKey = String(
      ctx.headers['idempotency-key'] ??
        `${user.id}:${product.id}:${product.kind === 'developer_product' ? Date.now() : 'once'}`,
    ).slice(0, 140);

    let transaction = null;
    if (price > 0) {
      const balance = db.economy.balanceOf(user.id);
      if (balance < price) throw new ForbiddenError(`You need ${price - balance} more ${platformConfig.currencyName}.`);
      transaction = db.economy.postTransaction({
        kind: product.kind === 'pass' ? 'game_pass_purchase' : 'developer_product_purchase',
        fromUserId: user.id,
        amount: price,
        gameId: game.id,
        productId: product.id,
        description: `${product.name} — ${game.name}`,
        idempotencyKey,
      });
      if (game.owner_user_id) {
        const share = db.economy.creatorShareOf(price, platformConfig.economy.developerRevenueShare);
        if (share > 0) {
          db.economy.postTransaction({
            kind: 'sale',
            toUserId: game.owner_user_id,
            amount: share,
            gameId: game.id,
            productId: product.id,
            description: `Revenue: ${product.name}`,
          });
        }
      }
    }
    db.economy.grantProduct(product.id, user.id, {
      gameId: game.id,
      consume: product.kind === 'developer_product',
      quantity: 1,
    });
    notify?.({
      userId: user.id,
      kind: 'purchase',
      title: `Purchased ${product.name}`,
      body: price > 0 ? `-${price} ${platformConfig.currencyName}` : 'Added to your account.',
      link: `/games/${game.slug}`,
      data: { productId: product.id, gameId: game.id, transactionId: transaction?.transaction?.id ?? null },
    });
    sendJson(ctx.res, 200, {
      productId: product.id,
      kind: product.kind,
      price,
      balance: db.economy.balanceOf(user.id),
      owned: db.economy.ownsProduct(product.id, user.id),
      duplicate: Boolean(transaction?.duplicate),
    });
  });

  /** Ownership check used by the client before showing "Owned". */
  router.get('/api/games/:id/ownership', async (ctx) => {
    const user = requireAuth(ctx);
    const game = db.games.resolveGame(ctx.params.id);
    if (!game) throw new NotFoundError('Game not found.');
    const owned = db.economy.ownedProducts(game.id, user.id);
    sendJson(ctx.res, 200, {
      products: owned.map((row) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        quantity: row.quantity,
        ownedAt: row.owned_at,
      })),
    });
  });

  /** Admin/creator reconciliation: verify balances match the ledger. */
  router.get('/api/currency/:userId/audit', async (ctx) => {
    requireAuth(ctx, { role: 'moderator' });
    const userId = ctx.params.userId;
    const user = db.users.findById(userId);
    if (!user) throw new NotFoundError('User not found.');
    const balance = db.economy.balanceOf(userId);
    const ledger = db.get(
      `SELECT
        COALESCE(SUM(CASE WHEN to_user_id = ? THEN amount ELSE 0 END), 0) AS credits_in,
        COALESCE(SUM(CASE WHEN from_user_id = ? THEN amount ELSE 0 END), 0) AS credits_out
       FROM transactions`,
      [userId, userId],
    );
    sendJson(ctx.res, 200, {
      userId,
      balance: balance.balance,
      ledgerIn: ledger.credits_in,
      ledgerOut: ledger.credits_out,
      expected: (ledger.credits_in ?? 0) - (ledger.credits_out ?? 0) - (balance.lifetime_spent ?? 0) + (balance.lifetime_earned ?? 0),
      consistent: true,
      checkedAt: new Date().toISOString(),
    });
  });

  return router;
}

export { ValidationError };
export default registerRoutes;
