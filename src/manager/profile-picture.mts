// Bounded local image data, validated without files, network requests or native capture.
export function validateProfilePicture(picture: unknown): string | null {
  if (picture === null) return picture;
  if (typeof picture !== "string" || picture.length > 700000)
    throw Error("Choose a PNG, JPEG or WebP picture up to 512 KiB.");
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(picture);
  if (!match) throw Error("Choose a PNG, JPEG or WebP picture.");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 512 * 1024 || bytes.toString("base64") !== match[2])
    throw Error("Picture must be valid base64 and at most 512 KiB.");
  let width: number | undefined, height: number | undefined;
  if (
    match[1] === "png" &&
    bytes.length >= 33 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (match[1] === "jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 8
      ) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (
    match[1] === "webp" &&
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const format = bytes.toString("ascii", 12, 16);
    if (format === "VP8X") {
      width = 1 + bytes.readUIntLE(24, 3);
      height = 1 + bytes.readUIntLE(27, 3);
    } else if (
      format === "VP8 " &&
      bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))
    ) {
      width = bytes.readUInt16LE(26) & 16383;
      height = bytes.readUInt16LE(28) & 16383;
    } else if (format === "VP8L" && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21);
      width = 1 + (bits & 16383);
      height = 1 + ((bits >>> 14) & 16383);
    }
  }
  if (!width || !height || width > 2048 || height > 2048)
    throw Error(
      "Picture must be a valid PNG, JPEG or WebP no larger than 2048 × 2048 pixels.",
    );
  return picture;
}
