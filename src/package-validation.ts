/**
 * apt / npm package-name validators — the single source of truth shared by every path that can
 * add a package to a per-group image: the MCP self-mod path (`modules/self-mod/request.ts`), the
 * `ncl config add-package` CLI (`cli/resources/groups.ts`), and the image-build guard in
 * `container-runner.ts` (`buildAgentGroupImage`). A name that fails these never reaches the
 * `RUN apt-get install -y ${names}` / `pnpm add ${names}` shell interpolation in the Dockerfile,
 * so an embedded newline/metacharacter cannot inject an extra Dockerfile layer or shell command.
 */
export const APT_PACKAGE_RE = /^[a-z0-9][a-z0-9._+-]*$/;
export const NPM_PACKAGE_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * Returns a `"apt:<name>"` / `"npm:<name>"` string for the first invalid package, or null when all
 * names are well-formed. Pure — callers decide how to surface the rejection.
 */
export function invalidPackageName(apt: string[], npm: string[]): string | null {
  const badApt = apt.find((p) => !APT_PACKAGE_RE.test(p));
  if (badApt !== undefined) return `apt:${badApt}`;
  const badNpm = npm.find((p) => !NPM_PACKAGE_RE.test(p));
  if (badNpm !== undefined) return `npm:${badNpm}`;
  return null;
}
