/**
 * Decrypt a backup archive to plain `.sql.gz`.
 *
 *   BACKUP_ENCRYPTION_KEY="..." pnpm tsx scripts/decrypt-backup.ts \
 *     --file backups/inkloom-staging-....sql.gz.enc [--out recovered.sql.gz]
 *
 * For a real recovery, where someone needs the dump in their hands to inspect
 * or restore by hand. `restore-verify.ts` decrypts on its own and cleans up
 * after itself; this is the deliberate, keep-the-file version.
 *
 * It prints where the plaintext landed and says so plainly, because that file
 * is a complete copy of the database sitting unencrypted on someone's laptop.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { decryptBackup, isEncryptedBackup } from "./_crypto";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main() {
  const file = arg("file");
  if (!file) {
    console.error("\n  Usage: --file <archive.sql.gz.enc> [--out <out.sql.gz>]\n");
    process.exit(1);
  }

  const passphrase = process.env.BACKUP_ENCRYPTION_KEY;
  if (!passphrase) {
    console.error(
      "\n  BACKUP_ENCRYPTION_KEY is not set.\n\n" +
        "  This is the key the archive was written with. Without it the archive\n" +
        "  cannot be opened by anyone, including you — it is not recoverable by\n" +
        "  any other means.\n",
    );
    process.exit(1);
  }

  const raw = readFileSync(file);
  if (!isEncryptedBackup(raw)) {
    console.log(`\n  ${file} is not encrypted — it is already a plain .sql.gz. Nothing to do.\n`);
    process.exit(0);
  }

  const out = arg("out") ?? file.replace(/\.enc$/, "");
  writeFileSync(out, decryptBackup(raw, passphrase));

  console.log(`\n  decrypted -> ${out}`);
  console.log("  This is now an UNENCRYPTED copy of the whole database. Delete it when done.\n");
}

main();
