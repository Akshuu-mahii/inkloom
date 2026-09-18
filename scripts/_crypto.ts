/**
 * Authenticated encryption for backup archives.
 *
 * A database dump is the single most sensitive artefact this project produces:
 * every address, every profile, every credit movement, the whole audit trail.
 * It then travels to a third party and sits there for thirty days. Encrypting
 * it before it leaves means the storage provider holds ciphertext, and a
 * leaked artifact is not a breach.
 *
 * AES-256-GCM, not CBC. GCM is AUTHENTICATED: a truncated, corrupted or
 * tampered archive fails to decrypt rather than decrypting into plausible
 * rubbish. That property matters more here than anywhere else in the codebase,
 * because the one moment this file gets read is the moment everything else has
 * already gone wrong and there is nothing left to cross-check it against.
 *
 * The key is derived with scrypt from a passphrase held as a CI secret, with a
 * fresh random salt per archive — so two backups of the same database never
 * produce the same ciphertext, and a passphrase that is weaker than it should
 * be still costs real work to attack.
 *
 * FORMAT
 *   magic    5 bytes   "INKB1"   so a wrong file fails immediately and clearly
 *   salt    16 bytes             scrypt salt, fresh per archive
 *   iv      12 bytes             GCM nonce, fresh per archive
 *   tag     16 bytes             GCM authentication tag
 *   body     n bytes             ciphertext
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const MAGIC = Buffer.from("INKB1", "utf8");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/** scrypt cost. N=2^15 keeps derivation around a tenth of a second. */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class BackupCryptoError extends Error {}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (!passphrase || passphrase.length < 16) {
    throw new BackupCryptoError(
      "the backup passphrase must be at least 16 characters — " +
        "this key is the only thing protecting a complete copy of the database",
    );
  }
  return scryptSync(passphrase, salt, KEY_LEN, SCRYPT);
}

export function encryptBackup(plaintext: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);

  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function decryptBackup(archive: Buffer, passphrase: string): Buffer {
  const headerLen = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
  if (archive.length < headerLen) {
    throw new BackupCryptoError("not an Inkloom backup — the file is too short to hold a header");
  }
  if (!archive.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupCryptoError(
      "not an Inkloom encrypted backup — wrong magic bytes. " +
        "An unencrypted .sql.gz is restored directly, without this step.",
    );
  }

  let at = MAGIC.length;
  const salt = archive.subarray(at, (at += SALT_LEN));
  const iv = archive.subarray(at, (at += IV_LEN));
  const tag = archive.subarray(at, (at += TAG_LEN));
  const body = archive.subarray(at);

  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    /*
     * GCM cannot tell "wrong key" from "modified file" — both fail the same
     * authentication check, and saying which would leak information. What the
     * message must NOT do is suggest the data is gone: in a real recovery this
     * is read by someone already having a bad day.
     */
    throw new BackupCryptoError(
      "could not decrypt: the passphrase is wrong, or the archive was modified " +
        "or truncated in transit. The archive itself is unchanged — try the other key first.",
    );
  }
}

/** True when a buffer carries this format's header. */
export function isEncryptedBackup(archive: Buffer): boolean {
  return archive.length >= MAGIC.length && archive.subarray(0, MAGIC.length).equals(MAGIC);
}
