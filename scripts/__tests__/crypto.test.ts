/**
 * Backup encryption.
 *
 * These run against the one artefact that is read exactly once, in the worst
 * circumstances, with nothing left to cross-check it against. Everything here
 * is a way the archive could be wrong while still looking like a file.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BackupCryptoError, decryptBackup, encryptBackup, isEncryptedBackup } from "../_crypto";

const KEY = "a-sufficiently-long-backup-passphrase";
const OTHER = "a-different-but-also-long-passphrase";

describe("round trip", () => {
  it("returns exactly what went in", () => {
    const plain = Buffer.from("-- PostgreSQL database dump\nCOPY users ...\n");
    expect(decryptBackup(encryptBackup(plain, KEY), KEY).equals(plain)).toBe(true);
  });

  it("handles a realistically sized archive", () => {
    const plain = randomBytes(2 * 1024 * 1024);
    expect(decryptBackup(encryptBackup(plain, KEY), KEY).equals(plain)).toBe(true);
  });

  it("handles an empty payload without crashing", () => {
    const plain = Buffer.alloc(0);
    expect(decryptBackup(encryptBackup(plain, KEY), KEY).length).toBe(0);
  });

  /*
   * Two backups of an unchanged database must not produce identical files.
   * Identical ciphertext would leak that nothing changed between them, and
   * would mean a repeated salt or nonce — the classic way to break AES-GCM.
   */
  it("never produces the same ciphertext twice", () => {
    const plain = Buffer.from("same input every time");
    const a = encryptBackup(plain, KEY);
    const b = encryptBackup(plain, KEY);

    expect(a.equals(b)).toBe(false);
    expect(decryptBackup(a, KEY).equals(decryptBackup(b, KEY))).toBe(true);
  });
});

describe("it refuses what it should", () => {
  it("refuses the wrong passphrase", () => {
    const archive = encryptBackup(Buffer.from("secret"), KEY);
    expect(() => decryptBackup(archive, OTHER)).toThrow(BackupCryptoError);
  });

  it("refuses a passphrase too short to be worth anything", () => {
    expect(() => encryptBackup(Buffer.from("x"), "short")).toThrow(/at least 16/);
  });

  /*
   * The property CBC would not give us. A modified archive must FAIL, not
   * decrypt into plausible rubbish that then gets restored into a database.
   */
  it("detects a single flipped byte in the body", () => {
    const archive = encryptBackup(Buffer.from("a".repeat(5000)), KEY);
    archive[archive.length - 20] ^= 0x01;
    expect(() => decryptBackup(archive, KEY)).toThrow(/modified or truncated/i);
  });

  it("detects a tampered authentication tag", () => {
    const archive = encryptBackup(Buffer.from("payload"), KEY);
    archive[40] ^= 0xff; // inside the tag
    expect(() => decryptBackup(archive, KEY)).toThrow(BackupCryptoError);
  });

  it("detects truncation", () => {
    const archive = encryptBackup(Buffer.from("a".repeat(5000)), KEY);
    expect(() => decryptBackup(archive.subarray(0, archive.length - 100), KEY)).toThrow(
      BackupCryptoError,
    );
  });

  it("rejects a file that is not one of ours, by name", () => {
    /*
     * A plain .sql.gz handed to the decryptor by mistake: the message has to
     * say what to do instead, not just "failed".
     *
     * Sized like a real archive on purpose. A ten-byte sample is shorter than
     * the header and trips the length check first, which tests a different
     * branch and tells you nothing about the case that actually happens.
     */
    const gzipLooking = Buffer.concat([
      Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]),
      randomBytes(4096),
    ]);
    expect(() => decryptBackup(gzipLooking, KEY)).toThrow(/not an Inkloom encrypted backup/);
  });

  it("rejects a file too short to even hold a header", () => {
    expect(() => decryptBackup(Buffer.from("INKB1"), KEY)).toThrow(/too short/);
  });
});

describe("telling the two formats apart", () => {
  it("recognises an encrypted archive", () => {
    expect(isEncryptedBackup(encryptBackup(Buffer.from("x"), KEY))).toBe(true);
  });

  it("does not mistake a plain gzip for one", () => {
    // Backups taken before encryption existed must still be restorable, so the
    // restore path has to be able to tell which kind it is holding.
    expect(isEncryptedBackup(Buffer.from([0x1f, 0x8b, 0x08]))).toBe(false);
    expect(isEncryptedBackup(Buffer.alloc(0))).toBe(false);
  });
});
