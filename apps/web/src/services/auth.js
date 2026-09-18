/**
 * Authentication: registration, login, sessions with refresh-token rotation, lockout protection,
 * password reset, email verification and CSRF tokens.
 *
 * Tokens:
 *   - session cookie (httpOnly, SameSite=Lax) carries the session id
 *   - refresh token is only ever stored hashed in the database and rotates on every use
 *   - CSRF uses the double-submit cookie pattern with a constant-time comparison
 */
import * as db from '@kinetiq/db';
import { users as usersRepo, sessions as sessionsRepo, economy as economyRepo } from '@kinetiq/db';
import {
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
  platformConfig,
  signPayload,
  verifySignedPayload,
  token,
  sha256,
  nowSeconds,
  assertUsername,
  assertPassword,
  assertDisplayName,
  assertEmail,
  createLogger,
} from '@kinetiq/shared';

const log = createLogger('auth');
const LOCKOUT = platformConfig.safety;

export const SESSION_COOKIE = 'kq_session';
export const REFRESH_COOKIE = 'kq_refresh';
export const CSRF_COOKIE = 'kq_csrf';

export class AuthService {
  constructor({ notify = null } = {}) {
    this.notify = notify;
    this.loginLimiter = new Map();
  }

  /** ------------------------------------------------------------- registration */
  register({ username, displayName, password, email, ip = '', userAgent = '' }) {
    if (!platformConfig.features.registrationEnabled) {
      throw new ForbiddenError('Registration is currently closed.');
    }
    const cleanUsername = assertUsername(username);
    const cleanDisplay = assertDisplayName(displayName, cleanUsername);
    const cleanPassword = assertPassword(password);
    const cleanEmail = assertEmail(email, { required: platformConfig.features.emailVerification });

    if (usersRepo.usernameExists(cleanUsername)) {
      throw new ConflictError('That username is taken.', { field: 'username' });
    }
    if (cleanEmail && usersRepo.emailExists(cleanEmail)) {
      throw new ConflictError('That email is already registered.', { field: 'email' });
    }

    const user = usersRepo.createUser({
      username: cleanUsername,
      displayName: cleanDisplay,
      email: cleanEmail,
      password: cleanPassword,
      emailVerified: !platformConfig.features.emailVerification,
    });

    // Welcome bonus keeps the economy usable without any real-money concepts.
    if (platformConfig.economy.signupBonus > 0) {
      try {
        economyRepo.grantCredits(user.id, platformConfig.economy.signupBonus, 'signup_bonus', {
          description: 'Welcome bonus',
        });
      } catch (error) {
        log.warn('signup bonus failed', { error: error.message });
      }
    }

    const session = this.createSession(user, { ip, userAgent });
    log.info('account created', { userId: user.id, username: user.username });
    return { user, session };
  }

  /** ------------------------------------------------------------- login */
  login({ username, password, ip = '', userAgent = '' }) {
    const key = `${String(username).toLowerCase()}:${ip}`;
    const attempts = this.loginLimiter.get(key) ?? { count: 0, resetAt: Date.now() + 60_000 };
    if (Date.now() > attempts.resetAt) {
      attempts.count = 0;
      attempts.resetAt = Date.now() + 60_000;
    }
    if (attempts.count >= 10) {
      throw new RateLimitError('Too many sign-in attempts. Wait a minute and try again.', 60);
    }

    const result = usersRepo.authenticate(String(username ?? ''), String(password ?? ''));
    if (!result.ok) {
      attempts.count += 1;
      this.loginLimiter.set(key, attempts);
      usersRepo.recordLoginFailure(String(username ?? '').slice(0, 64), ip);
      if (result.user) {
        const failed = (result.user.failed_login_count ?? 0) + 1;
        if (failed >= LOCKOUT.accountLockoutAttempts) {
          usersRepo.lockAccount(result.user.id, LOCKOUT.accountLockoutMinutes);
          log.warn('account locked after repeated failures', { userId: result.user.id });
        }
      }
      throw new UnauthorizedError('Incorrect username or password.');
    }

    const user = result.user;
    if (usersRepo.isLocked(user)) {
      throw new ForbiddenError(
        `This account is temporarily locked. Try again in a few minutes.`,
      );
    }
    if (user.status === 'suspended' || user.status === 'banned') {
      const until = user.status_until ? ` until ${user.status_until}` : '';
      throw new ForbiddenError(`This account is ${user.status}${until}. ${user.status_reason ?? ''}`.trim());
    }

    attempts.count = 0;
    this.loginLimiter.delete(key);
    usersRepo.recordLoginSuccess(user.id, ip);
    const session = this.createSession(user, { ip, userAgent });
    log.info('login', { userId: user.id });
    return { user, session };
  }

  /** ------------------------------------------------------------- sessions */
  createSession(user, { ip = '', userAgent = '' } = {}) {
    const session = sessionsRepo.createSession(user.id, { ip, userAgent });
    usersRepo.setPresence(user.id, 'online');
    return {
      id: session.id,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      csrfToken: token(24),
    };
  }

