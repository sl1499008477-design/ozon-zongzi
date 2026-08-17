function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function chromeMatchPatternCovers(pattern, input) {
  if (pattern === '<all_urls>') {
    return ['http:', 'https:', 'file:', 'ftp:'].includes(new URL(input).protocol);
  }
  const match = String(pattern).match(/^(\*|http|https):\/\/([^/]+)(\/.*)$/);
  if (!match) return false;
  const [, scheme, hostPattern, pathPattern] = match;
  const url = new URL(input);
  const allowedScheme = scheme === '*'
    ? ['http:', 'https:'].includes(url.protocol)
    : url.protocol === `${scheme}:`;
  if (!allowedScheme) return false;

  const hostname = url.hostname.toLowerCase();
  const normalizedHostPattern = hostPattern.toLowerCase();
  const allowedHost = normalizedHostPattern === '*'
    || (
      normalizedHostPattern.startsWith('*.')
      && (
        hostname === normalizedHostPattern.slice(2)
        || hostname.endsWith(`.${normalizedHostPattern.slice(2)}`)
      )
    )
    || hostname === normalizedHostPattern;
  if (!allowedHost) return false;

  const pathRegex = new RegExp(
    `^${pathPattern.split('*').map(escapeRegex).join('.*')}$`,
  );
  return pathRegex.test(`${url.pathname}${url.search}`);
}

module.exports = { chromeMatchPatternCovers };
