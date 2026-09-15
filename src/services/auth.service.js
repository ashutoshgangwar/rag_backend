const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

const db = require('../config/db');
const { ApiError } = require('../middleware/error.middleware');
const {
  normalizeEmail,
  normalizePhone,
  nationalDigits,
  normalizeEmployeeStrength,
  requireString,
  validatePassword,
  parseIdentifier,
} = require('../utils/validators');

/**
 * Accounts and sessions.
 *
 *   signup -> validate -> hash password -> insert user  -> issue JWT
 *   login  -> find by email OR phone    -> compare hash -> issue JWT
 *
 * The plaintext password exists only for the length of the call that received
 * it: what is stored is a bcrypt hash, and `passwordHash` is stripped from
 * every object that leaves this module (see toPublicUser).
 */

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 12;
const TOKEN_TTL = process.env.JWT_EXPIRES_IN || '7d';

/** Read lazily, not at import time, so a missing secret fails loudly per call. */
function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new ApiError(
      500,
      'JWT_SECRET is missing or too short. Set a long random value in .env before using auth.'
    );
  }
  return secret;
}

/**
 * POST /api/auth/signup
 *
 * Company details are captured here because the account IS the company
 * account - there is no separate "create organization" step.
 */
async function signup(payload = {}) {
  const user = {
    fullName: requireString(payload.fullName, 'Full name', { min: 2 }),
    email: normalizeEmail(payload.email),
    phone: normalizePhone(payload.phone),
    companyName: requireString(payload.companyName, 'Company name', { min: 2 }),
    designation: requireString(payload.designation, 'Designation', { min: 2 }),
    employeeStrength: normalizeEmployeeStrength(payload.employeeStrength),
    companyIndustry: requireString(payload.companyIndustry, 'Company industry', { min: 2 }),
  };

  // Validated last so a mistyped confirmation is not reported before the
  // cheaper field errors the user can see on screen.
  const password = validatePassword(payload.password, payload.confirmPassword);

  // Checked up front purely for the better error message - the unique indexes
  // are what actually prevent a duplicate under a race, handled below.
  await assertIdentifiersAreFree(user.email, user.phone);

  const doc = {
    ...user,
    // Kept alongside the full number purely so login can match someone who
    // types their number without the country code.
    phoneNational: nationalDigits(user.phone),
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
  };

  let insertedId;
  try {
    ({ insertedId } = await db.users().insertOne(doc));
  } catch (err) {
    // Two signups for the same email/phone landing at once: one wins, the
    // other gets the same 409 it would have got from the check above.
    throw translateDuplicateKey(err);
  }

  const created = { ...doc, _id: insertedId };
  return { user: toPublicUser(created), ...issueToken(created) };
}

/**
 * POST /api/auth/login
 *
 * One identifier field covers both ways in: an email or a phone number.
 */
async function login({ identifier, email, phone, password } = {}) {
  // `identifier` is the shape the frontend sends; `email`/`phone` are accepted
  // too so a client with two separate inputs does not need a translation step.
  const supplied = identifier ?? email ?? phone;
  if (supplied === undefined || supplied === null || supplied === '') {
    throw new ApiError(400, 'Email or phone number is required.');
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new ApiError(400, 'Password is required.');
  }

  const parsed = parseIdentifier(supplied);
  const user = parsed.field === 'email'
    ? await db.users().findOne({ email: parsed.value })
    : await findByPhone(parsed);

  // Same message and same work either way. Saying "no such user" would let
  // anyone probe which emails and phone numbers are registered, and skipping
  // the compare when the user is missing would leak the same thing by timing.
  const matches = await bcrypt.compare(
    password,
    user ? user.passwordHash : DUMMY_HASH
  );
  if (!user || !matches) {
    throw new ApiError(401, 'Incorrect email/phone number or password.');
  }

  await db.users().updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

  return { user: toPublicUser(user), ...issueToken(user) };
}

/** GET /api/auth/me - the account behind the bearer token. */
async function getProfile(userId) {
  const user = await findById(userId);
  if (!user) throw new ApiError(404, 'Account not found.');
  return toPublicUser(user);
}

/** Used by the auth middleware to confirm the token's subject still exists. */
async function findById(userId) {
  if (!ObjectId.isValid(String(userId))) return null;
  return db.users().findOne({ _id: new ObjectId(String(userId)) });
}

function issueToken(user) {
  const token = jwt.sign(
    { sub: user._id.toString(), email: user.email },
    jwtSecret(),
    { expiresIn: TOKEN_TTL }
  );
  const { exp } = jwt.decode(token);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, jwtSecret());
  } catch (err) {
    if (err instanceof ApiError) throw err; // missing JWT_SECRET, not a bad token
    const expired = err.name === 'TokenExpiredError';
    throw new ApiError(401, expired ? 'Session expired. Please log in again.' : 'Invalid token.');
  }
}

/**
 * Find the account behind a typed phone number.
 *
 * With a country code the match is exact. Without one, the number is matched
 * against the national part - which can in principle hit two accounts from
 * different countries, so that case asks for the country code rather than
 * guessing which person is logging in.
 */
async function findByPhone({ value, national, hasCountryCode }) {
  if (hasCountryCode) return db.users().findOne({ phone: value });

  const candidates = await db
    .users()
    .find({ $or: [{ phone: value }, { phoneNational: national }] })
    .limit(2)
    .toArray();

  if (candidates.length > 1) {
    throw new ApiError(
      409,
      'More than one account uses this number. Include your country code, e.g. +919876543210.'
    );
  }
  return candidates[0] || null;
}

async function assertIdentifiersAreFree(email, phone) {
  const existing = await db.users().findOne(
    { $or: [{ email }, { phone }] },
    { projection: { email: 1, phone: 1 } }
  );
  if (!existing) return;
  throw new ApiError(
    409,
    existing.email === email
      ? 'An account with this email already exists.'
      : 'An account with this phone number already exists.'
  );
}

/**
 * The generic 11000 handler in error.middleware answers "That document already
 * exists", which is about documents. Name the real field instead.
 */
function translateDuplicateKey(err) {
  if (err.code !== 11000) return err;
  const field = Object.keys(err.keyPattern || {})[0];
  if (field === 'email') return new ApiError(409, 'An account with this email already exists.');
  if (field === 'phone') return new ApiError(409, 'An account with this phone number already exists.');
  return new ApiError(409, 'An account with these details already exists.');
}

/** Everything safe to send to a client - never the hash. */
function toPublicUser(user) {
  return {
    id: user._id.toString(),
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    companyName: user.companyName,
    designation: user.designation,
    employeeStrength: user.employeeStrength,
    companyIndustry: user.companyIndustry,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

/**
 * A real bcrypt hash of a value nobody can supply. Comparing against it when
 * the account does not exist keeps a failed login the same cost as a wrong
 * password, so response time reveals nothing about who is registered.
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.7Pr9j1FBt3XeEqO1Zjw0gqZPU6PMJ3W';

module.exports = {
  signup,
  login,
  getProfile,
  findById,
  verifyToken,
  toPublicUser,
};
