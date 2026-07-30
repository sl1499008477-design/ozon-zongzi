# Capture-only extension preview design

## Goal

The Web `/extension` page must preview the same capture-only popup distributed
with the extension, must not advertise Seller or background synchronization, and
must not retain a second stale popup implementation.

## Design

- Treat `app/public/sonli-extension-0.13.46.1/popup/popup.html` as the only Web
  preview artifact. It is generated from `extension/` by the existing packaging
  command and already contains Web-login-only Collector-session guidance.
- Remove `app/public/plugin/`. It has no packaging owner and duplicates an old
  SMS/password popup, so keeping it creates an independent authentication surface.
- Put extension page version, download path, preview path and capability labels in
  one small application contract module consumed by `PluginPanel`.
- Describe `content/ozon-seller-bridge.js` as a Seller page collection bridge and
  `background/service-worker.js` as Collector-session/upload scheduling. Neither
  label may imply Seller Cookie synchronization or an extension sync engine.

## Verification contract

- A behavior test imports the page contract and proves the preview path resolves
  to the generated capture-only popup, whose HTML contains Web-login guidance and
  no SMS/password login.
- The same test proves `app/public/plugin/` is absent and rejects all retired route
  and synchronization labels.
- Plugin readiness supplements the behavior contract by rejecting stale literals
  or a PluginPanel that stops consuming the shared contract.
- App build, active tests, plugin readiness and extension packaging parity must
  pass. Because extension source and generated artifacts do not change, the
  extension ZIPs must remain byte-identical.

## Rollback

Revert the implementation commit. Do not restore `app/public/plugin/` without an
explicit security review; if a legacy preview is deliberately restored, it must
be generated from the current capture-only popup rather than copied by hand.
