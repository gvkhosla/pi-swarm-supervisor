import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { SwarmStore } from "./state.js";
import type { ManagedAgentState } from "./types.js";

export type DashboardAction =
	| { type: "close" }
	| { type: "stop"; id: string }
	| { type: "restart"; id: string }
	| { type: "analyze"; id: string }
	| { type: "apply"; id: string };

function ageSeconds(timestamp?: number): string {
	if (!timestamp) return "-";
	return `${Math.max(0, Math.round((Date.now() - timestamp) / 1000))}s`;
}

function statusLabel(theme: Theme, status: ManagedAgentState["status"]): string {
	switch (status) {
		case "running":
		case "waiting_tool":
		case "starting":
		case "queued":
			return theme.fg("accent", status);
		case "stuck":
			return theme.fg("warning", status);
		case "done":
			return theme.fg("success", status);
		case "error":
		case "aborted":
			return theme.fg("error", status);
		default:
			return status;
	}
}

function renderAgentLine(theme: Theme, agent: ManagedAgentState, selected: boolean, width: number): string {
	const prefix = selected ? theme.fg("accent", "› ") : "  ";
	const warningMark = agent.warnings.length ? theme.fg("warning", " ⚠") : "";
	const model = agent.model ? theme.fg("dim", ` ${agent.model}`) : "";
	const line = `${prefix}${theme.fg("text", agent.name)} ${statusLabel(theme, agent.status)} ${theme.fg("dim", ageSeconds(agent.lastEventAt))}${warningMark}${model}`;
	return truncateToWidth(line, width);
}

function selectedDetailLines(theme: Theme, agent: ManagedAgentState | undefined, width: number): string[] {
	if (!agent) return [theme.fg("dim", "No managed agents.")];

	const lines = [
		truncateToWidth(`${theme.fg("accent", "Agent:")} ${agent.name} (${agent.role})`, width),
		truncateToWidth(`${theme.fg("accent", "Task:")} ${agent.task}`, width),
		truncateToWidth(`${theme.fg("accent", "Last tool:")} ${agent.lastTool ?? "-"}`, width),
		truncateToWidth(
			`${theme.fg("accent", "Usage:")} ${agent.metrics.turns} turns · ${agent.metrics.contextTokens.toLocaleString()} ctx · $${agent.metrics.cost.toFixed(4)}`,
			width,
		),
	];

	if (agent.warnings.length) {
		lines.push("");
		lines.push(truncateToWidth(theme.fg("warning", "Warnings:"), width));
		for (const warning of agent.warnings.slice(0, 3)) {
			lines.push(truncateToWidth(`- ${warning.message}`, width));
		}
	}

	if (agent.suggestion) {
		lines.push("");
		lines.push(truncateToWidth(theme.fg("success", "Latest analysis:"), width));
		lines.push(truncateToWidth(agent.suggestion.summary, width));
		for (const action of agent.suggestion.actions.slice(0, 2)) {
			lines.push(truncateToWidth(`- ${action.kind}: ${action.rationale}`, width));
		}
	}

	lines.push("");
	lines.push(truncateToWidth(theme.fg("accent", "Transcript tail:"), width));
	const transcript = agent.history.recentTranscript.length
		? agent.history.recentTranscript.slice(-8)
		: [agent.lastOutput ?? "(no transcript yet)"];
	for (const line of transcript) {
		lines.push(truncateToWidth(theme.fg("dim", line || "-"), width));
	}

	return lines;
}

export async function openSwarmDashboard(ctx: ExtensionContext, store: SwarmStore): Promise<DashboardAction> {
	return ctx.ui.custom<DashboardAction>((tui, theme, _keybindings, done) => {
		let selectedIndex = 0;

		const getAgents = () => store.list();
		const selectedAgent = () => getAgents()[Math.min(selectedIndex, Math.max(0, getAgents().length - 1))];

		return {
			render(width: number) {
				const agents = getAgents();
				const summary = store.summary();
				const lines: string[] = [];
				lines.push(truncateToWidth(theme.fg("accent", theme.bold("Swarm Dashboard")), width));
				lines.push(
					truncateToWidth(
						theme.fg(
							"dim",
							`${summary.total} total · ${summary.running} running · ${summary.stuck} stuck · ${summary.done} done · ${summary.error} error`,
						),
						width,
					),
				);
				lines.push("");

				for (const [index, agent] of agents.entries()) {
					lines.push(renderAgentLine(theme, agent, index === selectedIndex, width));
				}

				if (agents.length) lines.push("");
				for (const detailLine of selectedDetailLines(theme, selectedAgent(), width)) {
					lines.push(detailLine);
				}

				lines.push("");
				lines.push(
					truncateToWidth(theme.fg("dim", "↑↓ select · a analyze · p apply · r restart · k stop · esc close"), width),
				);
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				const agents = getAgents();
				if (matchesKey(data, Key.up)) {
					selectedIndex = Math.max(0, selectedIndex - 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					selectedIndex = Math.min(Math.max(0, agents.length - 1), selectedIndex + 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.escape) || data === "q") {
					done({ type: "close" });
					return;
				}

				const agent = selectedAgent();
				if (!agent) {
					done({ type: "close" });
					return;
				}
				if (data === "a") {
					done({ type: "analyze", id: agent.id });
					return;
				}
				if (data === "p") {
					done({ type: "apply", id: agent.id });
					return;
				}
				if (data === "r") {
					done({ type: "restart", id: agent.id });
					return;
				}
				if (data === "k") {
					done({ type: "stop", id: agent.id });
				}
			},
		};
	}, { overlay: true });
}
