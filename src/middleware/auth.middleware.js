const authService = require('../services/auth.service');
const { ApiError } = require('./error.middleware');

/**
 * Bearer-token gate.
 *
 * Put `requireAuth` in front of any route that should belong to a logged-in
 * user:  router.post('/', requireAuth, asyncHandler(controller.chat))
 *
 * On success the request carries `req.user` (the public user object) and
 * `req.userId`, so a handler never has to decode the token itself.
 */
function bearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim() || null;
}

async function requireAuth(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) {
      throw new ApiError(401, 'Authentication required. Send an "Authorization: Bearer <token>" header.');
    }

    const payload = authService.verifyToken(token);

    // The token can outlive the account it names (deleted user, old token
    // after a reset), so the subject is confirmed against the database.
    const user = await authService.findById(payload.sub);
    if (!user) throw new ApiError(401, 'This account no longer exists.');

    req.user = authService.toPublicUser(user);
    req.userId = req.user.id;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Same as requireAuth, but a missing or invalid token is not an error - the
 * request just continues anonymously. For endpoints that behave differently
 * when signed in without demanding it.
 */
async function optionalAuth(req, res, next) {
  if (!bearerToken(req)) return next();
  try {
    await requireAuth(req, res, next);
  } catch {
    next();
  }
}

/**
 * Admin-only gate, placed after requireAuth. A user becomes an admin by
 * setting `role: "admin"` on their document in the `users` collection.
 */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return next(new ApiError(403, 'Admin access required.'));
  next();
}

module.exports = { requireAuth, optionalAuth, requireAdmin };
