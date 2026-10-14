// CPAY Wallet release shown on /assets/wallet (the Download wallet page).
//
// Data only. The page shows a download link ONLY when `url` is set to the
// wallet's own https hostname (never this website's hostname) AND
// `publishedAt` is set. Leave both null until the owner has published and
// tested the wallet (see wallet/README.md, "Publish"); until then the page
// says the wallet is not available yet and shows no link.
//
// `version` must match wallet/package.json. `versionJsonSha256` is the
// sha256 of the published version.json that the wallet build prints, so a
// member or auditor can check the release file by file.
window.CPAY_WALLET_RELEASE = Object.freeze({
  version: '0.1.0',
  url: null,
  publishedAt: null,
  versionJsonSha256: null,
});
