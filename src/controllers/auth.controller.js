const authService = require('../services/auth.service');

/**
 * POST /api/auth/signup
 *
 * Body: fullName, email, phone, companyName, designation, employeeStrength,
 *       companyIndustry, password, confirmPassword
 *
 * Answers with the same { user, token } shape as login, so the frontend can
 * drop the user straight into the app instead of bouncing them to the login
 * screen right after they signed up.
 */
async function signup(req, res) {
  const { user, token, expiresAt } = await authService.signup(req.body);
  res.status(201).json({
    success: true,
    message: 'Account created.',
    user,
    token,
    expiresAt,
  });
}

/**
 * POST /api/auth/login
 *
 * Body: identifier (email OR phone number) + password.
 * `email` or `phone` are accepted in place of `identifier`.
 */
async function login(req, res) {
  const { user, token, expiresAt } = await authService.login(req.body);
  res.json({
    success: true,
    message: `Welcome back, ${user.fullName}.`,
    user,
    token,
    expiresAt,
  });
}

/** GET /api/auth/me - the signed-in account, for restoring a session. */
async function me(req, res) {
  res.json({ success: true, user: req.user });
}

/**
 * POST /api/auth/logout
 *
 * The token is stateless, so there is nothing to revoke server-side: the
 * client drops it. The endpoint exists so the frontend has one call to make
 * and a place to hook revocation onto later.
 */
async function logout(req, res) {
  res.json({ success: true, message: 'Logged out. Discard the token on the client.' });
}

module.exports = { signup, login, me, logout };
