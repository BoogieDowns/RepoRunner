// Three-edition Stage 1: a pure, deterministic capability and entitlement
// model. It evaluates explicitly supplied state and nothing else: no clock,
// files, Electron, IPC, network, storage, license verification or provider
// calls, and no side effects. Nothing in the app uses it yet, so it changes
// no runtime behavior.
//
// Rules (docs/ARCHITECTURE_NOTES.md, "What Stage 1 models"):
// - Local capabilities are always available, in every state.
// - Entitlement comes from verified state, never from the edition label
//   alone; anything missing, unknown or contradictory denies (fails closed).
// - A license is not readiness, and readiness is not a license.
// - No AI feature is implemented yet, so none is ever usable.
// Relative imports keep it usable from tests.
import { MAX_FREE_REPO_PROFILES } from "../../types";
import type {
  AiCapability,
  AiCapabilityResult,
  AiReason,
  AiRoute,
  CapabilityReport,
  CloudEntitlement,
  Edition,
  EditionState,
  LicenseState,
  LocalCapability,
  ProviderReadiness,
} from "./types";

const EDITIONS: readonly Edition[] = ["free", "byok-pro", "cloud-pro"];
const LICENSE_STATES: readonly LicenseState[] = ["none", "valid", "invalid", "not-verifiable"];
const PROVIDER_STATES: readonly ProviderReadiness[] = ["none", "api-key", "local-endpoint"];
const CLOUD_ENTITLEMENTS: readonly CloudEntitlement[] = ["active", "expired", "revoked", "unknown"];

export const LOCAL_CAPABILITIES: readonly LocalCapability[] = Object.freeze([
  "repository-management",
  "local-setup",
  "analyze-repo",
  "suggested-setup",
  "repo-safety-check",
  "run-controls",
] as const);

export const AI_CAPABILITIES: readonly AiCapability[] = Object.freeze(["ai-setup-recommendations", "failed-run-explanations", "managed-ai"] as const);

/** Which AI features this version of RepoRunner contains. None yet. */
export const AI_IMPLEMENTED: Readonly<Record<AiCapability, boolean>> = Object.freeze({
  "ai-setup-recommendations": false,
  "failed-run-explanations": false,
  "managed-ai": false,
});

/** Why an unimplemented feature isn't available: failed-run explanations are explicitly deferred. */
const UNAVAILABLE_REASON: Readonly<Record<AiCapability, AiReason>> = Object.freeze({
  "ai-setup-recommendations": "not-implemented",
  "failed-run-explanations": "deferred",
  "managed-ai": "not-implemented",
});

/** Exact membership only: no trimming, case folding or prototype lookups. */
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && values.includes(value as T);
const isTimestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** True when every supplied value is one this model knows. */
function isKnownState(state: unknown, evaluatedAt: unknown): state is EditionState {
  if (!isTimestamp(evaluatedAt) || typeof state !== "object" || state === null) return false;
  const s = state as Record<string, unknown>;
  const cloud = s.cloud as Record<string, unknown> | null | undefined;
  return (
    oneOf(EDITIONS, s.edition) &&
    oneOf(LICENSE_STATES, s.license) &&
    oneOf(PROVIDER_STATES, s.provider) &&
    typeof cloud === "object" &&
    cloud !== null &&
    typeof cloud.signedIn === "boolean" &&
    oneOf(CLOUD_ENTITLEMENTS, cloud.entitlement) &&
    typeof cloud.online === "boolean" &&
    (cloud.lastVerifiedAt === null || isTimestamp(cloud.lastVerifiedAt))
  );
}

interface RouteVerdict {
  entitlementReason: AiReason | null;
  readinessReason: AiReason | null;
  route: AiRoute | null;
}

const LICENSE_REASON: Record<Exclude<LicenseState, "valid">, AiReason> = {
  none: "license-missing",
  invalid: "license-invalid",
  "not-verifiable": "license-not-verifiable",
};

