import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const appSource = readFileSync("app/src/App.jsx", "utf8");
const bridgeSource = readFileSync("extension/content/jizhangerp-bridge.js", "utf8");

const requirePattern = (source, pattern, message) => {
  assert.match(source, pattern, message);
};

requirePattern(bridgeSource, /capabilities:\s*\{[\s\S]*followSell:\s*true[\s\S]*dryRunPreview:\s*true[\s\S]*localListingBridge:\s*true[\s\S]*\}/, "bridge ping must advertise local listing capabilities");

requirePattern(appSource, /const extensionSupportsLocalListing = \(response = \{\}\) =>[\s\S]*response\?\.capabilities\?\.followSell === true[\s\S]*response\?\.capabilities\?\.dryRunPreview === true[\s\S]*response\?\.capabilities\?\.localListingBridge === true/, "frontend must require all local listing capabilities");
requirePattern(appSource, /status:\s*"partial"[\s\S]*缺少本地 follow-sell 上架桥能力/, "frontend must distinguish source-plugin ping from local follow-sell readiness");
requirePattern(appSource, /const requestExtensionPrefetch = async/, "frontend must expose source-plugin prefetch compatibility path");
requirePattern(appSource, /const requestSourcePluginListing = async[\s\S]*requestExtensionPrefetch[\s\S]*\/ozon\/products\/import\/preview[\s\S]*\/ozon\/products\/import/, "source-plugin fallback must use prefetch and local import endpoints");
requirePattern(appSource, /const bridgeStatus = listingBridgeStatusFromPing\(ping\);[\s\S]*if \(bridgeStatus\.status !== "ok" && bridgeStatus\.status !== "partial"\) \{[\s\S]*throw new Error\(bridgeStatus\.error\);[\s\S]*\}[\s\S]*requestExtensionFollowSell[\s\S]*requestSourcePluginListing/, "listing request must use follow-sell for local bridge and prefetch fallback for source plugin");
requirePattern(appSource, /const listingPluginUsable = pluginStatus\.status === "ok" \|\| pluginStatus\.status === "partial"/, "partial source-plugin mode must keep listing actions available");
requirePattern(appSource, /disabled=\{!listingPluginUsable\}[\s\S]*上架预检/, "preview button must only be disabled when no usable plugin path exists");
requirePattern(appSource, /disabled=\{!listingPluginUsable\}[\s\S]*提交上架到 Ozon/, "submit button must only be disabled when no usable plugin path exists");
requirePattern(appSource, /源插件兼容采集模式/, "UI must explain source-plugin compatibility mode");
requirePattern(appSource, /const \[listingResult, setListingResult\] = useState\(null\)/, "collect edit page must keep listing result in visible state");
requirePattern(appSource, /className="collect-listing-result"[\s\S]*listingResult\.title[\s\S]*listingResult\.detail/, "collect edit page must render persistent listing result details");

console.log("plugin readiness gate ok");
