// Three-edition Stage 1: types for the pure capability and entitlement model.
// Planning names (see docs/ARCHITECTURE_NOTES.md, "Three-edition direction"):
// RepoRunner Free, RepoRunner BYOK Pro and RepoRunner Cloud Pro.
//
// Everything here describes state that a future stage will report to the
// model (a verified license, a configured provider, a backend-confirmed
// entitlement). Nothing here verifies, stores or contains a secret.

/** The product mode the user has chosen. A label, not proof of purchase. */
export type Edition = "free" | "byok-pro" | "cloud-pro";

/**
 * BYOK Pro license state as reported by a future license check.
 * - not-verifiable: the check couldn't reach a verdict (for example offline).
 *   Treated as no entitlement until an offline policy is decided.
 */
export type LicenseState = "none" | "valid" | "invalid" | "not-verifiable";

/**
 * Which AI configuration the user has set up, as reported by a future
 * settings stage. Configuration only: not proof the provider is reachable,
 * and never the key or endpoint itself.
 */
export type ProviderReadiness = "none" | "api-key" | "local-endpoint";

/** The last entitlement the Cloud Pro backend confirmed. */
export type CloudEntitlement = "active" | "expired" | "revoked" | "unknown";

export interface CloudState {
  signedIn: boolean;
  entitlement: CloudEntitlement;
  /** Whether the app can currently reach the Cloud Pro backend. */
  online: boolean;
  /** When the backend last confirmed `entitlement` (ms since epoch), or null if never. */
  lastVerifiedAt: number | null;
}

export interface EditionState {
  edition: Edition;
  /** Only meaningful for BYOK Pro. */
  license: LicenseState;
  /** Only meaningful for BYOK Pro. */
  provider: ProviderReadiness;
  /** Only meaningful for Cloud Pro. */
  cloud: CloudState;
}

/** Capabilities every edition has, always, whatever the AI, license or account state. */
export type LocalCapability =
  | "repository-management"
  | "local-setup"
  | "analyze-repo"
  | "suggested-setup"
  | "repo-safety-check"
  | "run-controls";

/** Planned AI capabilities. None is implemented yet. */
export type AiCapability = "ai-setup-recommendations" | "failed-run-explanations" | "managed-ai";

/** How an eligible AI capability would be served. */
export type AiRoute = "byok-api-key" | "byok-local" | "cloud-managed";

/** Stable reason codes. Never rename one: future stages and tests rely on them. */
export type AiReason =
  // Entitlement
  | "invalid-state"
  | "edition-not-entitled"
  | "license-missing"
  | "license-invalid"
  | "license-not-verifiable"
  | "cloud-signed-out"
  | "cloud-entitlement-expired"
  | "cloud-entitlement-revoked"
  | "cloud-entitlement-unknown"
  | "cloud-state-inconsistent"
  // Readiness
  | "provider-not-configured"
  | "cloud-offline"
  // Availability in this version of the app
  | "deferred"
  | "not-implemented";

export interface AiCapabilityResult {
  capability: AiCapability;
  /** The edition and its verified state permit this capability. */
  entitled: boolean;
  entitlementReason: AiReason | null;
  /** The configuration it needs is in place (provider configured, or Cloud online). */
  ready: boolean;
  readinessReason: AiReason | null;
  /**
   * Entitled and ready: what a future version would allow. Not permission to
   * do anything now. For Cloud Pro it is never authorization for a backend
   * request: the backend checks entitlement itself.
   */
  prospectivelyEligible: boolean;
  /** Whether this version of RepoRunner contains the feature. */
  implemented: boolean;
  /** Eligible and implemented. Always false in Stage 1. */
  usable: boolean;
  /** Why it isn't usable: the first of entitlement, readiness, availability. Null only when usable. */
  reason: AiReason | null;
  /** The route it would use when eligible; null otherwise. */
  route: AiRoute | null;
}

export interface CapabilityReport {
  /** The edition evaluated (Free when the supplied edition wasn't recognised). */
  edition: Edition;
  /** False when any supplied value wasn't one of the known values; AI is then denied. */
  inputValid: boolean;
  /** Always every local capability, in a fixed order. */
  localCapabilities: readonly LocalCapability[];
  /** The saved-setup limit currently enforced (unchanged by editions in Stage 1). */
  savedSetupLimit: number;
  ai: Record<AiCapability, AiCapabilityResult>;
}
