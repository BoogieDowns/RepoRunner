// Three-edition Stage 1: the pure capability and entitlement model.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AI_CAPABILITIES, AI_IMPLEMENTED, LOCAL_CAPABILITIES, evaluateCapabilities } from "../../../src/lib/editions/capabilities";
import type { AiCapability, AiCapabilityResult, CloudEntitlement, CloudState, Edition, EditionState, LicenseState, ProviderReadiness } from "../../../src/lib/editions/types";
import { MAX_FREE_REPO_PROFILES } from "../../../src/types";
import { deepFreeze } from "../insights/builders";

const NOW = 1_800_000_000_000;
const EARLIER = NOW - 60_000;
const SIGNED_OUT: CloudState = { signedIn: false, entitlement: "unknown", online: true, lastVerifiedAt: null };
const ACTIVE: CloudState = { signedIn: true, entitlement: "active", online: true, lastVerifiedAt: EARLIER };
const state = (over: Partial<EditionState> = {}): EditionState => ({ edition: "free", license: "none", provider: "none", cloud: SIGNED_OUT, ...over });
const ALL_LOCAL = ["repository-management", "local-setup", "analyze-repo", "suggested-setup", "repo-safety-check", "run-controls"];

type Expect = Pick<AiCapabilityResult, "entitled" | "ready" | "prospectivelyEligible" | "usable" | "reason" | "route">;
const pick = (r: AiCapabilityResult): Expect => ({ entitled: r.entitled, ready: r.ready, prospectivelyEligible: r.prospectivelyEligible, usable: r.usable, reason: r.reason, route: r.route });
const denied = (reason: string, ready = false): Expect => ({ entitled: false, ready, prospectivelyEligible: false, usable: false, reason: reason as never, route: null });
const eligible = (route: string, reason: string): Expect => ({ entitled: true, ready: true, prospectivelyEligible: true, usable: false, reason: reason as never, route: route as never });
const notReady = (reason: string): Expect => ({ entitled: true, ready: false, prospectivelyEligible: false, usable: false, reason: reason as never, route: null });

