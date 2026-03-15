import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import crypto from "node:crypto";
import type { AgentMetrics, AgentStatus, ManagedAgentState } from "./types.js";

export interface RunnerUpdate {
	status?: AgentStatus;
	pid?: number;
	lastEventAt?: number;
	lastTool?: string;
	lastOutput?: string;
	outputHash?: string;
	errorKey?: string;
	eventLabel?: string;
	transcriptLine?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	metrics?: Partial<AgentMetrics>;
	metricsDelta?: Partial<AgentMetrics>;
}

export interface RunnerExit {
	exitCode: number;
	stderr: string;
	aborted: boolean;
	lastOutput?: string;
}

export interface RunnerCallbacks {
	onUpdate: (update: RunnerUpdate) => void;
	onExit: (result: RunnerExit) => void;
}

export interface RunnerHandle {
	stop: () => void;
	process: ChildProcessWithoutNullStreams;
}

function hashText(text: string): string {
	return crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function extractAssistantText(message: any): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

export function spawnManagedAgent(agent: ManagedAgentState, callbacks: RunnerCallbacks): RunnerHandle {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	let tempPromptDir: string | null = null;
	let tempPromptPath: string | null = null;
	if (agent.systemPrompt?.trim()) {
		const temp = writePromptToTempFile(agent.name, agent.systemPrompt);
		tempPromptDir = temp.dir;
		tempPromptPath = temp.filePath;
		args.push("--append-system-prompt", tempPromptPath);
	}

	args.push(`Task: ${agent.task}`);

	const proc = spawn("pi", args, {
		cwd: agent.cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});

	callbacks.onUpdate({
		status: "starting",
		pid: proc.pid,
		lastEventAt: Date.now(),
		eventLabel: "spawn",
	});

	let stdoutBuffer = "";
	let stderr = "";
	let aborted = false;
	let cleanedUp = false;
	let latestOutput = "";

	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		if (tempPromptPath) {
			try {
				fs.unlinkSync(tempPromptPath);
			} catch {}
		}
		if (tempPromptDir) {
			try {
				fs.rmdirSync(tempPromptDir);
			} catch {}
		}
	};

	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		const now = Date.now();
		switch (event.type) {
			case "agent_start":
				callbacks.onUpdate({ status: "running", lastEventAt: now, eventLabel: "agent_start" });
				break;
			case "turn_start":
				callbacks.onUpdate({ status: "running", lastEventAt: now, eventLabel: "turn_start" });
				break;
			case "tool_execution_start":
				callbacks.onUpdate({
					status: "waiting_tool",
					lastEventAt: now,
					lastTool: event.toolName,
					eventLabel: `tool:${event.toolName}`,
					transcriptLine: `→ ${event.toolName}`,
				});
				break;
			case "tool_execution_end":
				callbacks.onUpdate({
					status: "running",
					lastEventAt: now,
					eventLabel: `tool_end:${event.toolName}`,
					errorKey: event.isError ? `tool:${event.toolName}` : undefined,
					transcriptLine: event.isError ? `✗ ${event.toolName}` : undefined,
				});
				break;
			case "message_update": {
				const delta = event.assistantMessageEvent?.delta;
				if (typeof delta === "string" && delta.trim()) {
					latestOutput = delta.trim();
					callbacks.onUpdate({ status: "running", lastEventAt: now, lastOutput: latestOutput });
				}
				break;
			}
			case "message_end": {
				const text = extractAssistantText(event.message);
				if (text) {
					latestOutput = text;
					callbacks.onUpdate({
						status: "running",
						lastEventAt: now,
						lastOutput: text,
						outputHash: hashText(text),
						transcriptLine: text.split("\n")[0]?.trim(),
					});
				}
				if (event.message?.role === "assistant") {
					const usage = event.message?.usage;
					callbacks.onUpdate({
						model: event.message?.model,
						stopReason: event.message?.stopReason,
						errorMessage: event.message?.errorMessage,
						metricsDelta: {
							turns: 1,
							input: usage?.input ?? 0,
							output: usage?.output ?? 0,
							cacheRead: usage?.cacheRead ?? 0,
							cacheWrite: usage?.cacheWrite ?? 0,
							cost: usage?.cost?.total ?? 0,
						},
						metrics: {
							contextTokens: usage?.totalTokens ?? 0,
						},
					});
				}
				break;
			}
			case "auto_retry_start":
				callbacks.onUpdate({
					lastEventAt: now,
					eventLabel: `retry:${event.attempt}`,
					errorKey: "auto-retry",
				});
				break;
			case "auto_compaction_start":
				callbacks.onUpdate({ lastEventAt: now, eventLabel: `compact:${event.reason}` });
				break;
		}
	};

	proc.stdout.on("data", (data) => {
		stdoutBuffer += data.toString();
		const lines = stdoutBuffer.split("\n");
		stdoutBuffer = lines.pop() || "";
		for (const line of lines) processLine(line);
	});

	proc.stderr.on("data", (data) => {
		stderr += data.toString();
	});

	proc.on("close", (code) => {
		if (stdoutBuffer.trim()) processLine(stdoutBuffer);
		cleanup();
		callbacks.onExit({
			exitCode: code ?? 0,
			stderr,
			aborted,
			lastOutput: latestOutput || undefined,
		});
	});

	proc.on("error", (error) => {
		stderr += `\n${error.message}`;
	});

	return {
		process: proc,
		stop: () => {
			aborted = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5_000);
		},
	};
}
