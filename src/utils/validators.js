const { ApiError } = require('../middleware/error.middleware');

/**
 * Input checks for the auth flows.
 *
 * Every helper either returns the CLEANED value or throws ApiError(400).
 * Cleaning matters as much as validating: the login lookup only finds a user
 * if signup stored the email/phone in exactly the same normalized form.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/**
 * Company size is stored as a band rather than an exact headcount - it is
 * what signup forms actually ask for, and it stays true as the company grows.
 */
const EMPLOYEE_STRENGTH_BANDS = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];

/** Upper bound for the free-text fields, so a huge body cannot be stored. */
const MAX_TEXT = 120;

function requireString(value, field, { min = 1, max = MAX_TEXT } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, `${field} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min) throw new ApiError(400, `${field} must be at least ${min} characters.`);
  if (trimmed.length > max) throw new ApiError(400, `${field} must be at most ${max} characters.`);
  return trimmed;
}

/** Lower-cased, so "Ada@Example.com" and "ada@example.com" are one account. */
function normalizeEmail(value, field = 'Email') {
  const email = requireString(value, field, { max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new ApiError(400, `${field} is not a valid email address.`);
  return email;
}

/**
 * Phone numbers are stored digits-only behind a "+", so "+91 98765-43210",
 * "+919876543210" and "(+91) 9876543210" all resolve to the same account.
 */
function normalizePhone(value, field = 'Phone number') {
  return parsePhone(value, field).e164;
}

/**
 * The national significant number: the last 10 digits, without a country
 * code. Login uses it so someone who signed up as "+91 98765 43210" can still
 * get in by typing the "9876543210" they think of as their number.
 */
function nationalDigits(e164) {
  return String(e164).replace(/\D/g, '').slice(-10);
}

function parsePhone(value, field = 'Phone number') {
  const raw = requireString(value, field, { max: 24 });
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    throw new ApiError(400, `${field} must contain between 10 and 15 digits.`);
  }
  return {
    e164: `+${digits}`,
    national: digits.slice(-10),
    // Exactly 10 digits means no country code was typed, so a login has to
    // fall back to matching on the national number alone.
    hasCountryCode: digits.length > 10,
  };
}

/**
 * Accepts either one of the bands above or a raw headcount ("250"), which is
 * mapped into its band - a frontend sending a number should not be a 400.
 */
function normalizeEmployeeStrength(value, field = 'Employee strength') {
  if (typeof value === 'number' || /^\d+$/.test(String(value ?? '').trim())) {
    return bandForCount(Number(value), field);
  }
  const band = requireString(value, field, { max: 20 }).replace(/\s+/g, '');
  const match = EMPLOYEE_STRENGTH_BANDS.find((b) => b === band);
  if (!match) {
    throw new ApiError(400, `${field} must be one of: ${EMPLOYEE_STRENGTH_BANDS.join(', ')}.`);
  }
  return match;
}

function bandForCount(count, field) {
  if (!Number.isInteger(count) || count < 1) {
    throw new ApiError(400, `${field} must be a positive number of employees.`);
  }
  if (count <= 10) return '1-10';
  if (count <= 50) return '11-50';
  if (count <= 200) return '51-200';
  if (count <= 500) return '201-500';
  if (count <= 1000) return '501-1000';
  return '1000+';
}

/**
 * Passwords are checked here and NEVER logged or echoed back. The rule is
 * deliberately modest (length + a letter + a digit): long enough to matter,
 * simple enough that the error message can state it in full.
 */
function validatePassword(value, confirmValue) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'Password is required.');
  }
  if (value.length < 8) throw new ApiError(400, 'Password must be at least 8 characters.');
  if (value.length > 72) {
    // bcrypt silently ignores bytes past 72 - refuse rather than pretend the
    // rest of the password is protecting anything.
    throw new ApiError(400, 'Password must be at most 72 characters.');
  }
  if (!/[a-zA-Z]/.test(value) || !/\d/.test(value)) {
    throw new ApiError(400, 'Password must contain at least one letter and one number.');
  }
  if (confirmValue !== undefined && value !== confirmValue) {
    throw new ApiError(400, 'Password and confirm password do not match.');
  }
  return value;
}

/**
 * Login accepts ONE field for both ways in: whatever the user typed. An "@"
 * means it is an email, anything else is treated as a phone number - so the
 * frontend needs a single input box, not a toggle.
 */
function parseIdentifier(value) {
  const raw = requireString(value, 'Email or phone number', { max: 254 });
  if (raw.includes('@')) return { field: 'email', value: normalizeEmail(raw) };
  const phone = parsePhone(raw);
  return { field: 'phone', value: phone.e164, ...phone };
}

module.exports = {
  EMPLOYEE_STRENGTH_BANDS,
  requireString,
  normalizeEmail,
  normalizePhone,
  parsePhone,
  nationalDigits,
  normalizeEmployeeStrength,
  validatePassword,
  parseIdentifier,
};
