/**
 * Oracle Identifier Validation — conservative Oracle-safe identifier rules.
 */

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_$#]*$/;

function validateIdentifier(name, type = 'identifier') {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'VALIDATION_ERROR', message: `${type} is required` };
  }
  if (!IDENTIFIER_PATTERN.test(name)) {
    return { valid: false, error: 'VALIDATION_ERROR', message: `invalid ${type} '${name}' — must match ${IDENTIFIER_PATTERN}` };
  }
  if (name.length > 128) {
    return { valid: false, error: 'VALIDATION_ERROR', message: `${type} too long (max 128 chars)` };
  }
  return { valid: true };
}

function validateIdentifierList(names, type = 'column') {
  if (!Array.isArray(names)) {
    return { valid: false, error: 'VALIDATION_ERROR', message: `${type} list must be an array` };
  }
  for (const n of names) {
    const v = validateIdentifier(n, type);
    if (!v.valid) return v;
  }
  return { valid: true };
}

function detectInjection(name) {
  if (!name || typeof name !== 'string') return false;
  const bad = /[;'"]|\b(DROP|DELETE|INSERT|UPDATE|SELECT|UNION|EXEC|EXECUTE|ADD|ALTER|CREATE)\b|--|\/\*|\*\//i;
  return bad.test(name);
}

module.exports = { validateIdentifier, validateIdentifierList, detectInjection, IDENTIFIER_PATTERN };
