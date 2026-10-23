import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { inspect } from "node:util";
import { withStateLock } from "../orchestration/state-lock.mjs";
import type {
  Actor,
  CredentialVault,
  Revision,
  TrustedCredentialHandle,
} from "../agents/contracts.mjs";

const MAX_MATERIAL = 64 * 1024;
const MAX_CIPHERTEXT = 256 * 1024;
const MAX_RECORD = 512 * 1024;
const REF = /^credential-([a-f0-9]{64})-([a-f0-9-]{36})$/;
const messages = {
  unavailable: "OS-backed credential encryption is unavailable.",
  forbidden: "Only the authenticated project owner may administer credentials.",
  invalid: "Credential input is invalid.",
  missing: "Credential is unavailable or has been removed.",
  conflict:
    "Credential revision changed. Read current metadata before retrying.",
  storage: "Credential storage could not be verified or updated.",
  expired: "Credential handle is invalid, expired or no longer current.",
  callback: "Trusted credential operation failed.",
  result:
    "Credentials and credential handles cannot be returned or serialized.",
} as const;

export class CredentialVaultError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "CredentialVaultError";
  }
}
function fail(code: keyof typeof messages): never {
  throw new CredentialVaultError(code);
}

/** Trusted main-process dependency, never supplied by an agent or renderer. */
export interface CredentialEncryptionBackend {
  isAvailable(): boolean;
  encrypt(material: Uint8Array): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
}

/** Structural port for Electron 44 safeStorage; inject after app readiness. */
export interface ElectronSafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

/** Does not enable plaintext fallback, invoke a CLI or read personal auth files.
 * Native keychain availability/consent is established by Electron, not this port.
 */
export function createElectronCredentialEncryption(
  safeStorage: ElectronSafeStoragePort,
  platform: NodeJS.Platform = process.platform,
): CredentialEncryptionBackend {
  const isAvailable = () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      if (platform === "darwin" || platform === "win32") return true;
      return (
        platform === "linux" &&
        ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(
          safeStorage.getSelectedStorageBackend?.() ?? "unknown",
        )
      );
    } catch {
      return false;
    }
  };
  return {
    isAvailable,
    async encrypt(material) {
      if (!isAvailable()) fail("unavailable");
      try {
        return safeStorage.encryptString(
          Buffer.from(material).toString("base64"),
        );
      } catch {
        return fail("unavailable");
      }
    },
    async decrypt(ciphertext) {
      if (!isAvailable()) fail("unavailable");
      try {
        return decodeBase64(
          safeStorage.decryptString(Buffer.from(ciphertext)),
          MAX_CIPHERTEXT,
        );
      } catch {
        return fail("unavailable");
      }
    },
  };
}

export interface CredentialMetadata {
  credentialRef: string;
  revision: Revision;
  deleted: boolean;
}
interface StoredCredential extends CredentialMetadata {
  schema: 1;
  projectId: string;
  connectionId: string;
  ciphertext: string | null;
}
interface HandleState {
  connectionId: string;
  material: Uint8Array;
  current: CredentialMetadata | null;
  active: boolean;
  borrowed: Set<Uint8Array>;
}
function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function decodeBase64(value: unknown, max: number): Buffer {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > Math.ceil(max / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    fail("storage");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > max || bytes.toString("base64") !== value)
    fail("storage");
  return bytes;
}
function metadata(record: StoredCredential): CredentialMetadata {
  return {
    credentialRef: record.credentialRef,
    revision: record.revision,
    deleted: record.deleted,
  };
}

/** #89 trusted control plane. Never expose this instance through model tools.
 * Actor identity must come from authenticated owner ingress, not request JSON.
 * Backend encryption protects files at rest; it is not a same-user process sandbox.
 * Trusted callbacks must not copy/encode credentials into outputs, logs, argv or
 * environment variables. Binary/handle result checks cannot sandbox that code.
 * Buffer clearing is best-effort: safeStorage and JSON use immutable JS strings.
 */
export class EncryptedCredentialVault implements CredentialVault {
  readonly #directory: string;
  readonly #projectId: string;
  readonly #ownerUserId: string;
  readonly #encryption: CredentialEncryptionBackend;
  readonly #handles = new WeakMap<TrustedCredentialHandle, HandleState>();