  /** Resolves the current user from a session cookie/Bearer token; refreshes presence activity. */
  async resolveSession(reqContext) {
    const sessionId = reqContext.sessionId;
    if (!sessionId) return null;
    const user = sessionsRepo.sessionUser(sessionId);
    if (!user) return null;
    if (user.status === 'banned') return null;
    sessionsRepo.touchSession(sessionId);
    return { user, sessionId };
  }

  /**
   * Rotates a refresh token. The refresh token itself is opaque and only ever stored hashed; the
   * session id identifies the row. Reuse of an already-rotated token revokes the session.
   */
  rotate({ sessionId, refreshToken, ip = '', userAgent = '' }) {
    if (!sessionId || !refreshToken) throw new UnauthorizedError('No refresh token provided.');
    const result = sessionsRepo.rotateRefreshToken(sessionId, refreshToken, { ip, userAgent });
    if (!result.ok) {
      if (result.reason === 'mismatch') log.warn('refresh token mismatch; session revoked', { sessionId });
      throw new UnauthorizedError('Session expired. Please sign in again.');
    }
    const user = usersRepo.findById(result.userId);
    if (!user) throw new UnauthorizedError('Account no longer available.');
    if (user.status === 'banned' || user.status === 'suspended') {
      sessionsRepo.revokeSession(sessionId);
      throw new ForbiddenError('This account is unavailable.');
    }
    return {
      user,
      session: { id: sessionId, refreshToken: result.refreshToken, expiresAt: result.expiresAt, csrfToken: token(24) },
    };
  }

  /** Convenience wrapper used by the launcher: rotate using only what the caller holds. */
  refresh({ sessionId, refreshToken, ip = '', userAgent = '' }) {
    return this.rotate({ sessionId, refreshToken, ip, userAgent });
  }

  logout(sessionId) {
    if (sessionId) sessionsRepo.revokeSession(sessionId);
  }

  logoutAll(userId, { exceptSessionId = null } = {}) {
    sessionsRepo.revokeAllSessions(userId, { exceptSessionId });
  }

  /** ------------------------------------------------------------- password reset */
  requestPasswordReset(email) {
    const user = usersRepo.findByEmail(String(email ?? ''));
    // Always report success so this endpoint cannot be used to enumerate accounts.
    if (!user) return { ok: true, token: null };
    const reset = sessionsRepo.createPasswordReset(user.id, 30);
    const link = `/reset?token=${reset.token}`;
    this.notify?.({
      userId: user.id,
      kind: 'system',
      title: 'Password reset requested',
      body: 'If you requested a password reset, use the link on your account security page. It expires in 30 minutes.',
      link,
      data: { resetToken: reset.token },
    });
    log.info('password reset requested', { userId: user.id });
    return { ok: true, token: reset.token, link };
  }

  completePasswordReset({ token: rawToken, password }) {
    const cleanPassword = assertPassword(password);
    const record = sessionsRepo.consumePasswordReset(rawToken);
    if (!record) throw new ValidationError('That reset link is invalid or has expired.');
    usersRepo.updatePassword(record.user_id, cleanPassword);
    sessionsRepo.revokeAllSessions(record.user_id);
    log.info('password reset completed', { userId: record.user_id });
    return { ok: true };
  }

  changePassword({ userId, currentPassword, password, sessionId = null }) {
    const user = usersRepo.findById(userId);
    if (!user) throw new UnauthorizedError();
    const cleanPassword = assertPassword(password);
    const check = usersRepo.authenticate(user.username, currentPassword);
    if (!check.ok) throw new ForbiddenError('Current password is incorrect.');
    usersRepo.updatePassword(userId, cleanPassword);
    this.logoutAll(userId, { exceptSessionId: sessionId });
    return { ok: true };
  }

  /** ------------------------------------------------------------- email verification */
  createEmailVerification(user) {
    const code = token(12);
    const id = `emv_${token(8)}`;
    db.run(
      `INSERT INTO email_verifications (id, user_id, email, code_hash, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '+1 day'))`,
      [id, user.id, user.email, sha256(code)],
    );
    return { code, link: `/verify?code=${code}` };
  }

  verifyEmail(code) {
    const row = db.get(
      `SELECT * FROM email_verifications WHERE code_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`,
      [sha256(String(code))],
    );
    if (!row) throw new ValidationError('That verification link is invalid or has expired.');
    db.run('UPDATE email_verifications SET used_at = datetime(\'now\') WHERE id = ?', [row.id]);
    db.run('UPDATE users SET email_verified = 1, email = ? WHERE id = ?', [row.email, row.user_id]);
    return { ok: true };
  }

  /** Signed, short-lived token used to authorise a game client launch. */
  signClientLaunch({ userId, gameId, serverId, ttlSeconds = 120 }) {
    return signPayload({ typ: 'launch', userId, gameId, serverId }, { ttlSeconds });
  }

  verifyClientLaunch(launchToken) {
    const payload = verifySignedPayload(launchToken);
    if (!payload || payload.typ !== 'launch') throw new UnauthorizedError('Invalid launch token.');
    return payload;
  }
}

export { nowSeconds };
export default AuthService;