describe("the required examples", () => {
  const cases: Array<[string, EditionState, Record<AiCapability, Expect>]> = [
    ["Free, nothing configured", state(), {
      "ai-setup-recommendations": denied("edition-not-entitled"), "failed-run-explanations": denied("edition-not-entitled"), "managed-ai": denied("edition-not-entitled") }],
    ["Free with a provider configured: provider presence grants nothing", state({ provider: "api-key", license: "valid", cloud: ACTIVE }), {
      "ai-setup-recommendations": denied("edition-not-entitled"), "failed-run-explanations": denied("edition-not-entitled"), "managed-ai": denied("edition-not-entitled") }],
    ["BYOK Pro, valid license, no provider: entitled but not ready", state({ edition: "byok-pro", license: "valid" }), {
      "ai-setup-recommendations": notReady("provider-not-configured"), "failed-run-explanations": notReady("provider-not-configured"), "managed-ai": denied("edition-not-entitled") }],
    ["BYOK Pro, valid license, API key: prospectively eligible, not implemented", state({ edition: "byok-pro", license: "valid", provider: "api-key" }), {
      "ai-setup-recommendations": eligible("byok-api-key", "not-implemented"), "failed-run-explanations": eligible("byok-api-key", "deferred"), "managed-ai": denied("edition-not-entitled") }],
    ["BYOK Pro, valid license, local endpoint (no API key needed)", state({ edition: "byok-pro", license: "valid", provider: "local-endpoint" }), {
      "ai-setup-recommendations": eligible("byok-local", "not-implemented"), "failed-run-explanations": eligible("byok-local", "deferred"), "managed-ai": denied("edition-not-entitled") }],
    ["BYOK Pro, invalid license, provider configured", state({ edition: "byok-pro", license: "invalid", provider: "api-key" }), {
      "ai-setup-recommendations": denied("license-invalid", true), "failed-run-explanations": denied("license-invalid", true), "managed-ai": denied("edition-not-entitled") }],
    ["BYOK Pro, license not verifiable: no entitlement under the current policy", state({ edition: "byok-pro", license: "not-verifiable", provider: "local-endpoint" }), {
      "ai-setup-recommendations": denied("license-not-verifiable", true), "failed-run-explanations": denied("license-not-verifiable", true), "managed-ai": denied("edition-not-entitled") }],
    ["Cloud Pro, signed out", state({ edition: "cloud-pro" }), {
      "ai-setup-recommendations": denied("cloud-signed-out", true), "failed-run-explanations": denied("cloud-signed-out", true), "managed-ai": denied("cloud-signed-out", true) }],
    ["Cloud Pro, signed in, active, online: prospectively eligible, not implemented", state({ edition: "cloud-pro", cloud: ACTIVE }), {
      "ai-setup-recommendations": eligible("cloud-managed", "not-implemented"), "failed-run-explanations": eligible("cloud-managed", "deferred"), "managed-ai": eligible("cloud-managed", "not-implemented") }],
    ["Cloud Pro, expired", state({ edition: "cloud-pro", cloud: { ...ACTIVE, entitlement: "expired" } }), {
      "ai-setup-recommendations": denied("cloud-entitlement-expired", true), "failed-run-explanations": denied("cloud-entitlement-expired", true), "managed-ai": denied("cloud-entitlement-expired", true) }],
    ["Cloud Pro, revoked", state({ edition: "cloud-pro", cloud: { ...ACTIVE, entitlement: "revoked" } }), {
      "ai-setup-recommendations": denied("cloud-entitlement-revoked", true), "failed-run-explanations": denied("cloud-entitlement-revoked", true), "managed-ai": denied("cloud-entitlement-revoked", true) }],
    ["Cloud Pro, active cached entitlement, offline: no live request, no grace", state({ edition: "cloud-pro", cloud: { ...ACTIVE, online: false } }), {
      "ai-setup-recommendations": notReady("cloud-offline"), "failed-run-explanations": notReady("cloud-offline"), "managed-ai": notReady("cloud-offline") }],
  ];

  it.each(cases)("%s", (_name, input, expected) => {
    const report = evaluateCapabilities(input, NOW);
    expect(report.inputValid).toBe(true);
    expect(report.edition).toBe(input.edition);
    expect([...report.localCapabilities]).toEqual(ALL_LOCAL);
    expect(report.savedSetupLimit).toBe(5);
    expect(Object.fromEntries(AI_CAPABILITIES.map((c) => [c, pick(report.ai[c])]))).toEqual(expected);
  });
});

describe("every combination of supplied state", () => {
  const editions: Edition[] = ["free", "byok-pro", "cloud-pro"];
  const licenses: LicenseState[] = ["none", "valid", "invalid", "not-verifiable"];
  const providers: ProviderReadiness[] = ["none", "api-key", "local-endpoint"];
  const entitlements: CloudEntitlement[] = ["active", "expired", "revoked", "unknown"];
  const clouds: CloudState[] = [];
  for (const signedIn of [false, true])
    for (const entitlement of entitlements)
      for (const online of [false, true])
        for (const lastVerifiedAt of [null, EARLIER, NOW, NOW + 1]) clouds.push({ signedIn, entitlement, online, lastVerifiedAt });
  const all: EditionState[] = [];
  for (const edition of editions) for (const license of licenses) for (const provider of providers) for (const cloud of clouds) all.push({ edition, license, provider, cloud });

  it("covers every edition, license, provider and Cloud state", () => {
    expect(all).toHaveLength(3 * 4 * 3 * 64);
  });

  it("holds every invariant", () => {
    for (const s of all) {
      const r = evaluateCapabilities(s, NOW);
      const label = JSON.stringify(s);
      // Local capabilities and the setup limit never change.
      expect([...r.localCapabilities], label).toEqual(ALL_LOCAL);
      expect(r.savedSetupLimit, label).toBe(MAX_FREE_REPO_PROFILES);
      expect(r.inputValid, label).toBe(true);
      for (const c of AI_CAPABILITIES) {
        const a = r.ai[c];
        // Nothing is implemented: never usable, always a reason.
        expect(a.usable, label).toBe(false);
        expect(a.implemented, label).toBe(false);
        expect(a.reason, label).not.toBeNull();
        expect(a.prospectivelyEligible, label).toBe(a.entitled && a.ready);
        expect(a.route === null, label).toBe(!a.prospectivelyEligible);
        if (s.edition === "free") {
          expect(a.entitled, label).toBe(false);
          expect(a.reason, label).toBe("edition-not-entitled");
        } else if (s.edition === "byok-pro") {
          if (c === "managed-ai") {
            expect(a.entitled, label).toBe(false);
          } else {
            // Entitlement from the license only; readiness from the provider only.
            expect(a.entitled, label).toBe(s.license === "valid");
            expect(a.ready, label).toBe(s.provider !== "none");
          }
        } else {
          const confirmed = s.cloud.signedIn && s.cloud.entitlement === "active" && s.cloud.lastVerifiedAt !== null && s.cloud.lastVerifiedAt <= NOW;
          expect(a.entitled, label).toBe(confirmed);
          expect(a.ready, label).toBe(s.cloud.online);
        }
      }
    }
  });

  it("BYOK results ignore Cloud state, and Cloud results ignore license and provider", () => {
    for (const s of all.filter((x) => x.edition === "byok-pro")) {
      expect(evaluateCapabilities(s, NOW).ai).toEqual(evaluateCapabilities({ ...s, cloud: ACTIVE }, NOW).ai);
    }
    for (const s of all.filter((x) => x.edition === "cloud-pro")) {
      expect(evaluateCapabilities(s, NOW).ai).toEqual(evaluateCapabilities({ ...s, license: "valid", provider: "api-key" }, NOW).ai);
    }
  });
});

