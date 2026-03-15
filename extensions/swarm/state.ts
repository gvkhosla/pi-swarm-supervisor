import crypto from "node:crypto";
import type {
	AgentSuggestion,
	AgentWarning,
	ManagedAgentConfig,
	ManagedAgentState,
	StartAgentInput,
	SwarmSummary,
} from "./types.js";

const HISTORY_LIMIT = 8;

function pushLimited(values: string[], value: string | undefined, limit = HISTORY_LIMIT) {
	if (!value) return;
	values.push(value);
	if (values.length > limit) values.splice(0, values.length - limit);
}

export class SwarmStore {
	private agents = new Map<string, ManagedAgentState>();

	create(input: StartAgentInput, defaults: { cwd: string }): ManagedAgentState {
		const now = Date.now();
		const id = crypto.randomBytes(4).toString("hex");
		const config: ManagedAgentConfig = {
			id,
			name: input.name,
			role: input.role ?? input.name,
			task: input.task,
			cwd: input.cwd ?? defaults.cwd,
			model: input.model,
			tools: input.tools,
			systemPrompt: input.systemPrompt,
			targetAgentId: input.targetAgentId,
			startedBy: input.startedBy ?? "command",
		};

		const state: ManagedAgentState = {
			...config,
			status: "queued",
			createdAt: now,
			startedAt: now,
			lastEventAt: now,
			warnings: [],
			metrics: {
				turns: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
			},
			history: {
				recentTools: [],
				recentOutputHashes: [],
				recentErrorKeys: [],
				recentEvents: [],
				recentTranscript: [],
			},
		};

		this.agents.set(state.id, state);
		return state;
	}

	list(): ManagedAgentState[] {
		return Array.from(this.agents.values()).sort((a, b) => b.startedAt - a.startedAt);
	}

	get(id: string): ManagedAgentState | undefined {
		return this.agents.get(id);
	}

	resolve(idOrName: string): ManagedAgentState | undefined {
		const direct = this.agents.get(idOrName);
		if (direct) return direct;
		return this.list().find((agent) => agent.name === idOrName || agent.role === idOrName);
	}

	update(id: string, patch: Partial<ManagedAgentState>) {
		const agent = this.agents.get(id);
		if (!agent) return;
		Object.assign(agent, patch);
	}

	appendEvent(id: string, event: string) {
		const agent = this.agents.get(id);
		if (!agent) return;
		pushLimited(agent.history.recentEvents, event);
	}

	appendTranscript(id: string, line: string) {
		const agent = this.agents.get(id);
		if (!agent) return;
		pushLimited(agent.history.recentTranscript, line, 16);
	}

	appendTool(id: string, toolName: string) {
		const agent = this.agents.get(id);
		if (!agent) return;
		agent.lastTool = toolName;
		pushLimited(agent.history.recentTools, toolName);
	}

	appendOutputHash(id: string, hash: string) {
		const agent = this.agents.get(id);
		if (!agent) return;
		pushLimited(agent.history.recentOutputHashes, hash);
	}

	appendErrorKey(id: string, errorKey: string) {
		const agent = this.agents.get(id);
		if (!agent) return;
		pushLimited(agent.history.recentErrorKeys, errorKey);
	}

	setWarnings(id: string, warnings: AgentWarning[]) {
		const agent = this.agents.get(id);
		if (!agent) return;
		agent.warnings = warnings;
	}

	setSuggestion(id: string, suggestion: AgentSuggestion) {
		const agent = this.agents.get(id);
		if (!agent) return;
		agent.suggestion = suggestion;
	}

	replace(states: ManagedAgentState[]) {
		this.agents = new Map(states.map((state) => [state.id, state]));
	}

	snapshot(): ManagedAgentState[] {
		return this.list().map((agent) => JSON.parse(JSON.stringify(agent)) as ManagedAgentState);
	}

	clearFinished() {
		for (const agent of this.list()) {
			if (["done", "error", "aborted"].includes(agent.status)) {
				this.agents.delete(agent.id);
			}
		}
	}

	stopAllMarking(mark: "aborted" | "error" = "aborted") {
		for (const agent of this.list()) {
			if (["done", "error", "aborted"].includes(agent.status)) continue;
			agent.status = mark;
			agent.endedAt = Date.now();
		}
	}

	summary(): SwarmSummary {
		const summary: SwarmSummary = { total: 0, running: 0, stuck: 0, done: 0, error: 0 };
		for (const agent of this.list()) {
			summary.total += 1;
			if (["queued", "starting", "running", "waiting_tool", "waiting_user"].includes(agent.status)) {
				summary.running += 1;
			} else if (agent.status === "stuck") {
				summary.stuck += 1;
			} else if (agent.status === "done") {
				summary.done += 1;
			} else if (["error", "aborted"].includes(agent.status)) {
				summary.error += 1;
			}
		}
		return summary;
	}

	serializeForAnalysis() {
		return this.list().map((agent) => ({
			id: agent.id,
			name: agent.name,
			role: agent.role,
			status: agent.status,
			model: agent.model,
			lastTool: agent.lastTool,
			lastOutput: agent.lastOutput,
			warnings: agent.warnings,
			metrics: agent.metrics,
			suggestion: agent.suggestion,
		}));
	}
}
