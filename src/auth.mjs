import crypto from "node:crypto";

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, record) {
  const candidate = crypto.scryptSync(password, record.passwordSalt, 64);
  const expected = Buffer.from(record.passwordHash, "hex");

  if (candidate.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidate, expected);
}
