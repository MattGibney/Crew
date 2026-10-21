// AI-015: pure release gates; errors name missing configuration, never values.
export const requiredSigningSecrets = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY_BASE64', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_TEAM_ID'];
export function assertReleaseVersion(version, tag) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `v${version}`) throw new Error('Release tag must exactly match the stable package version: vMAJOR.MINOR.PATCH.');
}
export function assertSigningEnvironment(env) {
  const missing = requiredSigningSecrets.filter(name => !String(env[name] || '').trim());
  if (missing.length) throw new Error(`Signed release blocked. Configure encrypted GitHub secrets: ${missing.join(', ')}. Unsigned candidates cannot be published as updates.`);
}
export function artifactNames(version, signed) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid package version.');
  const prefix = `Crew-${version}-arm64`;
  return [`${prefix}.dmg`, `${prefix}.zip`, `${prefix}.dmg.blockmap`, `${prefix}.zip.blockmap`, ...(signed ? ['latest-mac.yml'] : []), 'SHA256SUMS.txt'];
}
