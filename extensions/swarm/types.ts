export type AgentStatus =
	| "queued"
	| "starting"
	| "running"
	| "waiting_tool"
	| "waiting_user"
	| "stuck"
	| "done"
	| "error"
	| "aborted";

export type AgentWarningCode =
	| "no-output-timeout"
	| "repeat-tool-loop"
	| "high-context"
	| "repeated-error"
	| "tool-hung";

export type AgentWarningSeverity = "info" | "warning" | "error";

export interface AgentWarning {
	code: AgentWarningCode;
	severity: AgentWarningSeverity;
	message: string;
}

export type SuggestionKind =
	| "switch-model"
	| "spawn-side-agent"
	| "compact-context"
	| "rewrite-prompt"
	| "restart-from-summary"
	| "split-task"
	| "none";

export interface SuggestionAction {
	kind: SuggestionKind;
	rationale: string;
	confidence: number;
	model?: string;
	prompt?: string;
	agentRole?: string;
}

export interface AgentSuggestion {
	createdAt: number;
	summary: string;
	problem: string;
	actions: SuggestionAction[];
	rawText: string;
}

export interface AgentMetrics {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
}

export interface AgentHistory {
	recentTools: string[];
	recentOutputHashes: string[];
	recentErrorKeys: string[];
	recentEvents: string[];
}

export interface ManagedAgentConfig {
	id: string;
	name: string;
	role: string;
	task: string;
	cwd: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	targetAgentId?: string;
	startedBy: "command" | "tool" | "auto";
}

export interface ManagedAgentState extends ManagedAgentConfig {
	status: AgentStatus;
	createdAt: number;
	startedAt: number;
	lastEventAt: number;
	endedAt?: number;
	pid?: number;
	lastTool?: string;
	lastOutput?: string;
	warnings: AgentWarning[];
	suggestion?: AgentSuggestion;
	metrics: AgentMetrics;
	history: AgentHistory;
	exitCode?: number;
	stderr?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface StartAgentInput {
	name: string;
	role?: string;
	task: string;
	cwd?: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	startedBy?: "command" | "tool" | "auto";
	targetAgentId?: string;
}

export interface SwarmSummary {
	total: number;
	running: number;
	stuck: number;
	done: number;
	error: number;
}
