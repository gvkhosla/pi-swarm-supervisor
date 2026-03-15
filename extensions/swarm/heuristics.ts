import type { AgentStatus, AgentWarning, ManagedAgentState } from "./types.js";

const SOFT_STUCK_MS = 45_000;
const HARD_STUCK_MS = 120_000;
const HIGH_CONTEXT_TOKENS = 150_000;

function hasRepeatedTail(values: string[], count: number): string | undefined {
	if (values.length < count) return undefined;
	const tail = values.slice(-count);
	if (tail.some((value) => !value || value !== tail[0])) return undefined;
	return tail[0];
}

export function evaluateWarnings(agent: ManagedAgentState, now = Date.now()): AgentWarning[] {
	if (["done", "error", "aborted"].includes(agent.status)) return [];

	const warnings: AgentWarning[] = [];
	const idleMs = now - agent.lastEventAt;

	if (idleMs >= HARD_STUCK_MS) {
		warnings.push({
			code: "no-output-timeout",
			severity: "error",
			message: `No events for ${Math.round(idleMs / 1000)}s.`,
		});
	} else if (idleMs >= SOFT_STUCK_MS) {
		warnings.push({
			code: agent.status === "waiting_tool" ? "tool-hung" : "no-output-timeout",
			severity: "warning",
			message: `Quiet for ${Math.round(idleMs / 1000)}s.`,
		});
	}

	const repeatedTool = hasRepeatedTail(agent.history.recentTools, 3);
	if (repeatedTool) {
		warnings.push({
			code: "repeat-tool-loop",
			severity: "warning",
			message: `Repeated tool loop detected (${repeatedTool}).`,
		});
	}

	const repeatedError = hasRepeatedTail(agent.history.recentErrorKeys, 2);
	if (repeatedError) {
		warnings.push({
			code: "repeated-error",
			severity: "warning",
			message: `Repeated error detected (${repeatedError}).`,
		});
	}

	if (agent.metrics.contextTokens >= HIGH_CONTEXT_TOKENS) {
		warnings.push({
			code: "high-context",
			severity: "warning",
			message: `High context usage (${agent.metrics.contextTokens.toLocaleString()} tokens).`,
		});
	}

	return warnings;
}

export function deriveStatus(agent: ManagedAgentState, warnings: AgentWarning[]): AgentStatus {
	if (["done", "error", "aborted"].includes(agent.status)) return agent.status;
	if (warnings.some((warning) => warning.severity === "error")) return "stuck";
	if (warnings.length >= 2) return "stuck";
	if (agent.status === "stuck" && warnings.length === 0) return "running";
	return agent.status;
}
