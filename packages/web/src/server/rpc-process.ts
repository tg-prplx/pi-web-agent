import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";

interface PendingRequest {
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
}

const rpcEntryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
const MAX_STDERR_BUFFER_LENGTH = 64 * 1024;
const TERMINATION_GRACE_MS = 3_000;

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export class WebRpcProcess {
	readonly process: ChildProcess;

	private exited = false;
	private nextRequestId = 0;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly exitListeners = new Set<(error?: Error) => void>();
	private uiRequestHandler: ((request: RpcExtensionUIRequest) => void) | undefined;

	constructor(cwd: string) {
		this.process = spawn(process.execPath, [rpcEntryPath], {
			cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (!this.process.stdin || !this.process.stdout) {
			throw new Error("Не удалось открыть поток Pi RPC.");
		}
		this.attachListeners();
	}

	send(command: RpcCommand): Promise<RpcResponse> {
		if (this.exited) {
			throw new Error(`Pi RPC process is not running. Stderr: ${this.stderrBuffer}`);
		}
		const id = command.id ?? `web_${++this.nextRequestId}_${randomUUID()}`;
		return new Promise<RpcResponse>((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			this.process.stdin?.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
				if (!error) return;
				this.pendingRequests.delete(id);
				reject(toError(error));
			});
		});
	}

	handleUiResponse(response: RpcExtensionUIResponse): void {
		if (!this.exited) {
			this.process.stdin?.write(`${JSON.stringify(response)}\n`);
		}
	}

	setUiRequestHandler(handler?: (request: RpcExtensionUIRequest) => void): void {
		this.uiRequestHandler = handler;
	}

	onEvent(listener: (event: AgentSessionEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onExit(listener: (error?: Error) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	async dispose(): Promise<void> {
		this.uiRequestHandler = undefined;
		this.rejectAllPending(new Error("Pi RPC process disposed"));
		if (this.exited) return;
		const exited = new Promise<void>((resolve) => this.process.once("exit", () => resolve()));
		this.process.kill("SIGTERM");
		const forceKill = setTimeout(() => {
			if (!this.exited) this.process.kill("SIGKILL");
		}, TERMINATION_GRACE_MS);
		forceKill.unref();
		try {
			await exited;
		} finally {
			clearTimeout(forceKill);
		}
	}

	private attachListeners(): void {
		this.process.stdout?.setEncoding("utf8");
		this.process.stdout?.on("data", (chunk: string) => {
			this.stdoutBuffer += chunk;
			while (true) {
				const newline = this.stdoutBuffer.indexOf("\n");
				if (newline < 0) break;
				const line = this.stdoutBuffer.slice(0, newline).trim();
				this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
				if (line) this.handleLine(line);
			}
		});
		this.process.stderr?.setEncoding("utf8");
		this.process.stderr?.on("data", (chunk: string) => {
			this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-MAX_STDERR_BUFFER_LENGTH);
		});
		this.process.once("error", (error) =>
			this.handleExit(new Error(`Pi RPC process error: ${error.message}. Stderr: ${this.stderrBuffer}`)),
		);
		this.process.once("exit", (code, signal) =>
			this.handleExit(
				new Error(`Pi RPC process exited (code=${code} signal=${signal}). Stderr: ${this.stderrBuffer}`),
			),
		);
	}

	private handleLine(line: string): void {
		let parsed: { type?: string; id?: string };
		try {
			parsed = JSON.parse(line) as { type?: string; id?: string };
		} catch {
			return;
		}
		if (parsed.type === "response" && parsed.id) {
			const pending = this.pendingRequests.get(parsed.id);
			if (pending) {
				this.pendingRequests.delete(parsed.id);
				pending.resolve(parsed as RpcResponse);
			}
			return;
		}
		if (parsed.type === "extension_ui_request") {
			this.uiRequestHandler?.(parsed as RpcExtensionUIRequest);
			return;
		}
		for (const listener of this.eventListeners) {
			listener(parsed as AgentSessionEvent);
		}
	}

	private handleExit(error: Error): void {
		if (this.exited) return;
		this.exited = true;
		this.rejectAllPending(error);
		for (const listener of this.exitListeners) listener(error);
	}

	private rejectAllPending(error: Error): void {
		for (const [id, pending] of this.pendingRequests) {
			this.pendingRequests.delete(id);
			pending.reject(error);
		}
	}
}
