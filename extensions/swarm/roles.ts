import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { StartAgentInput } from "./types.js";

export interface SwarmRolePreset {
	name: string;
	description: string;
	tools: string[];
	systemPrompt: string;
	model?: string;
}

export type SwarmRolePresetMap = Record<string, SwarmRolePreset>;

type SwarmRoleConfigFile = Record<string, Partial<SwarmRolePreset>>;

const DEFAULT_ROLE_PRESETS: SwarmRolePresetMap = {
	scout: {
		name: "scout",
		description: "Fast read-only reconnaissance across the codebase.",
		tools: ["read", "grep", "find", "ls", "bash"],
		systemPrompt: `You are SCOUT.
Your job is fast reconnaissance.
- Explore broadly, not deeply.
- Find the most relevant files, symbols, commands, and failure points.
- Prefer concise summaries and concrete paths.
- Do not make edits.
- End with a short handoff section: findings, likely hotspots, and recommended next role.`,
	},
	planner: {
		name: "planner",
		description: "Turn findings into an execution plan.",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt: `You are PLANNER.
Your job is to turn messy context into a clear plan.
- Read enough to understand the architecture.
- Produce a concrete numbered plan.
- Call out risks, unknowns, and dependencies.
- Do not make edits.
- Prefer structured output over long prose.`,
	},
	reviewer: {
		name: "reviewer",
		description: "Review changes, spot mistakes, and propose fixes.",
		tools: ["read", "grep", "find", "ls", "bash"],
		systemPrompt: `You are REVIEWER.
Your job is to critique code and plans.
- Look for bugs, missing tests, regressions, edge cases, and over-complexity.
- Prefer specific evidence: file paths, commands, and exact concerns.
- Do not make edits.
- End with a prioritized list of issues and recommended fixes.`,
	},
	debugger: {
		name: "debugger",
		description: "Diagnose failures and isolate root causes.",
		tools: ["read", "grep", "find", "ls", "bash"],
		systemPrompt: `You are DEBUGGER.
Your job is to isolate root causes.
- Focus on errors, logs, tests, and reproduction steps.
- Prefer hypotheses that can be verified quickly.
- Explain the likely cause, confidence, and next diagnostic step.
- Do not make edits unless explicitly restarted as a worker.`,
	},
	worker: {
		name: "worker",
		description: "General implementation agent for making changes.",
		tools: ["read", "bash", "edit", "write"],
		systemPrompt: `You are WORKER.
Your job is to implement changes efficiently and safely.
- Keep scope tight to the assigned task.
- Read before editing.
- Prefer surgical edits.
- Run lightweight verification when possible.
- Summarize what changed and any follow-up needed.`,
	},
};

function normalizePreset(name: string, preset: Partial<SwarmRolePreset>, fallback?: SwarmRolePreset): SwarmRolePreset {
	return {
		name,
		description: preset.description ?? fallback?.description ?? "Custom swarm role.",
		tools: preset.tools ?? fallback?.tools ?? ["read", "bash", "edit", "write"],
		systemPrompt: preset.systemPrompt ?? fallback?.systemPrompt ?? `You are ${name}. Complete the assigned task.`,
		model: preset.model ?? fallback?.model,
	};
}

function readRoleConfig(path: string): SwarmRoleConfigFile {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as SwarmRoleConfigFile;
	} catch (error) {
		console.error(`[swarm] Failed to read role config ${path}: ${error}`);
		return {};
	}
}

export function loadRolePresets(cwd: string): SwarmRolePresetMap {
	const globalPath = join(getAgentDir(), "swarm-roles.json");
	const projectPath = join(cwd, ".pi", "swarm-roles.json");
	const globalRoles = readRoleConfig(globalPath);
	const projectRoles = readRoleConfig(projectPath);

	const merged: SwarmRolePresetMap = { ...DEFAULT_ROLE_PRESETS };
	for (const [name, preset] of Object.entries(globalRoles)) {
		merged[name] = normalizePreset(name, preset, merged[name]);
	}
	for (const [name, preset] of Object.entries(projectRoles)) {
		merged[name] = normalizePreset(name, preset, merged[name]);
	}
	return merged;
}

export function listRolePresetNames(presets: SwarmRolePresetMap): string[] {
	return Object.keys(presets).sort();
}

export function getRolePreset(name: string | undefined, presets: SwarmRolePresetMap): SwarmRolePreset | undefined {
	if (!name) return undefined;
	return presets[name.trim().toLowerCase()];
}

export function applyRolePreset(input: StartAgentInput, presets: SwarmRolePresetMap, roleName?: string): StartAgentInput {
	const preset = getRolePreset(roleName ?? input.role ?? input.name, presets);
	if (!preset) return input;

	const mergedPrompt = input.systemPrompt?.trim()
		? `${preset.systemPrompt}\n\nAdditional supervisor instructions:\n${input.systemPrompt.trim()}`
		: preset.systemPrompt;

	return {
		...input,
		name: input.name || preset.name,
		role: input.role ?? preset.name,
		model: input.model ?? preset.model,
		tools: input.tools ?? preset.tools,
		systemPrompt: mergedPrompt,
	};
}
