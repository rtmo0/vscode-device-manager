import type { AfcDomain } from './devices';

/* Layout of ios://<udid>/: a virtual root with Media (the AFC media domain) and Apps/<bundle id> (each app's Documents). */

export const MEDIA_FOLDER = 'Media';
export const APPS_FOLDER = 'Apps';

export type IosLocation =
  | { kind: 'root' }
  | { kind: 'apps' }
  | {
      kind: 'afc';
      domain: AfcDomain;
      /** Path inside the AFC connection. */
      path: string;
      /** The Media folder or an app folder itself, which cannot be renamed or deleted. */
      isDomainRoot: boolean;
    };

export function resolveIosPath(uriPath: string): IosLocation | undefined {
  const parts = uriPath.split('/').filter(Boolean);
  if (!parts.length) {
    return { kind: 'root' };
  }
  const [top, ...rest] = parts;
  if (top === MEDIA_FOLDER) {
    return { kind: 'afc', domain: { kind: 'media' }, path: `/${rest.join('/')}`, isDomainRoot: rest.length === 0 };
  }
  if (top === APPS_FOLDER) {
    if (!rest.length) {
      return { kind: 'apps' };
    }
    const [bundleId, ...inner] = rest;
    // VendDocuments exposes the container with Documents at /Documents.
    return { kind: 'afc', domain: { kind: 'app', bundleId }, path: ['/Documents', ...inner].join('/'), isDomainRoot: inner.length === 0 };
  }
  return undefined;
}
