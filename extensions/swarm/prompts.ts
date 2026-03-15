import type { ManagedAgentState, SuggestionAction } from "./types.js";

export const ANALYZER_SYSTEM_PROMPT = `You are a swarm supervisor analyzing coding agents.
Your job is to diagnose why an agent is thriving or stuck and recommend the next best intervention.
Prefer actionable, low-risk recommendations.
Return strict JSON only.`;

export function buildAnalyzerTask(target: ManagedAgentState, swarmSnapshot: unknown): string {
	return `Analyze this worker agent and recommend interventions.

Return JSON with this shape:
{
  "summary": "short summary",
  "problem": "most important issue",
  "actions": [
    {
      "kind": "switch-model | spawn-side-agent | compact-context | rewrite-prompt | restart-from-summary | split-task | none",
      "rationale": "why",
      "confidence": 0.0,
      "model": "optional model id",
      "prompt": "optional handoff prompt",
      "agentRole": "optional side-agent role"
    }
  ]
}

Rules:
- Prefer at most 3 actions.
- Use kind=none if nothing is wrong.
- If the current model seems underpowered, recommend switch-model.
- If the task needs decomposition or diagnosis, recommend spawn-side-agent.
- If context is large, recommend compact-context or restart-from-summary.
- Be terse.

Target agent snapshot:
${JSON.stringify(target, null, 2)}

Other swarm state:
${JSON.stringify(swarmSnapshot, null, 2)}`;
}

export function buildRestartTask(target: ManagedAgentState, action: SuggestionAction): string {
	const warnings = target.warnings.length
		? target.warnings.map((warning) => `- ${warning.message}`).join("\n")
		: "- none";
	const lastOutput = target.lastOutput?.trim() || "(none)";
	const lastTool = target.lastTool || "(unknown)";
	const customPrompt = action.prompt?.trim() ? `\nExtra supervisor prompt:\n${action.prompt.trim()}\n` : "";

	return `You are taking over a restarted coding task for another agent.

Original task:
${target.task}

Supervisor rationale:
${action.rationale}

Last observed tool:
${lastTool}

Last observed output:
${lastOutput}

Warnings:
${warnings}
${customPrompt}
Instructions:
- Continue the task from the current state.
- Avoid repeating the same failed loop.
- If the prior approach looks wrong, choose a better one and explain briefly.
- Be decisive.`;
}

export function buildSideAgentTask(target: ManagedAgentState, action: SuggestionAction): string {
	const customPrompt = action.prompt?.trim()
		? action.prompt.trim()
		: `Help unblock agent ${target.name}. Diagnose the current failure mode and propose the best next step.`;
	return `${customPrompt}\n\nTarget snapshot:\n${JSON.stringify(
		{
			name: target.name,
			role: target.role,
			status: target.status,
			task: target.task,
			lastTool: target.lastTool,
			lastOutput: target.lastOutput,
			warnings: target.warnings,
			metrics: target.metrics,
		},
		null,
		2,
	)}`;
}
