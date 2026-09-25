// --- Language registry ---

import type { LanguageKey, BuildTool, Phase } from "../types";
import { existsSync } from "node:fs";
import { join } from "node:path";
import goConfig from "./go";
import javaConfig from "./java";
import tsConfig from "./typescript";

// --- Types ---

export interface LanguageConfig {
  key: LanguageKey;
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
  promptTesterPhaseA: (specPath: string, buildTool: string, workspaceRoot?: string) => string;
  promptTesterPhaseARestart: (specPath: string, buildTool: string, workspaceRoot?: string) => string;
  promptTesterCompileRetry: (compileError: string) => string;
  promptNegotiateAutoAdvance: (negotiateResolution: string, workspaceRoot?: string) => string;
  promptWriterPhaseB: (workspaceRoot?: string) => string;
  promptWriterPhaseBContinue: (failureSummary: string, failureCount: number, workspaceRoot?: string) => string;
  promptCleanerPhaseC: (workspaceRoot?: string) => string;
  promptCleanerRetry: (failureSummary: string, failureCount: number, workspaceRoot?: string) => string;
  promptCleanerRestart: (workspaceRoot?: string) => string;
  promptTesterDisputeFix: (workspaceRoot?: string) => string;
}

// --- Registry ---

const registry = new Map<LanguageKey, LanguageConfig>();

function register(key: LanguageKey, config: LanguageConfig): void {
  registry.set(key, config);
}

// Eagerly register all language modules
register("go", goConfig);
register("java", javaConfig);
register("typescript", tsConfig);

// --- Public API ---

export function getLanguageConfig(key: LanguageKey): LanguageConfig {
  if (registry.has(key)) return registry.get(key)!;
  throw new Error(`Language not available: ${key}`);
}

/** Check whether a string is a valid language key (for early CLI validation). */
export function isValidLanguage(key: string): key is LanguageKey {
  return registry.has(key as LanguageKey);
}

export interface DetectedProject {
  language: LanguageKey;
  buildTool?: BuildTool;
}

export function detectProject(cwd: string): DetectedProject | null {
  // Go
  if (existsSync(join(cwd, "go.mod"))) return { language: "go" };

  // Java (Maven)
  if (existsSync(join(cwd, "pom.xml"))) return { language: "java", buildTool: "maven" };

  // Java (Gradle)
  if (existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts"))) {
    return { language: "java", buildTool: "gradle" };
  }

  // TypeScript
  if (existsSync(join(cwd, "tsconfig.json"))) return { language: "typescript" };

  return null;
}