describe("edge cases fail closed", () => {
  it("contradictory Cloud state: active with no confirmation, or confirmed in the future", () => {
    expect(evaluateCapabilities(state({ edition: "cloud-pro", cloud: { ...ACTIVE, lastVerifiedAt: null } }), NOW).ai["managed-ai"].entitlementReason).toBe("cloud-state-inconsistent");
    expect(evaluateCapabilities(state({ edition: "cloud-pro", cloud: { ...ACTIVE, lastVerifiedAt: NOW + 1 } }), NOW).ai["managed-ai"].entitlementReason).toBe("cloud-state-inconsistent");
    expect(evaluateCapabilities(state({ edition: "cloud-pro", cloud: { ...ACTIVE, lastVerifiedAt: NOW } }), NOW).ai["managed-ai"].entitled).toBe(true);
    // Signed out wins over a stale "active".
    expect(evaluateCapabilities(state({ edition: "cloud-pro", cloud: { ...ACTIVE, signedIn: false } }), NOW).ai["managed-ai"].entitlementReason).toBe("cloud-signed-out");
    expect(evaluateCapabilities(state({ edition: "cloud-pro", cloud: { ...ACTIVE, entitlement: "unknown" } }), NOW).ai["managed-ai"].entitlementReason).toBe("cloud-entitlement-unknown");
  });

  it("an old confirmation is still only a confirmation: no grace period or expiry is invented", () => {
    const old = evaluateCapabilities(state({ edition: "cloud-pro", cloud: { ...ACTIVE, lastVerifiedAt: 0 } }), NOW).ai["managed-ai"];
    expect([old.entitled, old.prospectivelyEligible, old.usable]).toEqual([true, true, false]);
    const offline = evaluateCapabilities(state({ edition: "cloud-pro", cloud: { ...ACTIVE, online: false, lastVerifiedAt: NOW } }), NOW).ai["managed-ai"];
    expect([offline.ready, offline.prospectivelyEligible, offline.reason]).toEqual([false, false, "cloud-offline"]);
  });

  const malformed: Array<[string, unknown, unknown]> = [
    ["unknown edition", { ...state(), edition: "pro" }, NOW],
    ["edition with different case", { ...state(), edition: "BYOK-PRO" }, NOW],
    ["license with padding", { ...state({ edition: "byok-pro", provider: "api-key" }), license: "valid " }, NOW],
    ["license named like a prototype key", { ...state({ edition: "byok-pro", provider: "api-key" }), license: "__proto__" }, NOW],
    ["license 'constructor'", { ...state({ edition: "byok-pro", provider: "api-key" }), license: "constructor" }, NOW],
    ["provider not a known value", { ...state({ edition: "byok-pro", license: "valid" }), provider: "openai" }, NOW],
    ["signedIn as a string", { ...state({ edition: "cloud-pro" }), cloud: { ...ACTIVE, signedIn: "true" } }, NOW],
    ["entitlement not a known value", { ...state({ edition: "cloud-pro" }), cloud: { ...ACTIVE, entitlement: "lifetime" } }, NOW],
    ["lastVerifiedAt NaN", { ...state({ edition: "cloud-pro" }), cloud: { ...ACTIVE, lastVerifiedAt: Number.NaN } }, NOW],
    ["lastVerifiedAt Infinity", { ...state({ edition: "cloud-pro" }), cloud: { ...ACTIVE, lastVerifiedAt: Number.POSITIVE_INFINITY } }, NOW],
    ["lastVerifiedAt as a string", { ...state({ edition: "cloud-pro" }), cloud: { ...ACTIVE, lastVerifiedAt: String(EARLIER) } }, NOW],
    ["missing Cloud state", { edition: "cloud-pro", license: "none", provider: "none" }, NOW],
    ["missing license", { edition: "byok-pro", provider: "api-key", cloud: ACTIVE }, NOW],
    ["evaluation time NaN", state({ edition: "cloud-pro", cloud: ACTIVE }), Number.NaN],
    ["evaluation time missing", state({ edition: "cloud-pro", cloud: ACTIVE }), undefined],
    ["state null", null, NOW],
    ["state a string", "byok-pro", NOW],
  ];

  it.each(malformed)("%s: local capabilities kept, every AI capability denied as invalid-state", (_name, input, at) => {
    const r = evaluateCapabilities(input as EditionState, at as number);
    expect(r.inputValid).toBe(false);
    expect([...r.localCapabilities]).toEqual(ALL_LOCAL);
    expect(r.savedSetupLimit).toBe(5);
    for (const c of AI_CAPABILITIES) expect(pick(r.ai[c])).toEqual(denied("invalid-state"));
  });

  it("an unrecognised edition is reported as Free; a recognised one is kept even when other input is invalid", () => {
    expect(evaluateCapabilities({ ...state(), edition: "pro" } as never, NOW).edition).toBe("free");
    expect(evaluateCapabilities({ ...state({ edition: "cloud-pro" }), cloud: undefined } as never, NOW).edition).toBe("cloud-pro");
    expect(evaluateCapabilities(null as never, NOW).edition).toBe("free");
  });
});

