# Crew public identity

The approved Crew mark is the four bold colored shapes in [`build/crew-mark.png`](../../build/crew-mark.png). Keep that file as the source of truth. App-specific icon exports remain in `build/icon.png` and `build/icon.icns`; repository presentation must not silently replace app icons or redesign the mark.

## Social preview

[`social-preview.png`](social-preview.png) is a 1280 × 640 PNG for GitHub's repository social preview. It uses the existing mark, a warm light background and the Crew blue accent. It contains no app screenshot or private project data. The README uses the same export.

The editable source is [`social-preview.svg`](social-preview.svg). Its image points to the approved mark. Export with Node.js and librsvg (`rsvg-convert` available on PATH):

```sh
node docs/brand/render-social-preview.mjs
```

The export helper embeds the existing image only in a temporary render input so librsvg can load it reliably. It adds no application dependencies and does not modify the source mark. Visually inspect the export after changing copy, layout or fonts; font rendering can differ between systems.

### Upload to GitHub

A repository administrator can open **Settings → General → Social preview → Edit → Upload an image**, then choose `docs/brand/social-preview.png`. GitHub stores this as repository metadata: merging the asset alone does not upload it. Keep the image under 1 MB and verify the preview after uploading.

This change prepares the asset; it does not claim the repository social preview has been uploaded. A repository has no separate per-repository avatar setting; the README can display its own logo, while GitHub avatars belong to the owning account or organization.

## Copy and discoverability

Suggested repository description:

> A local macOS workspace for coordinating Codex agents through voice and text.

Topics should describe implemented capabilities and the actual stack, not promise future platforms or features. Keep metadata independent of a particular release number. Avoid synthetic download counts, test badges without a hosted check, unsupported claims of production readiness, or a license badge before the owner chooses a license.

For public screenshots or demos, use disposable mock data and keep screenshot files outside the repository unless explicitly requested. Do not expose real conversations, local paths, account identifiers, credentials or business tickets.
