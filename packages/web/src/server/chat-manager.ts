import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import { WebRpcProcess } from "./rpc-process.ts";

const WEB_AGENT_DIR_ENV = "PI_WEB_AGENT_DIR";

export interface ChatRecord {
	id: string;
	title: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	sessionFile?: string;
	sessionId?: string;
	autoRetryEnabled?: boolean;
}

export interface ChatSummary extends ChatRecord {
	status: "online" | "offline" | "error";
}

export interface ChatSnapshot {
	chat: ChatSummary;
	state: RpcSessionState;
	messages: unknown[];
}

export interface ChatCapabilities {
	commands: unknown[];
	entries: unknown[];
	forkMessages: unknown[];
	sessionStats: unknown;
	thinkingLevels: string[];
	tree: unknown;
}

export type WebAction =
	| { type: "steer" | "follow_up"; message: string; images: ImageContent[] }
	| { type: "new_session" }
	| { type: "cycle_model" | "cycle_thinking_level" | "abort_retry" | "abort_bash" | "get_last_assistant_text" }
	| { type: "set_thinking_level"; level: string }
	| { type: "set_steering_mode" | "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { type: "set_auto_compaction" | "set_auto_retry"; enabled: boolean }
	| { type: "compact"; customInstructions?: string }
	| { type: "bash"; command: string; excludeFromContext: boolean }
	| { type: "export_html"; outputPath?: string }
	| { type: "switch_session"; sessionPath: string };

export interface ChatActionResult {
	chat: ChatSummary;
	data?: unknown;
	snapshot?: ChatSnapshot;
	state: RpcSessionState;
}

export type ChatStreamEvent =
	| { kind: "event"; event: AgentSessionEvent }
	| { kind: "extension_ui"; request: RpcExtensionUIRequest }
	| { kind: "runtime_error"; message: string };

interface ChatRuntime {
	process: WebRpcProcess;
	status: "online" | "error";
}

interface StoredChats {
	version: 1;
	chats: ChatRecord[];
}

function timestamp(): string {
	return new Date().toISOString();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getStoreDir(): string {
	return process.env[WEB_AGENT_DIR_ENV] ?? join(homedir(), ".pi", "web-agent");
}

function isStateResponse(
	response: RpcResponse,
): response is Extract<RpcResponse, { command: "get_state"; success: true }> {
	return response.success && response.command === "get_state";
}

function isMessagesResponse(
	response: RpcResponse,
): response is Extract<RpcResponse, { command: "get_messages"; success: true }> {
	return response.success && response.command === "get_messages";
}

function isModelsResponse(
	response: RpcResponse,
): response is Extract<RpcResponse, { command: "get_available_models"; success: true }> {
	return response.success && response.command === "get_available_models";
}

function responseData(response: RpcResponse): unknown {
	if (!response.success) {
		throw new Error(response.error);
	}
	return "data" in response ? response.data : undefined;
}

export class ChatManager {
	private readonly defaultCwd: string;
	private readonly records = new Map<string, ChatRecord>();
	private readonly runtimes = new Map<string, ChatRuntime>();
	private readonly starts = new Map<string, Promise<ChatRuntime>>();
	private readonly subscribers = new Map<string, Set<(event: ChatStreamEvent) => void>>();
	private readonly storePath: string;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: { storeDir?: string; defaultCwd?: string } = {}) {
		this.storePath = join(options.storeDir ?? getStoreDir(), "chats.json");
		this.defaultCwd = options.defaultCwd ?? process.cwd();
		this.load();
	}

	list(): ChatSummary[] {
		return [...this.records.values()]
			.map((record) => this.toSummary(record))
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	async create(options: { cwd?: string; title?: string } = {}): Promise<ChatSnapshot> {
		const cwd = this.validateCwd(options.cwd ?? this.defaultCwd);
		const now = timestamp();
		const record: ChatRecord = {
			id: randomUUID(),
			title: options.title?.trim() || "Новый чат",
			cwd,
			createdAt: now,
			updatedAt: now,
			autoRetryEnabled: false,
		};
		this.records.set(record.id, record);
		this.save();
		return await this.open(record.id);
	}

	async open(chatId: string): Promise<ChatSnapshot> {
		const record = this.requireRecord(chatId);
		const runtime = await this.ensureRuntime(record);
		const [state, messages] = await Promise.all([this.getState(runtime), this.getMessages(runtime)]);
		this.updateSession(record, state);
		return {
			chat: this.toSummary(record),
			state,
			messages,
		};
	}

	async prompt(chatId: string, message: string, images: ImageContent[]): Promise<void> {
		const text = message.trim();
		if (!text && images.length === 0) {
			throw new Error("Введите сообщение или прикрепите изображение.");
		}
		const record = this.requireRecord(chatId);
		const runtime = await this.ensureRuntime(record);
		const response = await runtime.process.send({
			type: "prompt",
			message: text,
			images: images.length > 0 ? images : undefined,
		});
		if (!response.success) {
			throw new Error(response.error);
		}
		if (record.title === "Новый чат" && text) {
			record.title = text.replace(/\s+/g, " ").slice(0, 72);
		}
		record.updatedAt = timestamp();
		this.save();
	}

	async abort(chatId: string): Promise<void> {
		const runtime = await this.ensureRuntime(this.requireRecord(chatId));
		const response = await runtime.process.send({ type: "abort" });
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async compact(chatId: string): Promise<void> {
		await this.runAction(chatId, { type: "compact" });
	}

	async rename(chatId: string, title: string): Promise<ChatSummary> {
		const name = title.trim();
		if (!name) {
			throw new Error("Название чата не может быть пустым.");
		}
		const record = this.requireRecord(chatId);
		const runtime = await this.ensureRuntime(record);
		const response = await runtime.process.send({ type: "set_session_name", name });
		if (!response.success) {
			throw new Error(response.error);
		}
		record.title = name;
		record.updatedAt = timestamp();
		this.save();
		return this.toSummary(record);
	}

	async setModel(chatId: string, provider: string, modelId: string): Promise<RpcSessionState> {
		if (!provider || !modelId) {
			throw new Error("Нужно выбрать провайдера и модель.");
		}
		const record = this.requireRecord(chatId);
		const runtime = await this.ensureRuntime(record);
		const response = await runtime.process.send({ type: "set_model", provider, modelId });
		if (!response.success) {
			throw new Error(response.error);
		}
		const state = await this.getState(runtime);
		this.updateSession(record, state);
		return state;
	}

	async getModels(chatId: string): Promise<unknown[]> {
		const runtime = await this.ensureRuntime(this.requireRecord(chatId));
		const response = await runtime.process.send({ type: "get_available_models" });
		if (!isModelsResponse(response)) {
			throw new Error(response.success ? "Pi returned an unexpected model response." : response.error);
		}
		return response.data.models;
	}

	async getCapabilities(chatId: string): Promise<ChatCapabilities> {
		const runtime = await this.ensureRuntime(this.requireRecord(chatId));
		const [commands, entries, forkMessages, sessionStats, thinkingLevels, tree] = await Promise.all([
			runtime.process.send({ type: "get_commands" }),
			runtime.process.send({ type: "get_entries" }),
			runtime.process.send({ type: "get_fork_messages" }),
			runtime.process.send({ type: "get_session_stats" }),
			runtime.process.send({ type: "get_available_thinking_levels" }),
			runtime.process.send({ type: "get_tree" }),
		]);
		const thinkingData = responseData(thinkingLevels);
		return {
			commands: this.responseList(responseData(commands), "commands"),
			entries: this.responseList(responseData(entries), "entries"),
			forkMessages: this.responseList(responseData(forkMessages), "messages"),
			sessionStats: responseData(sessionStats),
			thinkingLevels: this.responseList(thinkingData, "levels").filter(
				(level): level is string => typeof level === "string",
			),
			tree: responseData(tree),
		};
	}

	async runAction(chatId: string, action: WebAction): Promise<ChatActionResult> {
		const record = this.requireRecord(chatId);
		const runtime = await this.ensureRuntime(record);
		const command = await this.toRpcCommand(runtime, action);
		const response = await runtime.process.send(command);
		const data = responseData(response);
		if (action.type === "set_auto_retry") {
			record.autoRetryEnabled = action.enabled;
		}
		const state = await this.getState(runtime);
		this.updateSession(record, state);
		if (action.type === "new_session" || action.type === "switch_session") {
			const messages = await this.getMessages(runtime);
			const chat = this.toSummary(record);
			return { chat, data, snapshot: { chat, state, messages }, state };
		}
		return { chat: this.toSummary(record), data, state };
	}

	async clone(chatId: string): Promise<ChatSnapshot> {
		return await this.createBranch(chatId, { type: "clone" }, "копия");
	}

	async fork(chatId: string, entryId: string): Promise<ChatSnapshot> {
		return await this.createBranch(chatId, { type: "fork", entryId }, "ветка");
	}

	async answerExtensionRequest(chatId: string, response: RpcExtensionUIResponse): Promise<void> {
		const runtime = await this.ensureRuntime(this.requireRecord(chatId));
		runtime.process.handleUiResponse(response);
	}

	async delete(chatId: string): Promise<void> {
		const record = this.requireRecord(chatId);
		const runtime = this.runtimes.get(chatId);
		if (runtime) {
			this.runtimes.delete(chatId);
			await runtime.process.dispose();
		}
		this.records.delete(record.id);
		this.subscribers.delete(record.id);
		this.save();
	}

	subscribe(chatId: string, listener: (event: ChatStreamEvent) => void): () => void {
		this.requireRecord(chatId);
		const listeners = this.subscribers.get(chatId) ?? new Set<(event: ChatStreamEvent) => void>();
		listeners.add(listener);
		this.subscribers.set(chatId, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) {
				this.subscribers.delete(chatId);
			}
		};
	}

	async shutdown(): Promise<void> {
		if (this.saveTimer) this.save();
		for (const [chatId, runtime] of this.runtimes) {
			this.runtimes.delete(chatId);
			await runtime.process.dispose();
		}
	}

	private load(): void {
		if (!existsSync(this.storePath)) {
			return;
		}
		try {
			const stored = JSON.parse(readFileSync(this.storePath, "utf8")) as Partial<StoredChats>;
			if (stored.version !== 1 || !Array.isArray(stored.chats)) {
				throw new Error("Unexpected chat store format");
			}
			for (const record of stored.chats) {
				if (
					typeof record.id === "string" &&
					typeof record.title === "string" &&
					typeof record.cwd === "string" &&
					typeof record.createdAt === "string" &&
					typeof record.updatedAt === "string"
				) {
					this.records.set(record.id, { ...record, autoRetryEnabled: record.autoRetryEnabled === true });
				}
			}
		} catch (error) {
			console.warn(`Could not read Pi Web Agent chat list: ${errorMessage(error)}`);
		}
	}

	private save(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		mkdirSync(dirname(this.storePath), { recursive: true });
		const stored: StoredChats = { version: 1, chats: [...this.records.values()] };
		const temporaryPath = `${this.storePath}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
		renameSync(temporaryPath, this.storePath);
	}

	private scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => this.save(), 250);
		this.saveTimer.unref();
	}

	private requireRecord(chatId: string): ChatRecord {
		const record = this.records.get(chatId);
		if (!record) {
			throw new Error("Чат не найден.");
		}
		return record;
	}

	private validateCwd(input: string): string {
		const cwd = resolve(input);
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
			throw new Error("Рабочая папка должна существовать.");
		}
		return cwd;
	}

	private toSummary(record: ChatRecord): ChatSummary {
		const runtime = this.runtimes.get(record.id);
		return { ...record, status: runtime?.status ?? "offline" };
	}

	private async ensureRuntime(record: ChatRecord): Promise<ChatRuntime> {
		const current = this.runtimes.get(record.id);
		if (current) {
			return current;
		}
		const pending = this.starts.get(record.id);
		if (pending) {
			return await pending;
		}

		const start = this.startRuntime(record);
		this.starts.set(record.id, start);
		try {
			return await start;
		} finally {
			this.starts.delete(record.id);
		}
	}

	private async startRuntime(record: ChatRecord): Promise<ChatRuntime> {
		const process = new WebRpcProcess(record.cwd);
		const runtime: ChatRuntime = { process, status: "online" };
		this.runtimes.set(record.id, runtime);
		process.onEvent((event) => {
			record.updatedAt = timestamp();
			this.scheduleSave();
			this.broadcast(record.id, { kind: "event", event });
		});
		process.setUiRequestHandler((request) => {
			this.broadcast(record.id, { kind: "extension_ui", request });
		});
		process.onExit((error) => {
			if (this.runtimes.get(record.id)?.process !== process) {
				return;
			}
			runtime.status = "error";
			this.runtimes.delete(record.id);
			this.broadcast(record.id, { kind: "runtime_error", message: errorMessage(error) });
		});

		try {
			if (record.sessionFile) {
				const response = await process.send({ type: "switch_session", sessionPath: record.sessionFile });
				if (!response.success || response.command !== "switch_session" || response.data.cancelled) {
					throw new Error(response.success ? "Pi cancelled opening this chat." : response.error);
				}
			}
			if (typeof record.autoRetryEnabled === "boolean") {
				const response = await process.send({ type: "set_auto_retry", enabled: record.autoRetryEnabled });
				responseData(response);
			}
			const state = await this.getState(runtime);
			this.updateSession(record, state);
			return runtime;
		} catch (error) {
			this.runtimes.delete(record.id);
			await process.dispose();
			throw error;
		}
	}

	private async getState(runtime: ChatRuntime): Promise<RpcSessionState> {
		const response = await runtime.process.send({ type: "get_state" });
		if (!isStateResponse(response)) {
			throw new Error(response.success ? "Pi returned an unexpected state response." : response.error);
		}
		return response.data;
	}

	private async getMessages(runtime: ChatRuntime): Promise<unknown[]> {
		const response = await runtime.process.send({ type: "get_messages" });
		if (!isMessagesResponse(response)) {
			throw new Error(response.success ? "Pi returned an unexpected messages response." : response.error);
		}
		return response.data.messages;
	}

	private updateSession(record: ChatRecord, state: RpcSessionState): void {
		record.sessionId = state.sessionId;
		record.sessionFile = state.sessionFile;
		record.updatedAt = timestamp();
		this.save();
	}

	private responseList(data: unknown, key: string): unknown[] {
		if (
			typeof data === "object" &&
			data !== null &&
			!Array.isArray(data) &&
			Array.isArray((data as Record<string, unknown>)[key])
		) {
			return (data as Record<string, unknown>)[key] as unknown[];
		}
		throw new Error(`Pi returned an unexpected ${key} response.`);
	}

	private async toRpcCommand(runtime: ChatRuntime, action: WebAction): Promise<RpcCommand> {
		switch (action.type) {
			case "steer":
			case "follow_up":
				return {
					type: action.type,
					message: action.message,
					images: action.images.length > 0 ? action.images : undefined,
				};
			case "new_session":
				return { type: "new_session" };
			case "cycle_model":
			case "cycle_thinking_level":
			case "abort_retry":
			case "abort_bash":
			case "get_last_assistant_text":
				return { type: action.type };
			case "set_thinking_level": {
				const response = await runtime.process.send({ type: "get_available_thinking_levels" });
				const available = this.responseList(responseData(response), "levels");
				if (!available.includes(action.level)) {
					throw new Error("Этот уровень мышления недоступен выбранной модели.");
				}
				return {
					type: "set_thinking_level",
					level: action.level as Extract<RpcCommand, { type: "set_thinking_level" }>["level"],
				};
			}
			case "set_steering_mode":
				return { type: "set_steering_mode", mode: action.mode };
			case "set_follow_up_mode":
				return { type: "set_follow_up_mode", mode: action.mode };
			case "set_auto_compaction":
				return { type: "set_auto_compaction", enabled: action.enabled };
			case "set_auto_retry":
				return { type: "set_auto_retry", enabled: action.enabled };
			case "compact":
				return { type: "compact", customInstructions: action.customInstructions };
			case "bash":
				return { type: "bash", command: action.command, excludeFromContext: action.excludeFromContext };
			case "export_html":
				return { type: "export_html", outputPath: action.outputPath };
			case "switch_session":
				return { type: "switch_session", sessionPath: action.sessionPath };
		}
	}

	private async createBranch(
		chatId: string,
		command: Extract<RpcCommand, { type: "clone" | "fork" }>,
		label: string,
	): Promise<ChatSnapshot> {
		const source = this.requireRecord(chatId);
		const runtime = await this.ensureRuntime(source);
		const sourceState = await this.getState(runtime);
		if (!sourceState.sessionFile) {
			throw new Error("Pi ещё не сохранил исходную сессию.");
		}
		const response = await runtime.process.send(command);
		const data = responseData(response);
		if (typeof data === "object" && data !== null && "cancelled" in data && data.cancelled === true) {
			throw new Error("Pi отменил создание ветки.");
		}
		const branchState = await this.getState(runtime);
		if (!branchState.sessionFile || branchState.sessionFile === sourceState.sessionFile) {
			throw new Error("Pi не создал новую сессию для ветки.");
		}
		try {
			const restore = await runtime.process.send({ type: "switch_session", sessionPath: sourceState.sessionFile });
			responseData(restore);
		} catch (error) {
			this.runtimes.delete(source.id);
			await runtime.process.dispose();
			throw error;
		}
		this.updateSession(source, await this.getState(runtime));

		const now = timestamp();
		const branch: ChatRecord = {
			id: randomUUID(),
			title: `${source.title} · ${label}`.slice(0, 96),
			cwd: source.cwd,
			createdAt: now,
			updatedAt: now,
			sessionFile: branchState.sessionFile,
			sessionId: branchState.sessionId,
			autoRetryEnabled: source.autoRetryEnabled,
		};
		this.records.set(branch.id, branch);
		this.save();
		return await this.open(branch.id);
	}

	private broadcast(chatId: string, event: ChatStreamEvent): void {
		for (const listener of this.subscribers.get(chatId) ?? []) {
			listener(event);
		}
	}
}
