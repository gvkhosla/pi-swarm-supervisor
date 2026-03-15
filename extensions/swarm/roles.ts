import type { StartAgentInput } from "./types.js";

export interface SwarmRolePreset {
	name: string;
	description: string;
	tools: string[];
	systemPrompt: string;
	model?: string;
}

export const SWARM_ROLE_PRESETS: Record<string, SwarmRolePreset> = {
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

export function listRolePresetNames(): string[] {
	return Object.keys(SWARM_ROLE_PRESETS).sort();
}

export function getRolePreset(name?: string): SwarmRolePreset | undefined {
	if (!name) return undefined;
	return SWARM_ROLE_PRESETS[name.trim().toLowerCase()];
}

export function applyRolePreset(input: StartAgentInput, roleName?: string): StartAgentInput {
	const preset = getRolePreset(roleName ?? input.role ?? input.name);
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
