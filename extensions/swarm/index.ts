import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { openSwarmDashboard } from "./dashboard.js";
import { deriveStatus, evaluateWarnings } from "./heuristics.js";
import { ANALYZER_SYSTEM_PROMPT, buildAnalyzerTask, buildRestartTask, buildSideAgentTask } from "./prompts.js";
import { spawnManagedAgent, type RunnerHandle, type RunnerUpdate } from "./runner.js";
import { applyRolePreset, getRolePreset, listRolePresetNames, loadRolePresets, type SwarmRolePresetMap } from "./roles.js";
import { SwarmStore } from "./state.js";
import type { AgentSuggestion, ManagedAgentState, StartAgentInput, SuggestionAction } from "./types.js";

const REFRESH_MS = 5_000;
const WIDGET_LIMIT = 8;
const SWARM_STATE_ENTRY = "swarm-state";
const SWARM_STATE_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 400;

function truncate(text: string, max = 72): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3)}...`;
}

function extractJsonObject(text: string): string | undefined {
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first === -1 || last === -1 || last <= first) return undefined;
	return text.slice(first, last + 1);
}

function parseSuggestion(text: string): AgentSuggestion | undefined {
	const jsonText = extractJsonObject(text);
	if (!jsonText) return undefined;
	try {
		const parsed = JSON.parse(jsonText) as Partial<AgentSuggestion> & {
			summary?: string;
			problem?: string;
			actions?: AgentSuggestion["actions"];
		};
		return {
			createdAt: Date.now(),
			summary: parsed.summary ?? "No summary",
			problem: parsed.problem ?? "No problem stated",
			actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 3) : [],
			rawText: text,
		};
	} catch {
		return undefined;
	}
}

function parseStartArgs(args: string): Partial<StartAgentInput> {
	if (!args.includes("::")) return { task: args.trim() };
	const [head, ...tail] = args.split("::");
	const task = tail.join("::").trim();
	const label = head?.trim() ?? "";
	const modelSplit = label.split("@");
	const name = modelSplit[0]?.trim();
	const model = modelSplit[1]?.trim();
	return { name, model, task };
}

function parseApplyArgs(args: string): { target?: string; index?: number } {
	const trimmed = args.trim();
	if (!trimmed) return {};
	const parts = trimmed.split(/\s+/);
	const maybeIndex = parts[parts.length - 1];
	if (/^\d+$/.test(maybeIndex ?? "")) {
		return { target: parts.slice(0, -1).join(" ").trim(), index: Number(maybeIndex) };
	}
	return { target: trimmed };
}

function parseRoleStartArgs(args: string): { role?: string; task?: string; model?: string } {
	const parsed = parseStartArgs(args);
	return { role: parsed.name, model: parsed.model, task: parsed.task };
}

function statusGlyph(agent: ManagedAgentState): string {
	switch (agent.status) {
		case "done":
			return "✓";
		case "stuck":
			return "⚠";
		case "error":
		case "aborted":
			return "✗";
		default:
			return "•";
	}
}

export default function swarmExtension(pi: ExtensionAPI) {
	const store = new SwarmStore();
	const controllers = new Map<string, RunnerHandle>();
	const autoAnalyzeTimestamps = new Map<string, number>();
	let rolePresets: SwarmRolePresetMap = loadRolePresets(process.cwd());
	let currentCtx: ExtensionContext | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let persistTimer: ReturnType<typeof setTimeout> | undefined;

	const persistStateNow = () => {
		pi.appendEntry(SWARM_STATE_ENTRY, {
			version: SWARM_STATE_VERSION,
			savedAt: Date.now(),
			agents: store.snapshot(),
		});
	};

	const schedulePersist = () => {
		if (persistTimer) clearTimeout(persistTimer);
		persistTimer = setTimeout(() => {
			persistTimer = undefined;
			persistStateNow();
		}, PERSIST_DEBOUNCE_MS);
	};

	const stopAllLiveAgents = () => {
		for (const handle of controllers.values()) handle.stop();
		controllers.clear();
	};

	const restoreState = (ctx: ExtensionContext) => {
		const latest = ctx.sessionManager
			.getEntries()
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === SWARM_STATE_ENTRY)
			.pop() as { data?: { version?: number; savedAt?: number; agents?: ManagedAgentState[] } } | undefined;

		if (!latest?.data?.agents) {
			store.replace([]);
			refreshUi();
			return;
		}

		const restoredAgents = latest.data.agents.map((agent) => {
			const restored = JSON.parse(JSON.stringify(agent)) as ManagedAgentState;
			restored.history = {
				recentTools: restored.history?.recentTools ?? [],
				recentOutputHashes: restored.history?.recentOutputHashes ?? [],
				recentErrorKeys: restored.history?.recentErrorKeys ?? [],
				recentEvents: restored.history?.recentEvents ?? [],
				recentTranscript: restored.history?.recentTranscript ?? [],
			};
			if (["queued", "starting", "running", "waiting_tool", "waiting_user", "stuck"].includes(restored.status)) {
				restored.status = "aborted";
				restored.endedAt = latest.data?.savedAt ?? Date.now();
				restored.warnings = [
					{
						code: "no-output-timeout",
						severity: "info",
						message: "Restored from session snapshot. Relaunch to continue execution.",
					},
					...(restored.warnings ?? []),
				];
			}
			return restored;
		});

		store.replace(restoredAgents);
		refreshHeuristics();
	};

	const refreshUi = () => {
		if (!currentCtx?.hasUI) return;
		const summary = store.summary();
		if (summary.total === 0) {
			currentCtx.ui.setStatus("swarm", undefined);
			currentCtx.ui.setWidget("swarm", undefined);
			return;
		}

		const theme = currentCtx.ui.theme;
		currentCtx.ui.setStatus(
			"swarm",
			theme.fg(
				"accent",
				`swarm ${summary.total}`,
			) +
				theme.fg("dim", ` · ${summary.running} running · ${summary.stuck} stuck · ${summary.done} done · ${summary.error} error`),
		);

		const lines = store.list().slice(0, WIDGET_LIMIT).map((agent) => {
			const warning = agent.warnings.length ? theme.fg("warning", " ⚠") : "";
			const tool = agent.lastTool ? theme.fg("dim", ` ${agent.lastTool}`) : "";
			return `${theme.fg("accent", statusGlyph(agent))} ${agent.name} ${theme.fg("muted", agent.status)}${warning}${tool}`;
		});
		if (store.list().length > WIDGET_LIMIT) {
			lines.push(theme.fg("dim", `... ${store.list().length - WIDGET_LIMIT} more`));
		}
		currentCtx.ui.setWidget("swarm", lines, { placement: "belowEditor" });
	};

	const applyUpdate = (agentId: string, update: RunnerUpdate) => {
		const agent = store.get(agentId);
		if (!agent) return;

		if (update.eventLabel) store.appendEvent(agentId, update.eventLabel);
		if (update.lastTool) store.appendTool(agentId, update.lastTool);
		if (update.outputHash) store.appendOutputHash(agentId, update.outputHash);
		if (update.errorKey) store.appendErrorKey(agentId, update.errorKey);
		if (update.transcriptLine) store.appendTranscript(agentId, update.transcriptLine);

		if (update.metricsDelta) {
			agent.metrics.turns += update.metricsDelta.turns ?? 0;
			agent.metrics.input += update.metricsDelta.input ?? 0;
			agent.metrics.output += update.metricsDelta.output ?? 0;
			agent.metrics.cacheRead += update.metricsDelta.cacheRead ?? 0;
			agent.metrics.cacheWrite += update.metricsDelta.cacheWrite ?? 0;
			agent.metrics.cost += update.metricsDelta.cost ?? 0;
		}
		if (update.metrics) Object.assign(agent.metrics, update.metrics);

		store.update(agentId, {
			status: update.status ?? agent.status,
			pid: update.pid ?? agent.pid,
			lastEventAt: update.lastEventAt ?? Date.now(),
			lastTool: update.lastTool ?? agent.lastTool,
			lastOutput: update.lastOutput ?? agent.lastOutput,
			model: update.model ?? agent.model,
			stopReason: update.stopReason ?? agent.stopReason,
			errorMessage: update.errorMessage ?? agent.errorMessage,
		});
		schedulePersist();
		refreshUi();
	};

	const refreshHeuristics = () => {
		for (const agent of store.list()) {
			const previousStatus = agent.status;
			const warnings = evaluateWarnings(agent);
			const status = deriveStatus(agent, warnings);
			store.setWarnings(agent.id, warnings);
			store.update(agent.id, { status });
			const updated = store.get(agent.id);
			if (updated) maybeAutoAnalyze(updated, previousStatus);
		}
		schedulePersist();
		refreshUi();
	};

	const stopAgent = (idOrName: string) => {
		const agent = store.resolve(idOrName);
		if (!agent) return false;
		const handle = controllers.get(agent.id);
		if (!handle) return false;
		handle.stop();
		controllers.delete(agent.id);
		store.update(agent.id, { status: "aborted", endedAt: Date.now() });
		schedulePersist();
		refreshUi();
		return true;
	};

	const startAgent = (input: StartAgentInput, presetRole?: string) => {
		const resolvedInput = applyRolePreset(input, rolePresets, presetRole);
		const agent = store.create(resolvedInput, { cwd: currentCtx?.cwd ?? process.cwd() });
		const handle = spawnManagedAgent(agent, {
			onUpdate: (update) => applyUpdate(agent.id, update),
			onExit: (result) => {
				controllers.delete(agent.id);
				const latest = store.get(agent.id);
				if (!latest) return;
				const status = result.aborted ? "aborted" : result.exitCode === 0 ? "done" : "error";
				store.update(agent.id, {
					status,
					endedAt: Date.now(),
					exitCode: result.exitCode,
					stderr: result.stderr,
					lastOutput: result.lastOutput ?? latest.lastOutput,
				});

				if (latest.role === "analyzer" && latest.targetAgentId && result.lastOutput) {
					const suggestion = parseSuggestion(result.lastOutput);
					if (suggestion) store.setSuggestion(latest.targetAgentId, suggestion);
				}

				refreshHeuristics();
			},
		});
		controllers.set(agent.id, handle);
		schedulePersist();
		refreshUi();
		return agent;
	};

	const restartAgent = (idOrName: string) => {
		const existing = store.resolve(idOrName);
		if (!existing) return undefined;
		stopAgent(existing.id);
		return startAgent({
			name: existing.name,
			role: existing.role,
			task: existing.task,
			cwd: existing.cwd,
			model: existing.model,
			tools: existing.tools,
			systemPrompt: existing.systemPrompt,
			startedBy: "command",
			targetAgentId: existing.targetAgentId,
		});
	};

	const analyzeAgent = (idOrName: string, model?: string, startedBy: StartAgentInput["startedBy"] = "command") => {
		const target = store.resolve(idOrName);
		if (!target) return undefined;
		autoAnalyzeTimestamps.set(target.id, Date.now());
		return startAgent({
			name: `${target.name}-analyzer`,
			role: "analyzer",
			task: buildAnalyzerTask(target, store.serializeForAnalysis()),
			cwd: target.cwd,
			model: model ?? target.model,
			systemPrompt: ANALYZER_SYSTEM_PROMPT,
			startedBy,
			targetAgentId: target.id,
		});
	};

	const hasActiveAnalyzerForTarget = (targetId: string) =>
		store
			.list()
			.some(
				(agent) =>
					agent.role === "analyzer" &&
					agent.targetAgentId === targetId &&
					["queued", "starting", "running", "waiting_tool", "waiting_user", "stuck"].includes(agent.status),
			);

	const maybeAutoAnalyze = (agent: ManagedAgentState, previousStatus?: ManagedAgentState["status"]) => {
		if (agent.role === "analyzer") return;
		if (agent.status !== "stuck") return;
		if (previousStatus === "stuck") return;
		if (hasActiveAnalyzerForTarget(agent.id)) return;
		const lastAutoAnalyzeAt = autoAnalyzeTimestamps.get(agent.id) ?? 0;
		if (Date.now() - lastAutoAnalyzeAt < 60_000) return;
		if (agent.suggestion && Date.now() - agent.suggestion.createdAt < 60_000) return;
		analyzeAgent(agent.id, undefined, "auto");
		currentCtx?.ui.notify(`Auto-analyzing stuck agent ${agent.name}`, "info");
	};

	const resolveTarget = (idOrName?: string) => {
		if (idOrName?.trim()) return store.resolve(idOrName.trim());
		return store.list().find((agent) => agent.status === "stuck") ?? store.list()[0];
	};

	const ensureKnownRole = (role: string) => {
		if (!getRolePreset(role, rolePresets)) {
			throw new Error(`Unknown role '${role}'. Available roles: ${listRolePresetNames(rolePresets).join(", ")}`);
		}
	};

	const getSuggestionAction = (target: ManagedAgentState, index?: number): SuggestionAction => {
		const actions = target.suggestion?.actions?.filter((action) => action.kind !== "none") ?? [];
		if (!actions.length) throw new Error(`No actionable suggestion for ${target.name}`);
		const resolvedIndex = index === undefined ? 0 : index;
		const action = actions[resolvedIndex];
		if (!action) throw new Error(`Suggestion index ${resolvedIndex} not found for ${target.name}`);
		return action;
	};

	const applySuggestion = (idOrName?: string, index?: number) => {
		const target = resolveTarget(idOrName);
		if (!target) throw new Error("No agent found to apply a suggestion to");
		const action = getSuggestionAction(target, index);

		switch (action.kind) {
			case "switch-model": {
				if (!action.model) throw new Error(`Suggestion for ${target.name} did not include a model`);
				stopAgent(target.id);
				const restarted = startAgent({
					name: target.name,
					role: target.role,
					task: buildRestartTask(target, action),
					cwd: target.cwd,
					model: action.model,
					tools: target.tools,
					systemPrompt: target.systemPrompt,
					startedBy: "auto",
				});
				return { target, action, result: restarted, message: `Restarted ${target.name} on ${action.model}` };
			}
			case "restart-from-summary":
			case "rewrite-prompt":
			case "compact-context":
			case "split-task": {
				stopAgent(target.id);
				const restarted = startAgent({
					name: target.name,
					role: target.role,
					task: buildRestartTask(target, action),
					cwd: target.cwd,
					model: action.model ?? target.model,
					tools: target.tools,
					systemPrompt: target.systemPrompt,
					startedBy: "auto",
				});
				return { target, action, result: restarted, message: `Restarted ${target.name} with ${action.kind}` };
			}
			case "spawn-side-agent": {
				const helperRole = action.agentRole?.trim() || "helper";
				const helper = startAgent({
					name: `${target.name}-${helperRole}`,
					role: helperRole,
					task: buildSideAgentTask(target, action),
					cwd: target.cwd,
					model: action.model ?? target.model,
					startedBy: "auto",
					targetAgentId: target.id,
				});
				return { target, action, result: helper, message: `Spawned ${helper.name} for ${target.name}` };
			}
			case "none":
			default:
				throw new Error(`Suggestion kind ${action.kind} is not actionable`);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		rolePresets = loadRolePresets(ctx.cwd);
		if (!refreshTimer) refreshTimer = setInterval(refreshHeuristics, REFRESH_MS);
		restoreState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = undefined;
		}
		persistStateNow();
		stopAllLiveAgents();
		currentCtx = ctx;
		rolePresets = loadRolePresets(ctx.cwd);
		restoreState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = undefined;
		}
		persistStateNow();
		stopAllLiveAgents();
		currentCtx = ctx;
		rolePresets = loadRolePresets(ctx.cwd);
		restoreState(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = undefined;
		}
		persistStateNow();
		stopAllLiveAgents();
		currentCtx = ctx;
		rolePresets = loadRolePresets(ctx.cwd);
		restoreState(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = undefined;
		}
		stopAllLiveAgents();
		store.stopAllMarking();
		persistStateNow();
	});

	pi.registerCommand("swarm", {
		description: "Open the multi-agent dashboard",
		handler: async (_args, ctx) => {
			while (true) {
				const action = await openSwarmDashboard(ctx, store);
				if (action.type === "close") return;
				if (action.type === "stop") stopAgent(action.id);
				if (action.type === "restart") restartAgent(action.id);
				if (action.type === "analyze") analyzeAgent(action.id);
				if (action.type === "apply") {
					try {
						const result = applySuggestion(action.id);
						ctx.ui.notify(result.message, "info");
					} catch (error: any) {
						ctx.ui.notify(error?.message ?? "Failed to apply suggestion", "warning");
					}
				}
			}
		},
	});

	pi.registerCommand("swarm-start", {
		description: "Start an agent. Usage: /swarm-start name@model :: task",
		handler: async (args, ctx) => {
			let { name, model, task } = parseStartArgs(args);
			if (!task) {
				task = (await ctx.ui.editor("Agent task", ""))?.trim() ?? "";
			}
			if (!task) return;
			if (!name) {
				name = (await ctx.ui.input("Agent name", "worker"))?.trim() || "worker";
			}
			startAgent({ name, model, task, startedBy: "command" });
			ctx.ui.notify(`Started ${name}`, "info");
		},
	});

	pi.registerCommand("swarm-start-role", {
		description: "Start an agent from a preset role. Usage: /swarm-start-role role@model :: task",
		handler: async (args, ctx) => {
			let { role, model, task } = parseRoleStartArgs(args);
			if (!role) {
				role = (await ctx.ui.input("Preset role", "scout"))?.trim() || "scout";
			}
			if (!task) {
				task = (await ctx.ui.editor("Agent task", ""))?.trim() ?? "";
			}
			if (!task) return;
			ensureKnownRole(role);
			const started = startAgent({ name: role, role, model, task, startedBy: "command" }, role);
			ctx.ui.notify(`Started ${started.name} using role ${role}`, "info");
		},
	});

	pi.registerCommand("swarm-stop", {
		description: "Stop an agent by id or name, or use all",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (target === "all") {
				for (const agent of store.list()) stopAgent(agent.id);
				ctx.ui.notify("Stopped all agents", "info");
				return;
			}
			if (!target) {
				ctx.ui.notify("Usage: /swarm-stop <id|name|all>", "warning");
				return;
			}
			const stopped = stopAgent(target);
			ctx.ui.notify(stopped ? `Stopped ${target}` : `Agent not found: ${target}`, stopped ? "info" : "warning");
		},
	});

	pi.registerCommand("swarm-restart", {
		description: "Restart an agent by id or name",
		handler: async (args, ctx) => {
			const target = resolveTarget(args.trim());
			if (!target) {
				ctx.ui.notify("No agent found to restart", "warning");
				return;
			}
			restartAgent(target.id);
			ctx.ui.notify(`Restarted ${target.name}`, "info");
		},
	});

	pi.registerCommand("swarm-analyze", {
		description: "Run a side analyzer against an agent",
		handler: async (args, ctx) => {
			const target = resolveTarget(args.trim());
			if (!target) {
				ctx.ui.notify("No agent found to analyze", "warning");
				return;
			}
			analyzeAgent(target.id);
			ctx.ui.notify(`Analyzing ${target.name}`, "info");
		},
	});

	pi.registerCommand("swarm-apply", {
		description: "Apply the latest analyzer suggestion. Usage: /swarm-apply <id|name> [index]",
		handler: async (args, ctx) => {
			try {
				const { target, index } = parseApplyArgs(args);
				const result = applySuggestion(target, index);
				ctx.ui.notify(result.message, "info");
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? "Failed to apply suggestion", "warning");
			}
		},
	});

	pi.registerCommand("swarm-roles", {
		description: "List available preset roles",
		handler: async (_args, ctx) => {
			const lines = listRolePresetNames(rolePresets).map((name) => {
				const preset = getRolePreset(name, rolePresets)!;
				return `${name}: ${preset.description}${preset.model ? ` (${preset.model})` : ""}`;
			});
			ctx.ui.notify(lines.join("\n") || "No roles configured", "info");
		},
	});

	pi.registerCommand("swarm-clear", {
		description: "Clear finished agents from the dashboard",
		handler: async (_args, ctx) => {
			store.clearFinished();
			schedulePersist();
			refreshUi();
			ctx.ui.notify("Cleared finished agents", "info");
		},
	});

	pi.registerTool({
		name: "swarm_spawn",
		label: "Swarm Spawn",
		description: "Spawn a managed side agent and track its status in the swarm dashboard.",
		parameters: Type.Object({
			name: Type.String({ description: "Display name for the agent" }),
			task: Type.String({ description: "Task for the agent" }),
			role: Type.Optional(Type.String({ description: "Role label, defaults to name" })),
			model: Type.Optional(Type.String({ description: "Optional model id" })),
			cwd: Type.Optional(Type.String({ description: "Optional working directory" })),
			tools: Type.Optional(Type.Array(Type.String({ description: "Tool name" }))),
			systemPrompt: Type.Optional(Type.String({ description: "Optional system prompt override" })),
		}),
		async execute(_toolCallId, params) {
			const agent = startAgent({
				name: params.name,
				role: params.role,
				task: params.task,
				cwd: params.cwd,
				model: params.model,
				tools: params.tools,
				systemPrompt: params.systemPrompt,
				startedBy: "tool",
			});
			return {
				content: [{ type: "text", text: `Started ${agent.name} (${agent.id})` }],
				details: { id: agent.id, status: agent.status },
			};
		},
	});

	pi.registerTool({
		name: "swarm_spawn_role",
		label: "Swarm Spawn Role",
		description: "Spawn a managed side agent from a preset role.",
		parameters: Type.Object({
			role: Type.String({ description: "Preset role name" }),
			task: Type.String({ description: "Task for the agent" }),
			model: Type.Optional(Type.String({ description: "Optional model override" })),
			cwd: Type.Optional(Type.String({ description: "Optional working directory" })),
			systemPrompt: Type.Optional(Type.String({ description: "Optional additional supervisor instructions" })),
		}),
		async execute(_toolCallId, params) {
			ensureKnownRole(params.role);
			const agent = startAgent(
				{
					name: params.role,
					role: params.role,
					task: params.task,
					cwd: params.cwd,
					model: params.model,
					systemPrompt: params.systemPrompt,
					startedBy: "tool",
				},
				params.role,
			);
			return {
				content: [{ type: "text", text: `Started ${agent.name} (${agent.id}) with role ${params.role}` }],
				details: { id: agent.id, status: agent.status, role: params.role },
			};
		},
	});

	pi.registerTool({
		name: "swarm_list",
		label: "Swarm List",
		description: "List managed agents, their status, warnings, and latest analyses.",
		parameters: Type.Object({
			format: Type.Optional(StringEnum(["json", "text"] as const, { default: "json" })),
		}),
		async execute(_toolCallId, params) {
			const agents = store.list().map((agent) => ({
				id: agent.id,
				name: agent.name,
				role: agent.role,
				status: agent.status,
				model: agent.model,
				lastTool: agent.lastTool,
				lastOutput: agent.lastOutput,
				warnings: agent.warnings,
				suggestion: agent.suggestion,
			}));
			const text =
				params.format === "text"
					? agents
							.map(
								(agent) =>
									`${agent.id} ${agent.name} ${agent.status}${agent.warnings.length ? " ⚠" : ""} ${truncate(agent.lastOutput ?? "", 60)}`,
							)
							.join("\n") || "No managed agents."
					: JSON.stringify(agents, null, 2);
			return { content: [{ type: "text", text }], details: { agents } };
		},
	});

	pi.registerTool({
		name: "swarm_stop",
		label: "Swarm Stop",
		description: "Stop a managed agent by id or name, or stop all agents.",
		parameters: Type.Object({
			target: Type.String({ description: "Agent id, name, or 'all'" }),
		}),
		async execute(_toolCallId, params) {
			if (params.target === "all") {
				for (const agent of store.list()) stopAgent(agent.id);
				return { content: [{ type: "text", text: "Stopped all agents." }], details: {} };
			}
			const stopped = stopAgent(params.target);
			if (!stopped) throw new Error(`Agent not found: ${params.target}`);
			return {
				content: [{ type: "text", text: `Stopped ${params.target}` }],
				details: { stopped },
			};
		},
	});

	pi.registerTool({
		name: "swarm_analyze",
		label: "Swarm Analyze",
		description: "Spawn an analyzer side agent to diagnose a worker and suggest interventions.",
		parameters: Type.Object({
			target: Type.String({ description: "Agent id or name" }),
			model: Type.Optional(Type.String({ description: "Optional analyzer model override" })),
		}),
		async execute(_toolCallId, params) {
			const target = resolveTarget(params.target);
			if (!target) throw new Error(`Agent not found: ${params.target}`);
			const analyzer = analyzeAgent(target.id, params.model);
			return {
				content: [{ type: "text", text: `Started analyzer ${analyzer?.name} for ${target.name}` }],
				details: { found: true, target: target.id, analyzer: analyzer?.id },
			};
		},
	});

	pi.registerTool({
		name: "swarm_apply_suggestion",
		label: "Swarm Apply Suggestion",
		description: "Apply the latest analyzer suggestion for a managed agent. Defaults to the first actionable suggestion.",
		parameters: Type.Object({
			target: Type.String({ description: "Agent id or name" }),
			index: Type.Optional(Type.Number({ description: "Suggestion action index, default 0" })),
		}),
		async execute(_toolCallId, params) {
			const result = applySuggestion(params.target, params.index);
			return {
				content: [{ type: "text", text: result.message }],
				details: {
					target: result.target.id,
					appliedKind: result.action.kind,
					resultAgent: result.result.id,
				},
			};
		},
	});
}