  constructor(options: {
    directory: string;
    projectId: string;
    ownerUserId: string;
    encryption: CredentialEncryptionBackend;
  }) {
    if (
      !isAbsolute(options.directory) ||
      !validId(options.projectId) ||
      !validId(options.ownerUserId)
    )
      fail("invalid");
    this.#directory = resolve(options.directory);
    this.#projectId = options.projectId;
    this.#ownerUserId = options.ownerUserId;
    this.#encryption = options.encryption;
  }

  /** null creates a never-seen record; a positive revision replaces/recreates it.
   * Owner replacement rotates references. Gateway refresh uses replace instead.
   * The caller owns and must clear its input buffer after this call.
   */
  async storeCredential(
    actor: Actor,
    connectionId: string,
    material: Uint8Array,
    expectedRevision: Revision | null,
  ): Promise<CredentialMetadata> {
    return this.#guard(async () => {
      this.#owner(actor);
      this.#input(connectionId, material);
      const copy = Uint8Array.from(material);
      try {
        return await this.#mutate(
          connectionId,
          expectedRevision,
          async (previous) => {
            const record: StoredCredential = {
              schema: 1,
              projectId: this.#projectId,
              connectionId,
              credentialRef: `credential-${this.#key(connectionId)}-${randomUUID()}`,
              revision: (previous?.revision ?? 0) + 1,
              deleted: false,
              ciphertext: null,
            };
            record.ciphertext = await this.#encrypt(record, copy);
            return record;
          },
        );
      } finally {
        copy.fill(0);
      }
    });
  }

  async credentialMetadata(
    actor: Actor,
    connectionId: string,
  ): Promise<CredentialMetadata | null> {
    return this.#guard(async () => {
      this.#owner(actor);
      if (!validId(connectionId)) fail("invalid");
      const record = await this.#read(this.#key(connectionId));
      return record ? metadata(record) : null;
    });
  }

  /** Private trusted gateway port for revision-checked refresh; no secret bytes.
   * This is not owner administration or an agent-callable metadata endpoint.
   */
  async metadataForReference(
    credentialRef: string,
  ): Promise<CredentialMetadata> {
    return this.#guard(async () =>
      metadata(await this.#referenceRecord(credentialRef)),
    );
  }

  /** Retain a tombstone revision, preventing old references/revisions reviving. */
  async removeCredential(
    actor: Actor,
    connectionId: string,
    expectedRevision: Revision,
  ): Promise<Revision> {
    return this.#guard(async () => {
      this.#owner(actor);
      const result = await this.#mutate(
        connectionId,
        expectedRevision,
        async (previous) => {
          if (!previous || previous.deleted) fail("missing");
          return {
            ...previous,
            revision: previous.revision + 1,
            deleted: true,
            ciphertext: null,
          };
        },
      );
      return result.revision;
    });
  }

  async withCredential<T>(
    credentialRef: string,
    use: (handle: TrustedCredentialHandle) => Promise<T>,
  ): Promise<T> {
    return this.#guard(async () => {
      const record = await this.#referenceRecord(credentialRef);
      return this.#withHandle(
        record.connectionId,
        await this.#decrypt(record),
        metadata(record),
        use,
      );
    });
  }

  /** Trusted gateway only: scope newly authenticated/refreshed bytes to one
   * connection. The gateway owns its refresh lock/protocol and calls replace.
   */
  async withReplacement<T>(
    connectionId: string,
    material: Uint8Array,
    use: (handle: TrustedCredentialHandle) => Promise<T>,
  ): Promise<T> {
    return this.#guard(async () => {
      this.#input(connectionId, material);
      return this.#withHandle(
        connectionId,
        Uint8Array.from(material),
        null,
        use,
      );
    });
  }

  async replace(
    connectionId: string,
    expectedRevision: Revision,
    handle: TrustedCredentialHandle,
  ): Promise<Revision> {
    return this.#guard(async () => {
      const state = this.#handles.get(handle);
      if (
        !state?.active ||
        state.connectionId !== connectionId ||
        state.current !== null
      )
        fail("expired");
      const result = await this.#mutate(
        connectionId,
        expectedRevision,
        async (previous) => {
          if (!state.active) fail("expired");
          if (!previous || previous.deleted) fail("missing");
          const next = { ...previous, revision: previous.revision + 1 };
          next.ciphertext = await this.#encrypt(next, state.material);
          if (!state.active) fail("expired");
          return next;
        },
      );
      return result.revision;
    });
  }

  #owner(actor: Actor) {
    if (actor?.type !== "user" || actor.userId !== this.#ownerUserId)
      fail("forbidden");
  }
  #input(connectionId: string, material: Uint8Array) {
    if (
      !validId(connectionId) ||
      !(material instanceof Uint8Array) ||
      !material.length ||
      material.length > MAX_MATERIAL
    )
      fail("invalid");
  }
  #key(connectionId: string) {
    return createHash("sha256")
      .update(JSON.stringify([this.#projectId, connectionId]))
      .digest("hex");
  }
  async #referenceRecord(credentialRef: string): Promise<StoredCredential> {
    const key =
      typeof credentialRef === "string"
        ? REF.exec(credentialRef)?.[1]
        : undefined;
    if (!key) fail("missing");
    const record = await this.#read(key);
    if (!record || record.deleted || record.credentialRef !== credentialRef)
      fail("missing");
    return record;
  }
  async #guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof CredentialVaultError &&
        Object.hasOwn(messages, error.code)
      )
        throw new CredentialVaultError(error.code);
      return fail("storage"); // Never attach provider errors, paths or secret-bearing causes.
    }
  }
  async #directoryReady() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.#directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      fail("storage");
    // Canonicalize parent aliases (e.g. macOS /var), but never follow the vault itself.
    return realpath(this.#directory);
  }
  async #read(key: string): Promise<StoredCredential | null> {
    const directory = await this.#directoryReady();
    let file;
    try {
      file = await open(
        join(directory, `${key}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > MAX_RECORD ||
        (process.platform !== "win32" &&
          ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
      )
        fail("storage");
      const record = JSON.parse(
        await file.readFile("utf8"),
      ) as StoredCredential;
      if (
        !record ||
        record.schema !== 1 ||
        record.projectId !== this.#projectId ||
        !validId(record.connectionId) ||
        this.#key(record.connectionId) !== key ||
        !validRevision(record.revision) ||
        typeof record.deleted !== "boolean" ||
        typeof record.credentialRef !== "string" ||
        REF.exec(record.credentialRef)?.[1] !== key ||
        (record.deleted
          ? record.ciphertext !== null
          : typeof record.ciphertext !== "string")
      )
        fail("storage");
      return record;
    } finally {
      await file.close();
    }
  }
  async #mutate(
    connectionId: string,
    expectedRevision: Revision | null,
    change: (previous: StoredCredential | null) => Promise<StoredCredential>,
  ): Promise<CredentialMetadata> {
    if (
      !validId(connectionId) ||
      (expectedRevision !== null && !validRevision(expectedRevision))
    )
      fail("invalid");
    const directory = await this.#directoryReady();
    return withStateLock(directory, ".vault-lock", async () => {
      const key = this.#key(connectionId),
        previous = await this.#read(key);
      if ((previous?.revision ?? null) !== expectedRevision) fail("conflict");
      if (previous?.revision === Number.MAX_SAFE_INTEGER) fail("conflict");
      const next = await change(previous);
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      let file;
      try {
        file = await open(temporary, "wx", 0o600);
        await file.writeFile(JSON.stringify(next));
        await file.sync();
        await file.close();
        file = undefined;
        await rename(temporary, join(directory, `${key}.json`));
        if (process.platform !== "win32") {
          const folder = await open(directory, "r");
          try {
            await folder.sync();
          } finally {
            await folder.close();
          }
        }
      } finally {
        await file?.close();
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      return metadata(next);
    });
  }
  #available() {
    if (!this.#encryption.isAvailable()) fail("unavailable");
  }
  async #encrypt(
    record: StoredCredential,
    material: Uint8Array,
  ): Promise<string> {
    this.#available();
    // Identity inside the ciphertext prevents copying encrypted bytes to another record.
    const payload = Buffer.from(
      JSON.stringify({
        projectId: record.projectId,
        connectionId: record.connectionId,
        credentialRef: record.credentialRef,
        revision: record.revision,
        material: Buffer.from(material).toString("base64"),
      }),
    );
    try {
      const encrypted = await this.#encryption.encrypt(payload);
      if (
        !(encrypted instanceof Uint8Array) ||
        !encrypted.length ||
        encrypted.length > MAX_CIPHERTEXT
      )
        fail("storage");
      return Buffer.from(encrypted).toString("base64");
    } finally {
      payload.fill(0);
    }
  }
  async #decrypt(record: StoredCredential): Promise<Uint8Array> {
    this.#available();
    const plaintext = await this.#encryption.decrypt(
      decodeBase64(record.ciphertext, MAX_CIPHERTEXT),
    );
    try {
      if (
        !(plaintext instanceof Uint8Array) ||
        plaintext.length > MAX_CIPHERTEXT
      )
        fail("storage");
      const payload = JSON.parse(Buffer.from(plaintext).toString("utf8"));
      if (
        !payload ||
        payload.projectId !== record.projectId ||
        payload.connectionId !== record.connectionId ||
        payload.credentialRef !== record.credentialRef ||
        payload.revision !== record.revision
      )
        fail("storage");
      return decodeBase64(payload.material, MAX_MATERIAL);
    } finally {
      plaintext.fill(0);
    }
  }
  async #withHandle<T>(
    connectionId: string,
    material: Uint8Array,
    current: CredentialMetadata | null,
    use: (handle: TrustedCredentialHandle) => Promise<T>,
  ): Promise<T> {
    const state: HandleState = {
      connectionId,
      material,
      current,
      active: true,
      borrowed: new Set(),
    };
    const handle = Object.freeze(
      Object.defineProperties(
        {},
        {
          opaqueHandle: { value: randomUUID() },
          use: {
            value: async <R,>(
              authenticate: (bytes: Uint8Array) => Promise<R>,
            ): Promise<R> => {
              return this.#guard(async () => {
                if (!state.active) fail("expired");
                let borrowed: Uint8Array | undefined;
                const invoke = () => {
                  if (!state.active) fail("expired");
                  const bytes = Uint8Array.from(state.material);
                  borrowed = bytes;
                  state.borrowed.add(bytes);
                  // Invocation is credential admission. Box the handled promise
                  // so the mutation lock releases before any remote I/O or
                  // nested use/replace completes. A later rotation is in flight.
                  const pending = this.#callback(() =>
                    authenticate(bytes),
                  ).then(
                    (value) => ({ ok: true as const, value }),
                    (error: unknown) => ({ ok: false as const, error }),
                  );
                  return { pending };
                };
                try {
                  const admitted = state.current
                    ? await withStateLock(
                        await this.#directoryReady(),
                        ".vault-lock",
                        async () => {
                          if (!state.active) fail("expired");
                          const record = await this.#read(
                            this.#key(connectionId),
                          );
                          if (
                            !record ||
                            record.deleted ||
                            record.revision !== state.current!.revision ||
                            record.credentialRef !==
                              state.current!.credentialRef
                          )
                            fail("expired");
                          return invoke();
                        },
                      )
                    : invoke();
                  const result = await admitted.pending;
                  if (!result.ok) throw result.error;
                  return result.value;
                } finally {
                  if (borrowed) {
                    borrowed.fill(0);
                    state.borrowed.delete(borrowed);
                  }
                }
              });
            },
          },
          toJSON: { value: () => fail("result") },
          [inspect.custom]: { value: () => "[TrustedCredentialHandle]" },
        },
      ),
    ) as TrustedCredentialHandle;
    this.#handles.set(handle, state);
    try {
      return await this.#callback(() => use(handle));
    } finally {
      state.active = false;
      material.fill(0);
      for (const bytes of state.borrowed) bytes.fill(0);
      state.borrowed.clear();
    }
  }
  async #callback<T>(fn: () => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      if (
        error instanceof CredentialVaultError &&
        Object.hasOwn(messages, error.code)
      )
        throw new CredentialVaultError(error.code);
      return fail("callback");
    }
    const seen = new Set<object>();
    const check = (value: unknown) => {
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (
        ArrayBuffer.isView(value) ||
        value instanceof ArrayBuffer ||
        this.#handles.has(value as TrustedCredentialHandle)
      )
        fail("result");
      if (value instanceof Map)
        for (const [key, item] of value) {
          check(key);
          check(item);
        }
      else if (value instanceof Set) for (const item of value) check(item);
      else for (const item of Object.values(value)) check(item);
    };
    check(result);
    return result;
  }
}
