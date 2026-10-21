export interface ProfileIdentity {
  name?: unknown;
  picture?: unknown;
}
export const PROFILE_PICTURE_MAX_BYTES = 512 * 1024;
export const PROFILE_NAME_MAX_LENGTH = 80;
export const PROFILE_PERSONALITY_MAX_LENGTH = 8000;
const picturePattern =
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function managerDisplayName(profile?: ProfileIdentity | null) {
  return typeof profile?.name === "string" && profile.name.trim()
    ? profile.name.trim()
    : "Manager";
}

export function managerPicture(profile?: ProfileIdentity | null) {
  const picture = profile?.picture;
  return typeof picture === "string" &&
    picture.length <= Math.ceil(PROFILE_PICTURE_MAX_BYTES / 3) * 4 + 32 &&
    picturePattern.test(picture)
    ? picture
    : null;
}

export async function readProfilePicture(file: File) {
  if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Choose a PNG, JPEG or WebP image.");
  if (!file.size || file.size > PROFILE_PICTURE_MAX_BYTES)
    throw new Error("Choose an image smaller than 512 KB.");
  const picture = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error("Could not read this picture. Choose it again."));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Invalid image data"));
    reader.readAsDataURL(file);
  });
  if (!managerPicture({ picture }))
    throw new Error("Could not read this picture as a supported image.");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("This image could not be opened. Choose another picture.");
  });
  try {
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width > 2048 ||
      bitmap.height > 2048
    )
      throw new Error("Choose an image no larger than 2048 × 2048 pixels.");
  } finally {
    bitmap.close();
  }
  return picture;
}
