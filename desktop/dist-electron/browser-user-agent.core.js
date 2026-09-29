export function chromeCompatibleUserAgent() {
    const chromeMajor = String(process.versions.chrome || '142').split('.')[0];
    const platform = process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'Macintosh; Intel Mac OS X 10_15_7';
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
}