describe("contract", () => {
  it("nothing is implemented yet, and failed-run explanations are deferred", () => {
    expect(AI_IMPLEMENTED).toEqual({ "ai-setup-recommendations": false, "failed-run-explanations": false, "managed-ai": false });
    expect(Object.isFrozen(AI_IMPLEMENTED)).toBe(true);
    expect(Object.isFrozen(LOCAL_CAPABILITIES)).toBe(true);
  });

  it("the setup limit is the existing constant, 5", () => {
    expect(MAX_FREE_REPO_PROFILES).toBe(5);
    expect(evaluateCapabilities(state({ edition: "cloud-pro", cloud: ACTIVE }), NOW).savedSetupLimit).toBe(MAX_FREE_REPO_PROFILES);
  });

  it("is deterministic, doesn't read the clock and doesn't change its input", () => {
    const input = deepFreeze(state({ edition: "byok-pro", license: "valid", provider: "local-endpoint" }));
    const before = JSON.stringify(input);
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("the model must not read the clock");
    });
    const a = evaluateCapabilities(input, NOW);
    const b = evaluateCapabilities(input, NOW);
    now.mockRestore();
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(before);
    // Results are fresh objects: changing one doesn't affect the next.
    a.ai["ai-setup-recommendations"].usable = true;
    expect(evaluateCapabilities(input, NOW).ai["ai-setup-recommendations"].usable).toBe(false);
  });

  it("the module has no I/O, Electron, IPC, network, clock, React or process access", () => {
    for (const file of ["capabilities.ts", "types.ts"]) {
      const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../../src/lib/editions", file), "utf-8");
      expect(source, file).not.toMatch(/["']node:|["']electron["']|ipcRenderer|window\.|\bfetch\(|XMLHttpRequest|WebSocket|Date\.now|new Date\(|performance\.|process\.|require\(|child_process|localStorage|from ["']react["']|\beval\(|new Function/);
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      expect(imports.every((i) => i === "./types" || i === "../../types"), file).toBe(true);
    }
  });
});
