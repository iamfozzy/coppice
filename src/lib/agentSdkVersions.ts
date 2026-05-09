import claudeAgentSdkPackage from "../../src-tauri/resources/agent-bridge/node_modules/@anthropic-ai/claude-agent-sdk/package.json";
import piCodingAgentPackage from "../../src-tauri/resources/agent-bridge/node_modules/@earendil-works/pi-coding-agent/package.json";

type PackageMetadata = {
  version?: string;
};

function getPackageVersion(pkg: PackageMetadata): string {
  return pkg.version || "—";
}

export const agentSdkVersions = {
  claudeAgentSdk: getPackageVersion(claudeAgentSdkPackage),
  piSdk: getPackageVersion(piCodingAgentPackage),
} as const;