/** BYOK Pro: the license decides entitlement; the provider decides readiness. Independent of each other. */
function byokVerdict(state: EditionState): RouteVerdict {
  const entitlementReason = state.license === "valid" ? null : LICENSE_REASON[state.license];
  if (state.provider === "none") return { entitlementReason, readinessReason: "provider-not-configured", route: null };
  // A local endpoint needs no API key.
  return { entitlementReason, readinessReason: null, route: state.provider === "api-key" ? "byok-api-key" : "byok-local" };
}

/**
 * Cloud Pro: only a signed-in account with a backend-confirmed active
 * entitlement is entitled; being online is readiness. A cached entitlement
 * while offline is never ready, and there is no offline grace period.
 */
function cloudVerdict(state: EditionState, evaluatedAt: number): RouteVerdict {
  const { signedIn, entitlement, online, lastVerifiedAt } = state.cloud;
  let entitlementReason: AiReason | null;
  if (!signedIn) entitlementReason = "cloud-signed-out";
  else if (entitlement === "expired") entitlementReason = "cloud-entitlement-expired";
  else if (entitlement === "revoked") entitlementReason = "cloud-entitlement-revoked";
  else if (entitlement === "unknown") entitlementReason = "cloud-entitlement-unknown";
  // "active" must come from a real confirmation, not from the future.
  else if (lastVerifiedAt === null || lastVerifiedAt > evaluatedAt) entitlementReason = "cloud-state-inconsistent";
  else entitlementReason = null;
  return { entitlementReason, readinessReason: online ? null : "cloud-offline", route: "cloud-managed" };
}

/** What each edition offers for each AI capability. */
function verdict(capability: AiCapability, state: EditionState, evaluatedAt: number): RouteVerdict {
  switch (state.edition) {
    case "free":
      return { entitlementReason: "edition-not-entitled", readinessReason: null, route: null };
    case "byok-pro":
      // BYOK Pro uses the user's own provider; managed AI is Cloud Pro's.
      return capability === "managed-ai" ? { entitlementReason: "edition-not-entitled", readinessReason: null, route: null } : byokVerdict(state);
    case "cloud-pro":
      // Cloud Pro serves every AI capability through managed AI (whether it may also use the user's own key is undecided).
      return cloudVerdict(state, evaluatedAt);
  }
}

function result(capability: AiCapability, v: RouteVerdict): AiCapabilityResult {
  const entitled = v.entitlementReason === null;
  const ready = v.route !== null && v.readinessReason === null;
  const prospectivelyEligible = entitled && ready;
  const implemented = AI_IMPLEMENTED[capability];
  const usable = prospectivelyEligible && implemented;
  const reason = usable ? null : (v.entitlementReason ?? v.readinessReason ?? (implemented ? null : UNAVAILABLE_REASON[capability]));
  return {
    capability,
    entitled,
    entitlementReason: v.entitlementReason,
    ready,
    readinessReason: v.readinessReason,
    prospectivelyEligible,
    implemented,
    usable,
    reason,
    route: prospectivelyEligible ? v.route : null,
  };
}

/**
 * Evaluates the capabilities for `state` at `evaluatedAt` (ms since epoch,
 * supplied by the caller; the model never reads the clock). Unknown or
 * malformed input fails closed: local capabilities stay, all AI is denied.
 */
export function evaluateCapabilities(state: EditionState, evaluatedAt: number): CapabilityReport {
  const valid = isKnownState(state, evaluatedAt);
  const suppliedEdition: unknown = typeof state === "object" && state !== null ? (state as { edition?: unknown }).edition : undefined;
  const edition: Edition = oneOf(EDITIONS, suppliedEdition) ? suppliedEdition : "free";
  const ai = {} as Record<AiCapability, AiCapabilityResult>;
  for (const capability of AI_CAPABILITIES) {
    const v: RouteVerdict = valid ? verdict(capability, state, evaluatedAt) : { entitlementReason: "invalid-state", readinessReason: null, route: null };
    ai[capability] = result(capability, v);
  }
  return {
    edition,
    inputValid: valid,
    localCapabilities: LOCAL_CAPABILITIES,
    savedSetupLimit: MAX_FREE_REPO_PROFILES,
    ai,
  };
}
