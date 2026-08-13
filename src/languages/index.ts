// --- Language registry ---

import type { LanguageKey, BuildTool, Phase } from "../types";

// --- Types ---

export interface LanguageConfig {
  sourceFilePattern: string;
  testFilePattern: string;
  isTestFile: (path: string) => boolean;
  isPhaseAAllowed: (path: string) => boolean;
  prompts: LanguagePrompts;
  refusalMessage: RefusalMessages;
}

interface RefusalMessages {
  phaseA: string;
  negotiate: string;
  phaseC: string;
}

interface LanguagePrompts {
  promptTesterPhaseA: (specPath: string, buildTool: string) => string;
  promptTesterPhaseARestart: (specPath: string, buildTool: string) => string;
  promptTesterCompileRetry: (compileError: string) => string;
  promptNegotiateApproved: () => string;
  promptNegotiateAutoAdvance: () => string;
  promptWriterPhaseB: () => string;
  promptWriterPhaseBContinue: (failureSummary: string, failureCount: number) => string;
  promptCleanerPhaseC: () => string;
  promptCleanerRetry: (failureSummary: string, failureCount: number) => string;
  promptCleanerRestart: () => string;
  promptTesterDisputeFix: () => string;
}

// --- Registry ---

const registry = new Map<LanguageKey, LanguageConfig>();

function register(key: LanguageKey, config: LanguageConfig): void {
  registry.set(key, config);
}

// Lazy-load languages
async function loadLanguage(key: LanguageKey): Promise<LanguageConfig> {
  if (registry.has(key)) return registry.get(key)!;

  let mod: any;
  switch (key) {
    case "go": mod = await import("./go"); break;
    case "java": mod = await import("./java"); break;
    case "typescript": mod = await import("./typescript"); break;
    default: throw new Error(`Unknown language: ${key}`);
  }

  const config = mod.default;
  register(key, config);
  return config;
}

// --- Public API ---

export function getLanguageConfig(key: LanguageKey): LanguageConfig {
  // Try sync first (already loaded)
  if (registry.has(key)) return registry.get(key)!;

  // Fallback: try sync import
  try {
    const go = require("./go");
    register("go", go.default);
  } catch {}
  try {
    const java = require("./java");
    register("java", java.default);
  } catch {}
  try {
    const ts = require("./typescript");
    register("typescript", ts.default);
  } catch {}

  if (!registry.has(key)) {
    throw new Error(`Language not available: ${key}`);
  }
  return registry.get(key)!;
}

export async function ensureLanguage(key: LanguageKey): Promise<LanguageConfig> {
  return loadLanguage(key);
}

export function isKnownLanguage(key: string): key is LanguageKey {
  return ["go", "java", "typescript"].includes(key);
}

export function detectProject(cwd: string): { language: LanguageKey; buildTool?: BuildTool } | null {
  const fs = require("node:fs");
  const path = require("node:path");

  // Go
  if (fs.existsSync(path.join(cwd, "go.mod"))) return { language: "go" as LanguageKey };

  // Java (Maven)
  if (fs.existsSync(path.join(cwd, "pom.xml"))) return { language: "java" as LanguageKey, buildTool: "maven" as BuildTool };

  // Java (Gradle)
  if (fs.existsSync(path.join(cwd, "build.gradle")) || fs.existsSync(path.join(cwd, "build.gradle.kts"))) {
    return { language: "java" as LanguageKey, buildTool: "gradle" as BuildTool };
  }

  // TypeScript
  if (fs.existsSync(path.join(cwd, "tsconfig.json"))) return { language: "typescript" as LanguageKey };

  return null;
}

export interface DetectedProject {
  language: LanguageKey;
  buildTool?: BuildTool;
}
