import { corePackageVersion } from '../package-version.js';

const PRODUCT = 'commandvault';
/** A version that is safe to send as a product token: no space, quote, comment or line break. */
const SAFE_VERSION = /^[0-9][\w.+-]*$/;

function buildUserAgent(): string {
  const version = corePackageVersion();
  return version !== undefined && SAFE_VERSION.test(version) ? `${PRODUCT}/${version}` : PRODUCT;
}

/**
 * The one identity every remote fetch sends: the product and its version, as RFC 9110 10.1.5
 * describes a product token, and nothing about the machine, the user or the runtime. Some hosts
 * (api.github.com among them) refuse a request that carries no User-Agent at all.
 */
export const USER_AGENT = buildUserAgent();
