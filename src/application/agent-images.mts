import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { validateProfilePicture } from "../manager/profile-picture.mjs";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const missing = (error: unknown) => object(error) && error.code === "ENOENT";
const imageError = () =>
  new Error("This project picture is unavailable. Choose the picture again.");

/** Private profile pictures only. The host supplies a dedicated project state
 * directory outside the repository. No paths or public URLs cross this boundary. */
export function createAgentImages(options: {
  directory: string;
  projectId: string;
}) {
  if (
    !options.projectId ||
    options.projectId.length > 512 ||
    /[\u0000-\u001f]/.test(options.projectId)
  )
    throw new Error("A project identity is required.");
  const namespace = createHash("sha256")
    .update(options.projectId)
    .digest("hex")
    .slice(0, 24);
  const prefix = `crew-image:${namespace}:`;
  const idPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  let initialized: Promise<string> | undefined;
  const boundedRead = async (path: string, maxBytes: number) => {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.size <= 0 ||
        before.size > maxBytes ||
        before.nlink !== 1
      )
        throw imageError();
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await file.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const after = await file.stat();
      if (
        length > maxBytes ||
        before.size !== length ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      )
        throw imageError();
      return buffer.subarray(0, length).toString("utf8");
    } finally {
      await file.close();
    }
  };
  const writeNew = async (path: string, value: string) => {
    const file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
  };
  const directory = async () => {
    if (!initialized) {
      initialized = (async () => {
        await mkdir(options.directory, { recursive: true, mode: 0o700 });
        const stat = await lstat(options.directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw imageError();
        const root = await realpath(options.directory);
        const marker = join(root, "identity.json");
        try {
          await writeNew(
            marker,
            JSON.stringify({ projectId: options.projectId }),
          );
        } catch (error) {
          if (!object(error) || error.code !== "EEXIST") throw error;
        }
        const identity: unknown = JSON.parse(await boundedRead(marker, 4_096));
        if (!object(identity) || identity.projectId !== options.projectId)
          throw imageError();
        return root;
      })();
      initialized.catch(() => {
        initialized = undefined;
      });
    }
    const root = await initialized;
    // Do not follow a directory that has been redirected since first use.
    const stat = await lstat(options.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(options.directory)) !== root
    )
      throw imageError();
    return root;
  };
  return {
    async save(picture: unknown): Promise<{ imageRef: string }> {
      const valid = validateProfilePicture(picture);
      if (!valid) throw new Error("Choose a PNG, JPEG or WebP picture.");
      const id = randomUUID();
      try {
        await writeNew(
          join(await directory(), `${id}.json`),
          JSON.stringify({ projectId: options.projectId, picture: valid }),
        );
      } catch {
        throw imageError();
      }
      return { imageRef: `${prefix}${id}` };
    },
    async read(imageRef: unknown): Promise<{ picture: string } | null> {
      if (
        typeof imageRef !== "string" ||
        !imageRef.startsWith(prefix) ||
        !idPattern.test(imageRef.slice(prefix.length))
      )
        return null;
      try {
        const saved: unknown = JSON.parse(
          await boundedRead(
            join(await directory(), `${imageRef.slice(prefix.length)}.json`),
            710_000,
          ),
        );
        if (!object(saved) || saved.projectId !== options.projectId)
          throw imageError();
        const picture = validateProfilePicture(saved.picture);
        if (!picture) throw imageError();
        return { picture };
      } catch (error) {
        if (missing(error)) return null;
        throw imageError();
      }
    },
  };
}

/** Register only on the authenticated owner router, never the agent tool broker. */
export function createImageOwnerCommands(
  images: ReturnType<typeof createAgentImages>,
) {
  return async (command: string, args: unknown): Promise<unknown> => {
    if (!object(args)) throw new Error("Picture fields are required.");
    if (
      command === "images.save" &&
      Object.keys(args).length === 1 &&
      "picture" in args
    )
      return images.save(args.picture);
    if (
      command === "images.read" &&
      Object.keys(args).length === 1 &&
      "imageRef" in args
    )
      return images.read(args.imageRef);
    throw new Error("Unsupported picture command.");
  };
}
