/// <reference lib="dom" />

import { renderMarkdown } from "./markdown.ts";
import { renderToolCall, renderToolResult, toolFilePath, toolOutputText } from "./tool-presentation.ts";

interface Chat {
	id: string;
	title: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	sessionFile?: string;
	sessionId?: string;
	autoRetryEnabled?: boolean;
	status: "online" | "offline" | "error";
}

interface Model {
	provider: string;
	id: string;
	name?: string;
}

interface SessionState {
	autoCompactionEnabled?: boolean;
	followUpMode?: "all" | "one-at-a-time";
	model?: Model;
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	sessionFile?: string;
	sessionId?: string;
	messageCount?: number;
	pendingMessageCount?: number;
	sessionName?: string;
	steeringMode?: "all" | "one-at-a-time";
}

interface ChatSnapshot {
	chat: Chat;
	state: SessionState;
	messages: unknown[];
}

interface PiContent {
	id?: unknown;
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
	data?: unknown;
	mimeType?: unknown;
	name?: unknown;
	arguments?: unknown;
}

interface PiMessage {
	role: "user" | "assistant" | "toolResult";
	content: string | PiContent[];
	timestamp: number;
	errorMessage?: string;
	isError?: boolean;
	toolCallId?: string;
	toolName?: string;
}

interface Attachment {
	data: string;
	mimeType: string;
	optimized: boolean;
	preview: string;
}

interface StreamPayload {
	kind: "event" | "extension_ui" | "runtime_error";
	event?: {
		args?: unknown;
		delta?: unknown;
		id?: unknown;
		isError?: unknown;
		message?: unknown;
		partialResult?: unknown;
		result?: unknown;
		toolCallId?: unknown;
		toolName?: unknown;
		type?: string;
		willRetry?: unknown;
	};
	request?: {
		id?: unknown;
		method?: unknown;
		title?: unknown;
		message?: unknown;
		options?: unknown;
		placeholder?: unknown;
		prefill?: unknown;
		text?: unknown;
		statusText?: unknown;
		notifyType?: unknown;
		widgetKey?: unknown;
		widgetLines?: unknown;
		widgetPlacement?: unknown;
	};
	message?: unknown;
}

interface PiCommand {
	description?: string;
	name: string;
	source: "extension" | "prompt" | "skill";
}

interface ForkMessage {
	entryId: string;
	text: string;
}

interface SessionStats {
	assistantMessages?: number;
	contextUsage?: { percent?: number };
	cost?: number;
	toolCalls?: number;
	tokens?: { total?: number };
	userMessages?: number;
}

interface SessionTreeNode {
	children?: SessionTreeNode[];
	entry?: { id?: string; type?: string };
	label?: string;
}

interface SessionEntry {
	id: string;
	type?: string;
}

interface ChatCapabilities {
	commands: PiCommand[];
	entries: SessionEntry[];
	forkMessages: ForkMessage[];
	sessionStats?: SessionStats;
	thinkingLevels: string[];
	tree: SessionTreeNode[];
}

interface ActionResult {
	chat?: Chat;
	data?: unknown;
	snapshot?: ChatSnapshot;
	state?: SessionState;
}

interface ExtensionWidget {
	lines: string[];
	placement: "aboveEditor" | "belowEditor";
}

interface ToolActivity {
	args: Record<string, unknown>;
	name: string;
	output?: string;
	state: "active" | "complete" | "error";
}

type DialogState =
	| {
			kind: "confirm";
			confirmLabel: string;
			message: string;
			onCancel?: () => Promise<void>;
			onConfirm: () => Promise<void>;
			title: string;
			tone?: "danger";
	  }
	| {
			kind: "input";
			confirmLabel: string;
			message?: string;
			multiline?: boolean;
			onCancel?: () => Promise<void>;
			onConfirm: (value: string) => Promise<void>;
			placeholder?: string;
			prefill?: string;
			title: string;
			valueLabel?: string;
	  }
	| {
			kind: "select";
			message?: string;
			onCancel?: () => Promise<void>;
			onConfirm: (value: string) => Promise<void>;
			options: string[];
			title: string;
	  }
	| { kind: "commands"; title: string }
	| { kind: "entries"; title: string }
	| { kind: "fork"; title: string }
	| { kind: "tree"; title: string };

const SIDEBAR_FOLD_STORAGE_KEY = "pi-web.sidebar-folded";

const ui = {
	attachments: [] as Attachment[],
	capabilities: undefined as ChatCapabilities | undefined,
	chats: [] as Chat[],
	delivery: "steer" as "steer" | "follow_up",
	dialog: undefined as DialogState | undefined,
	events: undefined as EventSource | undefined,
	activeId: undefined as string | undefined,
	messages: [] as PiMessage[],
	modelMenuOpen: false,
	models: [] as Model[],
	liveMessageKeys: new Set<string>(),
	sidebarFolded: readSidebarFoldPreference(),
	state: undefined as SessionState | undefined,
	streaming: false,
	submitting: false,
	toolActivities: new Map<string, ToolActivity>(),
	widgets: new Map<string, ExtensionWidget>(),
};

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1536;
const MAX_IMAGE_PIXELS = 1_000_000;
const MAX_SOURCE_IMAGE_BYTES = 24 * 1024 * 1024;

const elements = {
	abortButton: document.querySelector<HTMLButtonElement>("#abort-button")!,
	activity: document.querySelector<HTMLElement>("#activity-bar")!,
	attachButton: document.querySelector<HTMLButtonElement>("#attach-button")!,
	attachmentStrip: document.querySelector<HTMLElement>("#attachment-strip")!,
	chatCount: document.querySelector<HTMLElement>("#chat-count")!,
	chatList: document.querySelector<HTMLElement>("#chat-list")!,
	chatPresence: document.querySelector<HTMLElement>("#chat-presence")!,
	chatTitle: document.querySelector<HTMLElement>("#chat-title")!,
	changeWorkspace: document.querySelector<HTMLButtonElement>("#change-workspace")!,
	closeInspector: document.querySelector<HTMLButtonElement>("#close-inspector")!,
	closeSidebar: document.querySelector<HTMLButtonElement>("#close-sidebar")!,
	compactButton: document.querySelector<HTMLButtonElement>("#compact-button")!,
	composer: document.querySelector<HTMLElement>("#composer")!,
	commandButton: document.querySelector<HTMLButtonElement>("#command-button")!,
	cloneButton: document.querySelector<HTMLButtonElement>("#clone-button")!,
	cwdValue: document.querySelector<HTMLButtonElement>("#cwd-value")!,
	deleteChat: document.querySelector<HTMLButtonElement>("#delete-chat")!,
	deliveryButton: document.querySelector<HTMLButtonElement>("#delivery-button")!,
	dialogLayer: document.querySelector<HTMLElement>("#dialog-layer")!,
	dialogPanel: document.querySelector<HTMLElement>("#dialog-panel")!,
	exportButton: document.querySelector<HTMLButtonElement>("#export-button")!,
	followUpMode: document.querySelector<HTMLSelectElement>("#follow-up-mode")!,
	forkButton: document.querySelector<HTMLButtonElement>("#fork-button")!,
	imageInput: document.querySelector<HTMLInputElement>("#image-input")!,
	inspector: document.querySelector<HTMLElement>("#inspector")!,
	inspectorStatus: document.querySelector<HTMLElement>("#inspector-status")!,
	inspectorState: document.querySelector<HTMLElement>("#agent-state")!,
	messageList: document.querySelector<HTMLElement>("#messages")!,
	modelButton: document.querySelector<HTMLButtonElement>("#model-button")!,
	modelMenu: document.querySelector<HTMLElement>("#model-menu")!,
	modelName: document.querySelector<HTMLElement>("#model-name")!,
	newChat: document.querySelector<HTMLButtonElement>("#new-chat")!,
	openSidebar: document.querySelector<HTMLButtonElement>("#open-sidebar")!,
	prompt: document.querySelector<HTMLTextAreaElement>("#prompt")!,
	renameChat: document.querySelector<HTMLButtonElement>("#rename-chat")!,
	scrim: document.querySelector<HTMLElement>("#scrim")!,
	sendButton: document.querySelector<HTMLButtonElement>("#send-button")!,
	sessionValue: document.querySelector<HTMLElement>("#session-value")!,
	sidebar: document.querySelector<HTMLElement>(".sidebar")!,
	sidebarFold: document.querySelector<HTMLButtonElement>("#toggle-sidebar-fold")!,
	shell: document.querySelector<HTMLElement>("#app")!,
	toasts: document.querySelector<HTMLElement>("#toasts")!,
	toggleInspector: document.querySelector<HTMLButtonElement>("#toggle-inspector")!,
	treeButton: document.querySelector<HTMLButtonElement>("#tree-button")!,
	thinkingLevel: document.querySelector<HTMLSelectElement>("#thinking-level")!,
	autoCompact: document.querySelector<HTMLInputElement>("#auto-compact")!,
	autoRetry: document.querySelector<HTMLInputElement>("#auto-retry")!,
	steeringMode: document.querySelector<HTMLSelectElement>("#steering-mode")!,
	version: document.querySelector<HTMLElement>("#version")!,
	widgetsAbove: document.querySelector<HTMLElement>("#widgets-above")!,
	widgetsBelow: document.querySelector<HTMLElement>("#widgets-below")!,
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readSidebarFoldPreference(): boolean {
	try {
		return window.localStorage.getItem(SIDEBAR_FOLD_STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function escapeAttribute(value: string): string {
	return escapeHtml(value).replaceAll("`", "&#096;");
}

function formatTime(value: string): string {
	const time = new Date(value);
	if (Number.isNaN(time.valueOf())) return "";
	const delta = Date.now() - time.valueOf();
	if (delta < 60_000) return "сейчас";
	if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))} мин`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} ч`;
	return time.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function asModel(value: unknown): Model | undefined {
	if (!isObject(value) || typeof value.provider !== "string" || typeof value.id !== "string") return undefined;
	return { provider: value.provider, id: value.id, name: asString(value.name) };
}

function asState(value: unknown): SessionState {
	if (!isObject(value)) return {};
	return {
		autoCompactionEnabled: value.autoCompactionEnabled === true,
		followUpMode:
			value.followUpMode === "all" || value.followUpMode === "one-at-a-time" ? value.followUpMode : undefined,
		model: asModel(value.model),
		thinkingLevel: asString(value.thinkingLevel),
		isCompacting: value.isCompacting === true,
		isStreaming: value.isStreaming === true,
		messageCount: asNumber(value.messageCount),
		pendingMessageCount: asNumber(value.pendingMessageCount),
		sessionName: asString(value.sessionName),
		sessionFile: asString(value.sessionFile),
		sessionId: asString(value.sessionId),
		steeringMode:
			value.steeringMode === "all" || value.steeringMode === "one-at-a-time" ? value.steeringMode : undefined,
	};
}

function asChat(value: unknown): Chat | undefined {
	if (
		!isObject(value) ||
		typeof value.id !== "string" ||
		typeof value.title !== "string" ||
		typeof value.cwd !== "string"
	)
		return undefined;
	const status = value.status === "online" || value.status === "error" ? value.status : "offline";
	return {
		id: value.id,
		title: value.title,
		cwd: value.cwd,
		createdAt: asString(value.createdAt) ?? new Date().toISOString(),
		updatedAt: asString(value.updatedAt) ?? new Date().toISOString(),
		sessionFile: asString(value.sessionFile),
		sessionId: asString(value.sessionId),
		autoRetryEnabled: value.autoRetryEnabled === true,
		status,
	};
}

function asCapabilities(value: unknown): ChatCapabilities | undefined {
	if (
		!isObject(value) ||
		!Array.isArray(value.commands) ||
		!Array.isArray(value.entries) ||
		!Array.isArray(value.forkMessages)
	)
		return undefined;
	const commands = value.commands.flatMap<PiCommand>((entry): PiCommand[] => {
		if (!isObject(entry) || typeof entry.name !== "string") return [];
		const source = entry.source;
		if (source !== "extension" && source !== "prompt" && source !== "skill") return [];
		return [{ name: entry.name, source, description: asString(entry.description) }];
	});
	const forkMessages = value.forkMessages.flatMap((entry) =>
		isObject(entry) && typeof entry.entryId === "string" && typeof entry.text === "string"
			? [{ entryId: entry.entryId, text: entry.text }]
			: [],
	);
	const entries = value.entries.flatMap((entry) =>
		isObject(entry) && typeof entry.id === "string" ? [{ id: entry.id, type: asString(entry.type) }] : [],
	);
	const thinkingLevels = Array.isArray(value.thinkingLevels)
		? value.thinkingLevels.filter((level): level is string => typeof level === "string")
		: [];
	const stats = isObject(value.sessionStats)
		? {
				assistantMessages: asNumber(value.sessionStats.assistantMessages),
				cost: asNumber(value.sessionStats.cost),
				toolCalls: asNumber(value.sessionStats.toolCalls),
				userMessages: asNumber(value.sessionStats.userMessages),
				tokens: isObject(value.sessionStats.tokens)
					? { total: asNumber(value.sessionStats.tokens.total) }
					: undefined,
				contextUsage: isObject(value.sessionStats.contextUsage)
					? { percent: asNumber(value.sessionStats.contextUsage.percent) }
					: undefined,
			}
		: undefined;
	return {
		commands,
		entries,
		forkMessages,
		sessionStats: stats,
		thinkingLevels,
		tree: Array.isArray(value.tree) ? (value.tree as SessionTreeNode[]) : [],
	};
}

function asActionResult(value: unknown): ActionResult | undefined {
	if (!isObject(value)) return undefined;
	const snapshot = asSnapshot(value.snapshot);
	return {
		chat: asChat(value.chat),
		data: value.data,
		snapshot,
		state: asState(value.state),
	};
}

function asMessage(value: unknown): PiMessage | undefined {
	if (!isObject(value)) return undefined;
	const role = value.role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult") return undefined;
	const timestamp = asNumber(value.timestamp) ?? Date.now();
	if (typeof value.content === "string")
		return {
			role,
			content: value.content,
			timestamp,
			errorMessage: asString(value.errorMessage),
			isError: value.isError === true,
			toolCallId: asString(value.toolCallId),
			toolName: asString(value.toolName),
		};
	if (!Array.isArray(value.content)) return undefined;
	const content: PiContent[] = value.content.filter(isObject).map((part) => ({
		id: part.id,
		type: part.type,
		text: part.text,
		thinking: part.thinking,
		data: part.data,
		mimeType: part.mimeType,
		name: part.name,
		arguments: part.arguments,
	}));
	return {
		role,
		content,
		timestamp,
		errorMessage: asString(value.errorMessage),
		isError: value.isError === true,
		toolCallId: asString(value.toolCallId),
		toolName: asString(value.toolName),
	};
}

function asSnapshot(value: unknown): ChatSnapshot | undefined {
	if (!isObject(value)) return undefined;
	const chat = asChat(value.chat);
	if (!chat || !Array.isArray(value.messages)) return undefined;
	return { chat, state: asState(value.state), messages: value.messages };
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
	const response = await fetch(path, {
		...options,
		headers: { "Content-Type": "application/json", ...options.headers },
	});
	const body = (await response.text()).trim();
	let payload: unknown = {};
	if (body) {
		try {
			payload = JSON.parse(body) as unknown;
		} catch {
			throw new Error("Сервер вернул некорректный ответ.");
		}
	}
	if (!response.ok) {
		throw new Error(
			isObject(payload) && typeof payload.error === "string" ? payload.error : `Ошибка сервера (${response.status})`,
		);
	}
	return payload as T;
}

function showToast(message: string, type: "error" | "info" = "info"): void {
	const toast = document.createElement("div");
	toast.className = `toast ${type === "error" ? "error" : ""}`;
	toast.textContent = message;
	elements.toasts.append(toast);
	window.setTimeout(() => toast.remove(), 5_000);
}

function renderChatList(): void {
	elements.chatCount.textContent = ui.chats.length ? String(ui.chats.length) : "";
	if (!ui.chats.length) {
		elements.chatList.innerHTML = "";
		return;
	}
	elements.chatList.innerHTML = ui.chats
		.map(
			(
				chat,
			) => `<button class="chat-entry ${chat.id === ui.activeId ? "active" : ""} ${chat.status === "online" ? "online" : ""}" data-chat-id="${escapeAttribute(chat.id)}">
				<span class="entry-dot"></span><span class="entry-label"><span class="entry-title">${escapeHtml(chat.title)}</span><span class="entry-time">${formatTime(chat.updatedAt)}</span></span>
			</button>`,
		)
		.join("");
}

function renderSidebarFold(): void {
	elements.shell.classList.toggle("sidebar-folded", ui.sidebarFolded);
	elements.sidebarFold.setAttribute("aria-expanded", String(!ui.sidebarFolded));
	elements.sidebarFold.textContent = ui.sidebarFolded ? "›" : "‹";
	const label = ui.sidebarFolded ? "Развернуть список чатов" : "Свернуть список чатов";
	elements.sidebarFold.setAttribute("aria-label", label);
	elements.sidebarFold.title = label;
}

function toggleSidebarFold(): void {
	ui.sidebarFolded = !ui.sidebarFolded;
	renderSidebarFold();
	try {
		window.localStorage.setItem(SIDEBAR_FOLD_STORAGE_KEY, String(ui.sidebarFolded));
	} catch {
		// The UI remains usable when the browser blocks persistent storage.
	}
}

function toolActivityFor(toolCallId: string | undefined): ToolActivity | undefined {
	return toolCallId ? ui.toolActivities.get(toolCallId) : undefined;
}

function contentHtml(content: string | PiContent[], thinkingOpen: boolean): string {
	if (typeof content === "string") return renderMarkdown(content);
	return content
		.map((part) => {
			if (part.type === "text" && typeof part.text === "string") return renderMarkdown(part.text);
			if (part.type === "thinking" && typeof part.thinking === "string")
				return `<details class="thinking-block"${thinkingOpen ? " open" : ""}><summary><span>Reasoning</span><span class="thinking-state">${thinkingOpen ? "Pi мыслит" : "Скрыто"}</span></summary><div class="thinking-content">${escapeHtml(part.thinking)}</div></details>`;
			if (
				part.type === "image" &&
				typeof part.data === "string" &&
				typeof part.mimeType === "string" &&
				part.mimeType.startsWith("image/")
			) {
				return `<img class="message-image" src="data:${escapeAttribute(part.mimeType)};base64,${escapeAttribute(part.data)}" alt="Прикреплённое изображение" />`;
			}
			if (part.type === "toolCall") {
				const toolCallId = asString(part.id);
				const activity = toolActivityFor(toolCallId);
				return renderToolCall(part.name, part.arguments, {
					id: toolCallId,
					output: activity?.output,
					state: activity?.state,
				});
			}
			return "";
		})
		.join("");
}

function messageKey(message: PiMessage): string {
	return `${message.role}-${message.timestamp}`;
}

function toolResultPath(message: PiMessage): string | undefined {
	if (!message.toolCallId) return undefined;
	for (let index = ui.messages.length - 1; index >= 0; index -= 1) {
		const candidate = ui.messages[index];
		if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) continue;
		const call = candidate.content.find(
			(part) => part.type === "toolCall" && asString(part.id) === message.toolCallId,
		);
		if (call) return toolFilePath(call.arguments);
	}
	return undefined;
}

function messageContentHtml(message: PiMessage, streaming: boolean): string {
	const isUser = message.role === "user";
	const content = contentHtml(message.content, ui.liveMessageKeys.has(messageKey(message)));
	const error = message.errorMessage
		? `<div class="message-error"><strong>${message.errorMessage.includes("Loading model") ? "Модель ещё загружается" : "Pi не получил ответ от модели"}</strong><span>${escapeHtml(message.errorMessage)}</span></div>`
		: "";
	return `${content}${error}${streaming && !isUser && !message.errorMessage ? '<span class="stream-cursor"></span>' : ""}`;
}

function messageHtml(message: PiMessage, streaming: boolean): string {
	const key = escapeAttribute(messageKey(message));
	if (message.role === "toolResult") {
		return `<div class="tool-result" data-message-key="${key}">${renderToolResult({ content: message.content, isError: message.isError, path: toolResultPath(message), toolName: message.toolName })}</div>`;
	}
	const isUser = message.role === "user";
	const label = isUser ? "Вы" : "Pi";
	const avatar = isUser ? "U" : "π";
	return `<article class="message ${isUser ? "user" : "assistant"}" data-message-key="${key}">
		<div class="message-avatar">${avatar}</div>
		<div class="message-body"><div class="message-meta"><span class="message-name">${label}</span><time>${new Date(message.timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time></div>
		<div class="message-content">${messageContentHtml(message, streaming)}</div></div>
	</article>`;
}

function shouldStickToBottom(): boolean {
	const { messageList } = elements;
	return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 140;
}

function renderMessages(forceScroll = false): void {
	const shouldScroll = forceScroll || shouldStickToBottom();
	if (!ui.activeId) {
		elements.messageList.innerHTML = `<div class="welcome"><div class="welcome-label">Локальная среда разработки</div><h1>Откройте новый диалог с Pi.</h1><p>Агент получит доступ к текущей рабочей папке, сохранит контекст и сможет анализировать прикреплённые изображения.</p></div>`;
		return;
	}
	if (!ui.messages.length) {
		elements.messageList.innerHTML = `<div class="welcome"><div class="welcome-label">Новая сессия</div><h1>С чем помочь?</h1><p>Опишите задачу, добавьте скриншот или вставьте изображение прямо из буфера обмена.</p></div>`;
		return;
	}
	elements.messageList.innerHTML = ui.messages
		.map((message, index) => messageHtml(message, ui.streaming && index === ui.messages.length - 1))
		.join("");
	if (shouldScroll) elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function createMessageElement(message: PiMessage, streaming: boolean): HTMLElement | undefined {
	const template = document.createElement("template");
	template.innerHTML = messageHtml(message, streaming).trim();
	const element = template.content.firstElementChild;
	return element instanceof HTMLElement ? element : undefined;
}

function updateMessageDom(message: PiMessage, index: number, shouldScroll: boolean): void {
	const key = messageKey(message);
	const streaming = ui.streaming && index === ui.messages.length - 1;
	const existing = elements.messageList.querySelector<HTMLElement>(`[data-message-key="${key}"]`);
	if (!existing) {
		const next = createMessageElement(message, streaming);
		if (!next) return;
		if (elements.messageList.querySelector(".welcome")) {
			renderMessages(shouldScroll);
			return;
		}
		elements.messageList.append(next);
	} else if (message.role === "toolResult") {
		const next = createMessageElement(message, streaming);
		if (next) existing.replaceWith(next);
	} else {
		const content = existing.querySelector<HTMLElement>(".message-content");
		const nextContent = messageContentHtml(message, streaming);
		if (!content) {
			const next = createMessageElement(message, streaming);
			if (next) existing.replaceWith(next);
		} else if (content.innerHTML !== nextContent) {
			content.innerHTML = nextContent;
		}
	}
	if (shouldScroll) elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function refreshStreamingCursor(): void {
	const index = ui.messages.length - 1;
	const message = ui.messages[index];
	if (message) updateMessageDom(message, index, shouldStickToBottom());
}

function renderAttachments(): void {
	elements.attachmentStrip.innerHTML = ui.attachments
		.map(
			(attachment, index) =>
				`<div class="attachment"><img src="${escapeAttribute(attachment.preview)}" alt="Новое вложение" /><button class="remove-attachment" data-attachment-index="${index}" aria-label="Убрать изображение">×</button></div>`,
		)
		.join("");
	renderComposerControls();
}

function renderWidgets(): void {
	const above: string[] = [];
	const below: string[] = [];
	for (const widget of ui.widgets.values()) {
		const markup = `<div class="extension-widget">${widget.lines.map((line) => `<span>${escapeHtml(line)}</span>`).join("")}</div>`;
		if (widget.placement === "aboveEditor") above.push(markup);
		else below.push(markup);
	}
	elements.widgetsAbove.innerHTML = above.join("");
	elements.widgetsBelow.innerHTML = below.join("");
}

function renderThinkingLevels(): void {
	const state = ui.state;
	const levels = ui.capabilities?.thinkingLevels ?? (state?.thinkingLevel ? [state.thinkingLevel] : []);
	elements.thinkingLevel.innerHTML = levels
		.map((level) => `<option value="${escapeAttribute(level)}">${escapeHtml(level)}</option>`)
		.join("");
	if (state?.thinkingLevel) elements.thinkingLevel.value = state.thinkingLevel;
	elements.thinkingLevel.disabled = !ui.activeId || levels.length === 0;
}

function renderContext(): void {
	const active = ui.chats.find((chat) => chat.id === ui.activeId);
	const state = ui.state;
	const stats = ui.capabilities?.sessionStats;
	const runtimeStatus = !active
		? "Ожидает сессию"
		: ui.streaming
			? "Pi отвечает"
			: state?.isCompacting
				? "Сжимает контекст"
				: "Готов к работе";
	elements.chatTitle.textContent = active?.title ?? "Pi Web Agent";
	elements.chatPresence.textContent = runtimeStatus;
	elements.inspectorStatus.textContent = runtimeStatus;
	elements.inspectorStatus.classList.toggle("busy", ui.streaming || state?.isCompacting === true);
	elements.modelName.textContent = state?.model ? (state.model.name ?? state.model.id) : "Выберите модель";
	elements.modelButton.disabled = !ui.activeId;
	elements.commandButton.disabled = !ui.activeId;
	elements.renameChat.disabled = !ui.activeId;
	elements.deleteChat.disabled = !ui.activeId;
	elements.prompt.disabled = !ui.activeId;
	elements.compactButton.disabled = !ui.activeId || ui.streaming;
	elements.cloneButton.disabled = !ui.activeId || ui.streaming;
	elements.forkButton.disabled = !ui.activeId || ui.streaming || !ui.capabilities?.forkMessages.length;
	elements.exportButton.disabled = !ui.activeId;
	elements.treeButton.disabled = !ui.activeId;
	elements.abortButton.disabled = !ui.activeId || !ui.streaming;
	elements.steeringMode.disabled = !ui.activeId;
	elements.followUpMode.disabled = !ui.activeId;
	elements.autoCompact.disabled = !ui.activeId;
	elements.autoRetry.disabled = !ui.activeId;
	elements.steeringMode.value = state?.steeringMode ?? "all";
	elements.followUpMode.value = state?.followUpMode ?? "all";
	elements.autoCompact.checked = state?.autoCompactionEnabled === true;
	elements.autoRetry.checked = active?.autoRetryEnabled === true;
	elements.changeWorkspace.disabled = !active;
	renderThinkingLevels();
	elements.cwdValue.textContent = active?.cwd ?? "—";
	elements.sessionValue.textContent = state?.sessionId ?? "—";
	const cells = [
		["Контекст", stats?.contextUsage?.percent !== undefined ? `${Math.round(stats.contextUsage.percent)}%` : "—"],
		["Сообщений", String(state?.messageCount ?? ui.messages.length)],
		["Очередь", String(state?.pendingMessageCount ?? 0)],
		["Инструменты", String(stats?.toolCalls ?? 0)],
	];
	elements.inspectorState.innerHTML = cells
		.map(
			([label, value]) =>
				`<div class="state-cell"><div class="state-label">${escapeHtml(label)}</div><div class="state-value">${escapeHtml(value)}</div></div>`,
		)
		.join("");
	renderComposerControls();
}

function hasPromptPayload(): boolean {
	return Boolean(elements.prompt.value.trim() || ui.attachments.length);
}

function renderComposerControls(): void {
	const active = Boolean(ui.activeId);
	const hasDraft = hasPromptPayload();
	const canStop = active && ui.streaming && !hasDraft;
	const canSend = active && hasDraft;
	elements.deliveryButton.hidden = !ui.streaming || !hasDraft;
	elements.deliveryButton.disabled = !active || ui.submitting;
	elements.deliveryButton.classList.toggle("follow-up", ui.delivery === "follow_up");
	elements.deliveryButton.title =
		ui.delivery === "steer" ? "Steer: направить текущий ответ" : "Follow-up: добавить после ответа";
	elements.deliveryButton.setAttribute("aria-label", elements.deliveryButton.title);
	elements.sendButton.classList.toggle("is-stop", canStop);
	elements.sendButton.textContent = canStop ? "■" : "↑";
	elements.sendButton.title = canStop ? "Остановить ответ" : "Отправить сообщение";
	elements.sendButton.setAttribute("aria-label", elements.sendButton.title);
	elements.sendButton.disabled = ui.submitting || (!canStop && !canSend);
}

function setActivity(text?: string): void {
	if (!text) {
		elements.activity.hidden = true;
		elements.activity.textContent = "";
		return;
	}
	elements.activity.hidden = false;
	elements.activity.textContent = text;
}

function setPanel(panel: "sidebar" | "inspector", open: boolean): void {
	const target = panel === "sidebar" ? elements.sidebar : elements.inspector;
	target.classList.toggle("open", open);
	elements.scrim.hidden = !(
		elements.sidebar.classList.contains("open") || elements.inspector.classList.contains("open")
	);
	elements.scrim.classList.toggle("visible", !elements.scrim.hidden);
}

async function refreshChats(): Promise<void> {
	const payload = await api<{ chats?: unknown[] }>("/api/chats");
	ui.chats = Array.isArray(payload.chats)
		? payload.chats.map(asChat).filter((chat): chat is Chat => Boolean(chat))
		: [];
	renderChatList();
}

function updateActiveChat(chat: Chat): void {
	const index = ui.chats.findIndex((item) => item.id === chat.id);
	if (index >= 0) ui.chats[index] = chat;
	else ui.chats.unshift(chat);
	renderChatList();
}

async function loadCapabilities(): Promise<void> {
	const chatId = ui.activeId;
	if (!chatId) return;
	try {
		const capabilities = asCapabilities(await api<unknown>(`/api/chats/${encodeURIComponent(chatId)}/capabilities`));
		if (!capabilities || chatId !== ui.activeId) return;
		ui.capabilities = capabilities;
		renderContext();
	} catch (error) {
		showToast(error instanceof Error ? error.message : "Не удалось загрузить возможности Pi.", "error");
	}
}

async function runAction(action: Record<string, unknown>): Promise<ActionResult | undefined> {
	if (!ui.activeId) return undefined;
	const chatId = ui.activeId;
	try {
		const result = asActionResult(
			await api<unknown>(`/api/chats/${encodeURIComponent(chatId)}/actions`, {
				method: "POST",
				body: JSON.stringify(action),
			}),
		);
		if (!result) throw new Error("Сервер вернул некорректный результат Pi.");
		if (result.snapshot) {
			activateSnapshot(result.snapshot);
			return result;
		}
		if (result.chat) updateActiveChat(result.chat);
		if (result.state) ui.state = result.state;
		renderContext();
		return result;
	} catch (error) {
		showToast(error instanceof Error ? error.message : "Не удалось выполнить действие Pi.", "error");
		return undefined;
	}
}

function closeEvents(): void {
	ui.events?.close();
	ui.events = undefined;
}

function replaceMessages(values: unknown[]): void {
	ui.messages = values.map(asMessage).filter((message): message is PiMessage => Boolean(message));
}

function upsertMessage(value: unknown): void {
	const incoming = asMessage(value);
	if (!incoming) return;
	const shouldScroll = shouldStickToBottom();
	const index = ui.messages.findIndex(
		(message) => message.role === incoming.role && message.timestamp === incoming.timestamp,
	);
	if (index >= 0) {
		ui.messages[index] = incoming;
		updateMessageDom(incoming, index, shouldScroll);
		return;
	}
	const previousIndex = ui.messages.length - 1;
	const previous = ui.messages[previousIndex];
	ui.messages.push(incoming);
	if (previous) updateMessageDom(previous, previousIndex, false);
	updateMessageDom(incoming, ui.messages.length - 1, shouldScroll);
}

function refreshToolExecution(toolCallId: string): void {
	const activity = ui.toolActivities.get(toolCallId);
	if (!activity) return;
	for (const card of Array.from(elements.messageList.querySelectorAll<HTMLElement>("[data-tool-call-id]"))) {
		if (card.dataset.toolCallId !== toolCallId) continue;
		const template = document.createElement("template");
		template.innerHTML = renderToolCall(activity.name, activity.args, {
			id: toolCallId,
			output: activity.output,
			state: activity.state,
		}).trim();
		const replacement = template.content.firstElementChild;
		if (replacement instanceof HTMLElement) card.replaceWith(replacement);
	}
}

function updateToolActivity(
	toolCallId: string,
	name: string,
	args: unknown,
	state: ToolActivity["state"],
	output?: string,
): void {
	const previous = ui.toolActivities.get(toolCallId);
	const nextOutput =
		output === undefined
			? previous?.output
			: !previous?.output || output.startsWith(previous.output)
				? output
				: `${previous.output}${output}`;
	ui.toolActivities.set(toolCallId, {
		args: isObject(args) ? args : (previous?.args ?? {}),
		name: name || previous?.name || "tool",
		output: nextOutput,
		state,
	});
	refreshToolExecution(toolCallId);
}

function toolActivityText(name: string, args: unknown): string {
	const path = toolFilePath(args);
	const target = path ? ` · ${path.split(/[\\/]/).pop()}` : "";
	return `Pi использует ${name}${target}`;
}

function applyStreamEvent(payload: StreamPayload): void {
	if (payload.kind === "runtime_error") {
		ui.streaming = false;
		refreshStreamingCursor();
		setActivity();
		renderContext();
		showToast(typeof payload.message === "string" ? payload.message : "Pi завершился с ошибкой.", "error");
		return;
	}
	if (payload.kind === "extension_ui") {
		void handleExtensionUi(payload.request);
		return;
	}
	const event = payload.event;
	if (!event) return;
	switch (event.type) {
		case "agent_start":
			ui.streaming = true;
			refreshStreamingCursor();
			setActivity("Pi обдумывает следующий шаг");
			break;
		case "message_start":
		case "message_update": {
			const message = asMessage(event.message);
			if (message) ui.liveMessageKeys.add(messageKey(message));
			upsertMessage(event.message);
			break;
		}
		case "message_end": {
			const message = asMessage(event.message);
			if (message) ui.liveMessageKeys.delete(messageKey(message));
			upsertMessage(event.message);
			break;
		}
		case "tool_execution_start": {
			const toolCallId = asString(event.toolCallId);
			const toolName = asString(event.toolName) ?? "tool";
			if (toolCallId) updateToolActivity(toolCallId, toolName, event.args, "active");
			setActivity(toolActivityText(toolName, event.args));
			break;
		}
		case "tool_execution_update": {
			const toolCallId = asString(event.toolCallId);
			const toolName = asString(event.toolName) ?? "tool";
			if (toolCallId)
				updateToolActivity(toolCallId, toolName, event.args, "active", toolOutputText(event.partialResult));
			break;
		}
		case "tool_execution_end": {
			const toolCallId = asString(event.toolCallId);
			const toolName = asString(event.toolName) ?? "tool";
			if (toolCallId) {
				updateToolActivity(
					toolCallId,
					toolName,
					event.args,
					event.isError === true ? "error" : "complete",
					toolOutputText(event.result),
				);
			}
			break;
		}
		case "bash_execution_update": {
			const toolCallId = asString(event.id);
			const activity = toolCallId ? ui.toolActivities.get(toolCallId) : undefined;
			if (toolCallId && activity && typeof event.delta === "string") {
				updateToolActivity(toolCallId, activity.name, activity.args, "active", event.delta);
			}
			break;
		}
		case "agent_end":
			if (event.willRetry === true) {
				setActivity("Модель временно недоступна; Pi повторяет запрос");
			} else {
				ui.streaming = false;
				ui.liveMessageKeys.clear();
				refreshStreamingCursor();
				setActivity();
				void reloadActive(false);
			}
			break;
		case "agent_settled":
			ui.streaming = false;
			ui.liveMessageKeys.clear();
			refreshStreamingCursor();
			setActivity();
			void reloadActive(false);
			break;
		case "compaction_start":
			setActivity("Pi сжимает контекст");
			break;
		case "compaction_end":
			setActivity();
			void reloadActive(false);
			break;
	}
	renderContext();
}

function openEvents(chatId: string): void {
	closeEvents();
	const source = new EventSource(`/api/chats/${encodeURIComponent(chatId)}/events`);
	source.addEventListener("pi", (event) => {
		try {
			applyStreamEvent(JSON.parse((event as MessageEvent<string>).data) as StreamPayload);
		} catch {
			showToast("Не удалось обработать событие Pi.", "error");
		}
	});
	source.onerror = () => {
		if (source.readyState === EventSource.CLOSED) showToast("Поток Pi был отключён.", "error");
	};
	ui.events = source;
}

function activateSnapshot(snapshot: ChatSnapshot, forceScroll = true): void {
	if (ui.activeId !== snapshot.chat.id) {
		ui.liveMessageKeys.clear();
		ui.toolActivities.clear();
	}
	ui.activeId = snapshot.chat.id;
	ui.state = snapshot.state;
	ui.streaming = snapshot.state.isStreaming === true;
	ui.capabilities = undefined;
	ui.widgets.clear();
	replaceMessages(snapshot.messages);
	const existing = ui.chats.findIndex((chat) => chat.id === snapshot.chat.id);
	if (existing >= 0) ui.chats[existing] = snapshot.chat;
	else ui.chats.unshift(snapshot.chat);
	renderChatList();
	renderMessages(forceScroll);
	renderWidgets();
	renderContext();
	openEvents(snapshot.chat.id);
	void loadCapabilities();
}

async function reloadActive(forceScroll: boolean): Promise<void> {
	if (!ui.activeId) return;
	const snapshot = asSnapshot(await api<unknown>(`/api/chats/${encodeURIComponent(ui.activeId)}`));
	if (!snapshot || snapshot.chat.id !== ui.activeId) throw new Error("Сервер вернул некорректный чат.");
	ui.state = snapshot.state;
	ui.streaming = snapshot.state.isStreaming === true;
	replaceMessages(snapshot.messages);
	const index = ui.chats.findIndex((chat) => chat.id === snapshot.chat.id);
	if (index >= 0) ui.chats[index] = snapshot.chat;
	renderChatList();
	renderMessages(forceScroll);
	renderContext();
	void loadCapabilities();
}

async function openChat(chatId: string): Promise<void> {
	if (chatId === ui.activeId) return;
	setActivity("Открываю чат…");
	try {
		const snapshot = asSnapshot(await api<unknown>(`/api/chats/${encodeURIComponent(chatId)}`));
		if (!snapshot) throw new Error("Сервер вернул некорректный чат.");
		activateSnapshot(snapshot);
		setActivity();
		setPanel("sidebar", false);
	} catch (error) {
		setActivity();
		showToast(error instanceof Error ? error.message : "Не удалось открыть чат.", "error");
	}
}

async function createChat(cwd?: string): Promise<void> {
	setActivity("Запускаю Pi…");
	try {
		const snapshot = asSnapshot(
			await api<unknown>("/api/chats", {
				method: "POST",
				body: JSON.stringify(cwd ? { cwd } : {}),
			}),
		);
		if (!snapshot) throw new Error("Сервер вернул некорректный чат.");
		activateSnapshot(snapshot);
		setActivity();
		setPanel("sidebar", false);
		elements.prompt.focus();
	} catch (error) {
		setActivity();
		showToast(error instanceof Error ? error.message : "Не удалось создать чат.", "error");
	}
}

function openWorkspaceDialog(mode: "new" | "change" = "new"): void {
	const active = ui.chats.find((chat) => chat.id === ui.activeId);
	const changingWorkspace = mode === "change";
	showDialog({
		kind: "input",
		title: changingWorkspace ? "Сменить рабочую папку" : "Новый чат",
		message: changingWorkspace
			? "Будет создан новый чат с отдельной сессией Pi. Текущий проект и его контекст останутся без изменений."
			: "Укажите папку, в которой Pi будет работать. Для каждого проекта создаётся отдельная сессия.",
		confirmLabel: changingWorkspace ? "Открыть в этой папке" : "Создать чат",
		placeholder: "/путь/к/проекту",
		prefill: active?.cwd ?? "",
		valueLabel: "Абсолютный путь к папке",
		onConfirm: async (value) => {
			const cwd = value.trim();
			if (!cwd) {
				showToast("Укажите рабочую папку.", "error");
				return;
			}
			await createChat(cwd);
		},
	});
}

async function abortActiveResponse(): Promise<void> {
	if (!ui.activeId || !ui.streaming || ui.submitting) return;
	ui.submitting = true;
	renderComposerControls();
	try {
		await api(`/api/chats/${encodeURIComponent(ui.activeId)}/abort`, { method: "POST", body: "{}" });
		setActivity("Останавливаю ответ Pi…");
	} catch (error) {
		showToast(error instanceof Error ? error.message : "Не удалось остановить ответ.", "error");
	} finally {
		ui.submitting = false;
		renderComposerControls();
	}
}

async function sendPrompt(): Promise<void> {
	if (!ui.activeId) return;
	const message = elements.prompt.value;
	if (!message.trim() && !ui.attachments.length) return;
	ui.submitting = true;
	renderComposerControls();
	try {
		const images = ui.attachments.map(({ data, mimeType }) => ({ data, mimeType }));
		if (ui.streaming) {
			const result = await runAction({ type: ui.delivery, message, images });
			if (!result) return;
			showToast(ui.delivery === "steer" ? "Pi направлен на новую задачу." : "Сообщение добавлено после ответа.");
		} else {
			await api(`/api/chats/${encodeURIComponent(ui.activeId)}/messages`, {
				method: "POST",
				body: JSON.stringify({ message, images }),
			});
		}
		elements.prompt.value = "";
		ui.attachments = [];
		renderAttachments();
		autoGrowPrompt();
		if (!ui.streaming) {
			ui.streaming = true;
			setActivity("Pi обдумывает следующий шаг");
		}
		renderContext();
		void refreshChats();
	} catch (error) {
		showToast(error instanceof Error ? error.message : "Не удалось отправить сообщение.", "error");
	} finally {
		ui.submitting = false;
		renderComposerControls();
	}
}

async function handleComposerSubmit(): Promise<void> {
	if (ui.streaming && !hasPromptPayload()) {
		await abortActiveResponse();
		return;
	}
	await sendPrompt();
}

function autoGrowPrompt(): void {
	elements.prompt.style.height = "auto";
	elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 180)}px`;
	renderComposerControls();
}

async function addFiles(files: FileList | File[]): Promise<void> {
	const candidates = Array.from(files).filter((file) => file.type.startsWith("image/"));
	if (!candidates.length) return;
	if (ui.attachments.length + candidates.length > 6) {
		showToast("Можно прикрепить до 6 изображений.", "error");
		return;
	}
	let optimizedCount = 0;
	for (const file of candidates) {
		if (file.size > MAX_SOURCE_IMAGE_BYTES) {
			showToast(`Файл «${file.name}» больше 24 МБ.`, "error");
			continue;
		}
		try {
			const attachment = await prepareAttachment(file);
			ui.attachments.push(attachment);
			if (attachment.optimized) optimizedCount += 1;
		} catch (error) {
			showToast(error instanceof Error ? error.message : `Не удалось обработать «${file.name}».`, "error");
		}
	}
	renderAttachments();
	if (optimizedCount > 0) {
		showToast("Большие изображения уменьшены перед отправкой в модель.");
	}
}

function base64ByteLength(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.floor((data.length * 3) / 4) - padding;
}

function decodeDataUrl(dataUrl: string): { data: string; mimeType: string } {
	const comma = dataUrl.indexOf(",");
	const header = dataUrl.slice(0, comma);
	if (comma < 0 || !header.startsWith("data:image/") || !header.endsWith(";base64")) {
		throw new Error("Браузер вернул неподдерживаемый формат изображения.");
	}
	return { data: dataUrl.slice(comma + 1), mimeType: header.slice(5, -7) };
}

async function prepareAttachment(file: File): Promise<Attachment> {
	const dataUrl = await new Promise<string>((resolveFile, rejectFile) => {
		const reader = new FileReader();
		reader.onload = () =>
			typeof reader.result === "string"
				? resolveFile(reader.result)
				: rejectFile(new Error(`Не удалось прочитать «${file.name}».`));
		reader.onerror = () => rejectFile(new Error(`Не удалось прочитать «${file.name}».`));
		reader.readAsDataURL(file);
	});
	const image = await new Promise<HTMLImageElement>((resolveImage, rejectImage) => {
		const preview = new Image();
		preview.onload = () => resolveImage(preview);
		preview.onerror = () => rejectImage(new Error(`Не удалось декодировать «${file.name}».`));
		preview.src = dataUrl;
	});
	const mustOptimize =
		image.naturalWidth > MAX_IMAGE_DIMENSION ||
		image.naturalHeight > MAX_IMAGE_DIMENSION ||
		image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS ||
		!["image/jpeg", "image/png", "image/webp"].includes(file.type);
	const preview = mustOptimize
		? (() => {
				const scale = Math.min(
					MAX_IMAGE_DIMENSION / image.naturalWidth,
					MAX_IMAGE_DIMENSION / image.naturalHeight,
					Math.sqrt(MAX_IMAGE_PIXELS / (image.naturalWidth * image.naturalHeight)),
					1,
				);
				const canvas = document.createElement("canvas");
				canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
				canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
				const context = canvas.getContext("2d");
				if (!context) throw new Error("Браузер не поддерживает обработку изображений.");
				context.fillStyle = "#ffffff";
				context.fillRect(0, 0, canvas.width, canvas.height);
				context.drawImage(image, 0, 0, canvas.width, canvas.height);
				return canvas.toDataURL("image/jpeg", 0.9);
			})()
		: dataUrl;
	const attachment = decodeDataUrl(preview);
	if (base64ByteLength(attachment.data) > MAX_ATTACHMENT_BYTES) {
		throw new Error(`«${file.name}» слишком большое после обработки.`);
	}
	return { ...attachment, optimized: mustOptimize, preview };
}

async function loadModels(): Promise<void> {
	if (!ui.activeId) return;
	elements.modelMenu.hidden = false;
	ui.modelMenuOpen = true;
	elements.modelMenu.innerHTML = '<div class="model-loading">Загружаю доступные модели…</div>';
	try {
		const payload = await api<{ models?: unknown[] }>(`/api/chats/${encodeURIComponent(ui.activeId)}/model`);
		ui.models = Array.isArray(payload.models)
			? payload.models.map(asModel).filter((model): model is Model => Boolean(model))
			: [];
		if (!ui.models.length) {
			elements.modelMenu.innerHTML = '<div class="model-loading">Pi не нашёл настроенных моделей.</div>';
			return;
		}
		elements.modelMenu.innerHTML = ui.models
			.map(
				(model, index) =>
					`<button class="model-option" data-model-index="${index}">${escapeHtml(model.name ?? model.id)}<small>${escapeHtml(model.provider)} · ${escapeHtml(model.id)}</small></button>`,
			)
			.join("");
	} catch (error) {
		elements.modelMenu.innerHTML = `<div class="model-loading">${escapeHtml(error instanceof Error ? error.message : "Не удалось загрузить модели.")}</div>`;
	}
}

async function selectModel(index: number): Promise<void> {
	const model = ui.models[index];
	if (!ui.activeId || !model) return;
	try {
		const payload = await api<{ state?: unknown }>(`/api/chats/${encodeURIComponent(ui.activeId)}/model`, {
			method: "POST",
			body: JSON.stringify({ provider: model.provider, modelId: model.id }),
		});
		ui.state = asState(payload.state);
		renderContext();
		showToast(`Выбрана модель: ${model.name ?? model.id}`);
	} catch (error) {
		showToast(error instanceof Error ? error.message : "Не удалось выбрать модель.", "error");
	} finally {
		ui.modelMenuOpen = false;
		elements.modelMenu.hidden = true;
	}
}

function dialogTitle(title: string, message?: string): string {
	return `<div class="dialog-header"><span class="dialog-kicker">Pi</span><button class="icon-button" data-dialog-action="cancel" aria-label="Закрыть">×</button></div><h2 id="dialog-title">${escapeHtml(title)}</h2>${message ? `<p class="dialog-message">${escapeHtml(message)}</p>` : ""}`;
}

function treeRows(nodes: SessionTreeNode[], depth = 0): string {
	return nodes
		.map((node) => {
			const label = node.label ?? node.entry?.type ?? "Запись сессии";
			const id = node.entry?.id ? ` · ${node.entry.id.slice(0, 8)}` : "";
			return `<div class="tree-row" style="--tree-depth:${depth}"><span>${escapeHtml(label)}${escapeHtml(id)}</span></div>${treeRows(node.children ?? [], depth + 1)}`;
		})
		.join("");
}

function commandButton(id: string, label: string, description: string, extra = ""): string {
	return `<button class="palette-command" data-command-id="${escapeAttribute(id)}" ${extra}><span>${escapeHtml(label)}</span><small>${escapeHtml(description)}</small></button>`;
}

function renderDialog(): void {
	const dialog = ui.dialog;
	if (!dialog) {
		elements.dialogLayer.hidden = true;
		elements.dialogPanel.innerHTML = "";
		return;
	}
	elements.dialogLayer.hidden = false;
	if (dialog.kind === "confirm") {
		elements.dialogPanel.innerHTML = `${dialogTitle(dialog.title, dialog.message)}<div class="dialog-actions"><button class="secondary-action" data-dialog-action="cancel">Отмена</button><button class="${dialog.tone === "danger" ? "danger-action" : "primary-action"}" data-dialog-action="confirm">${escapeHtml(dialog.confirmLabel)}</button></div>`;
		return;
	}
	if (dialog.kind === "input") {
		const field = dialog.multiline
			? `<textarea class="dialog-input" id="dialog-value" rows="6" placeholder="${escapeAttribute(dialog.placeholder ?? "")}">${escapeHtml(dialog.prefill ?? "")}</textarea>`
			: `<input class="dialog-input" id="dialog-value" value="${escapeAttribute(dialog.prefill ?? "")}" placeholder="${escapeAttribute(dialog.placeholder ?? "")}" />`;
		elements.dialogPanel.innerHTML = `${dialogTitle(dialog.title, dialog.message)}<label class="dialog-field">${escapeHtml(dialog.valueLabel ?? "Значение")}${field}</label><div class="dialog-actions"><button class="secondary-action" data-dialog-action="cancel">Отмена</button><button class="primary-action" data-dialog-action="confirm">${escapeHtml(dialog.confirmLabel)}</button></div>`;
		window.setTimeout(() => document.querySelector<HTMLElement>("#dialog-value")?.focus(), 0);
		return;
	}
	if (dialog.kind === "select") {
		elements.dialogPanel.innerHTML = `${dialogTitle(dialog.title, dialog.message)}<div class="dialog-choice-list">${dialog.options.map((option) => `<button class="dialog-choice" data-dialog-value="${escapeAttribute(option)}">${escapeHtml(option)}</button>`).join("")}</div><div class="dialog-actions"><button class="secondary-action" data-dialog-action="cancel">Отмена</button></div>`;
		return;
	}
	if (dialog.kind === "commands") {
		const builtin = [
			commandButton("new-session", "Новая сессия", "Очистить текущий диалог через Pi RPC"),
			commandButton("workspace", "Рабочая папка", "Открыть отдельный чат в другой папке"),
			commandButton("model", "Выбрать модель", "Переключить провайдера или модель"),
			commandButton("cycle-model", "Следующая модель", "Переключить модель в порядке Pi"),
			commandButton("cycle-thinking", "Следующий уровень мышления", "Переключить thinking level в порядке Pi"),
			commandButton("settings", "Настройки агента", "Мышление, очередь, сжатие и ретраи"),
			commandButton("compact", "Сжать контекст", "Сохранить суть длинной сессии"),
			commandButton("bash", "Выполнить Bash", "Запустить команду в рабочей папке Pi"),
			commandButton("clone", "Клонировать сессию", "Создать самостоятельную копию"),
			commandButton("fork", "Создать ветку", "Начать ветку с выбранного сообщения"),
			commandButton("tree", "Дерево сессии", "Посмотреть историю ветвлений"),
			commandButton("entries", "Записи сессии", "Просмотреть фактическую историю JSONL Pi"),
			commandButton("export", "Экспортировать HTML", "Сохранить диалог в файл"),
			commandButton("open-session", "Открыть сессию Pi", "Переключиться на JSONL-файл сессии"),
			commandButton("copy-last", "Скопировать последний ответ", "Получить текст напрямую из Pi"),
			commandButton("abort-retry", "Остановить повтор", "Отменить текущую попытку после ошибки"),
			commandButton("abort-bash", "Остановить Bash", "Прервать выполняемую команду"),
		].join("");
		const dynamic = (ui.capabilities?.commands ?? [])
			.map((command) =>
				commandButton(`slash:${command.name}`, `/${command.name}`, command.description ?? command.source),
			)
			.join("");
		elements.dialogPanel.innerHTML = `${dialogTitle(dialog.title)}<label class="palette-search"><span>Поиск</span><input id="command-filter" placeholder="Команда или функция" /></label><div class="palette-section"><div class="palette-label">Управление сессией</div><div class="palette-list">${builtin}</div></div>${dynamic ? `<div class="palette-section"><div class="palette-label">Команды Pi и расширений</div><div class="palette-list">${dynamic}</div></div>` : ""}`;
		window.setTimeout(() => document.querySelector<HTMLInputElement>("#command-filter")?.focus(), 0);
		return;
	}
	if (dialog.kind === "entries") {
		const entries = ui.capabilities?.entries ?? [];
		elements.dialogPanel.innerHTML = `${dialogTitle(dialog.title, "Служебные записи текущей сессии Pi.")}<div class="session-tree">${entries.length ? entries.map((entry) => `<div class="tree-row"><span>${escapeHtml(entry.type ?? "entry")} · ${escapeHtml(entry.id.slice(0, 12))}</span></div>`).join("") : '<div class="empty-dialog">Pi пока не вернул записи сессии.</div>'}</div><div class="dialog-actions"><button class="secondary-action" data-dialog-action="cancel">Закрыть</button></div>`;
		return;
	}
	if (dialog.kind === "fork") {
		const options = ui.capabilities?.forkMessages ?? [];
		elements.dialogPanel.innerHTML = `${dialogTitle(dialog.title, "Выберите сообщение, после которого Pi создаст новую ветку.")}<div class="fork-list">${options.length ? options.map((message) => `<button class="fork-option" data-fork-entry="${escapeAttribute(message.entryId)}"><span>${escapeHtml(message.text.slice(0, 180) || "Пустое сообщение")}</span><small>${escapeHtml(message.entryId.slice(0, 8))}</small></button>`).join("") : '<div class="empty-dialog">В этой сессии пока нет сообщения для ветвления.</div>'}</div><div class="dialog-actions"><button class="secondary-action" data-dialog-action="cancel">Закрыть</button></div>`;
		return;
	}
	elements.dialogPanel.innerHTML = `${dialogTitle(dialog.title, "Структура хранится в настоящей сессии Pi.")}<div class="session-tree">${treeRows(ui.capabilities?.tree ?? []) || '<div class="empty-dialog">Pi пока не вернул дерево сессии.</div>'}</div><div class="dialog-actions"><button class="secondary-action" data-dialog-action="cancel">Закрыть</button></div>`;
}

function showDialog(dialog: DialogState): void {
	ui.dialog = dialog;
	renderDialog();
}

function closeDialog(): void {
	ui.dialog = undefined;
	renderDialog();
}

async function cancelDialog(): Promise<void> {
	const dialog = ui.dialog;
	closeDialog();
	if (dialog && "onCancel" in dialog) await dialog.onCancel?.();
}

async function confirmDialog(): Promise<void> {
	const dialog = ui.dialog;
	if (!dialog || (dialog.kind !== "confirm" && dialog.kind !== "input")) return;
	const value = document.querySelector<HTMLInputElement | HTMLTextAreaElement>("#dialog-value")?.value ?? "";
	closeDialog();
	if (dialog.kind === "confirm") await dialog.onConfirm();
	else await dialog.onConfirm(value);
}

async function selectDialogValue(value: string): Promise<void> {
	const dialog = ui.dialog;
	if (!dialog || dialog.kind !== "select") return;
	closeDialog();
	await dialog.onConfirm(value);
}

function responseText(data: unknown, key: string): string | undefined {
	return isObject(data) ? asString(data[key]) : undefined;
}

async function createBranch(entryId?: string): Promise<void> {
	if (!ui.activeId) return;
	try {
		const snapshot = asSnapshot(
			await api<unknown>(`/api/chats/${encodeURIComponent(ui.activeId)}/branch`, {
				method: "POST",
				body: JSON.stringify(entryId ? { entryId } : {}),
			}),
		);
		if (!snapshot) throw new Error("Pi вернул некорректную ветку.");
		activateSnapshot(snapshot);
		showToast(entryId ? "Создана новая ветка Pi." : "Создана копия сессии Pi.");
	} catch (error) {
		showToast(error instanceof Error ? error.message : "Не удалось создать ветку Pi.", "error");
	}
}

async function openCommandPalette(): Promise<void> {
	if (!ui.activeId) return;
	await loadCapabilities();
	showDialog({ kind: "commands", title: "Команды Pi" });
}

async function runPaletteCommand(id: string): Promise<void> {
	if (id.startsWith("slash:")) {
		elements.prompt.value = `/${id.slice("slash:".length)} `;
		autoGrowPrompt();
		closeDialog();
		elements.prompt.focus();
		return;
	}
	switch (id) {
		case "workspace":
			closeDialog();
			openWorkspaceDialog("change");
			return;
		case "new-session":
			showDialog({
				kind: "confirm",
				title: "Новая сессия Pi",
				message: "Текущий чат будет переключён на новую пустую сессию. История останется в файле Pi.",
				confirmLabel: "Создать сессию",
				onConfirm: async () => {
					await runAction({ type: "new_session" });
				},
			});
			return;
		case "model":
			closeDialog();
			await loadModels();
			return;
		case "cycle-model":
		case "cycle-thinking":
			closeDialog();
			await updateAgentSetting({ type: id === "cycle-model" ? "cycle_model" : "cycle_thinking_level" });
			showToast(id === "cycle-model" ? "Pi переключил модель." : "Pi переключил уровень мышления.");
			return;
		case "settings":
			closeDialog();
			setPanel("inspector", true);
			return;
		case "compact":
			showDialog({
				kind: "input",
				title: "Сжать контекст",
				message: "Необязательно: укажите, что важно сохранить в итоговом контексте.",
				confirmLabel: "Сжать",
				placeholder: "Например: сохранить решения по API и TODO",
				multiline: true,
				onConfirm: async (value) => {
					await runAction({ type: "compact", customInstructions: value || undefined });
				},
			});
			return;
		case "bash":
			showDialog({
				kind: "input",
				title: "Bash в рабочей папке Pi",
				message: "Результат будет передан агенту как результат инструмента.",
				confirmLabel: "Выполнить",
				valueLabel: "Команда",
				placeholder: "git status",
				multiline: true,
				onConfirm: async (value) => {
					if (!value.trim()) return;
					await runAction({ type: "bash", command: value, excludeFromContext: false });
				},
			});
			return;
		case "clone":
			showDialog({
				kind: "confirm",
				title: "Клонировать сессию",
				message: "Будет создан отдельный web-чат с копией текущей ветки Pi.",
				confirmLabel: "Клонировать",
				onConfirm: async () => await createBranch(),
			});
			return;
		case "fork":
			await loadCapabilities();
			showDialog({ kind: "fork", title: "Создать ветку Pi" });
			return;
		case "tree":
			await loadCapabilities();
			showDialog({ kind: "tree", title: "Дерево сессии Pi" });
			return;
		case "entries":
			await loadCapabilities();
			showDialog({ kind: "entries", title: "Записи сессии Pi" });
			return;
		case "export": {
			closeDialog();
			const result = await runAction({ type: "export_html" });
			const path = responseText(result?.data, "path");
			showToast(path ? `HTML сохранён: ${path}` : "Pi экспортировал HTML.");
			return;
		}
		case "open-session":
			showDialog({
				kind: "input",
				title: "Открыть сессию Pi",
				message: "Укажите абсолютный путь к JSONL-файлу сессии Pi.",
				confirmLabel: "Открыть",
				placeholder: "/путь/к/session.jsonl",
				valueLabel: "Файл сессии",
				onConfirm: async (value) => {
					if (!value.trim()) return;
					await runAction({ type: "switch_session", sessionPath: value.trim() });
				},
			});
			return;
		case "copy-last": {
			closeDialog();
			const result = await runAction({ type: "get_last_assistant_text" });
			const text = responseText(result?.data, "text");
			if (!text) {
				showToast("В Pi ещё нет ответа для копирования.", "error");
				return;
			}
			try {
				await navigator.clipboard.writeText(text);
				showToast("Последний ответ Pi скопирован.");
			} catch {
				showToast("Браузер не разрешил скопировать ответ.", "error");
			}
			return;
		}
		case "abort-retry":
		case "abort-bash":
			closeDialog();
			await runAction({ type: id === "abort-retry" ? "abort_retry" : "abort_bash" });
			return;
	}
}

async function handleExtensionUi(request: StreamPayload["request"]): Promise<void> {
	if (!ui.activeId || !request || typeof request.id !== "string" || typeof request.method !== "string") return;
	const reply = async (response: Record<string, unknown>): Promise<void> => {
		try {
			await api(`/api/chats/${encodeURIComponent(ui.activeId ?? "")}/extension-response`, {
				method: "POST",
				body: JSON.stringify(response),
			});
		} catch (error) {
			showToast(error instanceof Error ? error.message : "Не удалось ответить расширению.", "error");
		}
	};
	if (request.method === "notify") {
		showToast(
			typeof request.message === "string" ? request.message : "Сообщение от расширения",
			request.notifyType === "error" ? "error" : "info",
		);
		return;
	}
	if (request.method === "setStatus") {
		setActivity(typeof request.statusText === "string" ? request.statusText : undefined);
		return;
	}
	if (request.method === "set_editor_text") {
		elements.prompt.value = typeof request.text === "string" ? request.text : "";
		autoGrowPrompt();
		return;
	}
	if (request.method === "setWidget" && typeof request.widgetKey === "string") {
		const lines = Array.isArray(request.widgetLines)
			? request.widgetLines.filter((line): line is string => typeof line === "string")
			: [];
		if (!lines.length) ui.widgets.delete(request.widgetKey);
		else {
			ui.widgets.set(request.widgetKey, {
				lines,
				placement: request.widgetPlacement === "aboveEditor" ? "aboveEditor" : "belowEditor",
			});
		}
		renderWidgets();
		return;
	}
	if (request.method === "setTitle") {
		if (typeof request.title === "string") document.title = `${request.title} · Pi Web Agent`;
		return;
	}
	if (request.method === "confirm") {
		showDialog({
			kind: "confirm",
			title: typeof request.title === "string" ? request.title : "Подтвердите",
			message: typeof request.message === "string" ? request.message : "",
			confirmLabel: "Подтвердить",
			onConfirm: async () => await reply({ id: request.id, confirmed: true }),
			onCancel: async () => await reply({ id: request.id, confirmed: false }),
		});
		return;
	}
	if (request.method === "select") {
		const options = Array.isArray(request.options)
			? request.options.filter((option): option is string => typeof option === "string")
			: [];
		showDialog({
			kind: "select",
			title: typeof request.title === "string" ? request.title : "Выберите вариант",
			options,
			onConfirm: async (value) => await reply({ id: request.id, value }),
			onCancel: async () => await reply({ id: request.id, cancelled: true }),
		});
		return;
	}
	if (request.method === "input" || request.method === "editor") {
		showDialog({
			kind: "input",
			title: typeof request.title === "string" ? request.title : "Введите значение",
			confirmLabel: "Отправить",
			placeholder: typeof request.placeholder === "string" ? request.placeholder : "",
			prefill: typeof request.prefill === "string" ? request.prefill : "",
			multiline: request.method === "editor",
			onConfirm: async (value) => await reply({ id: request.id, value }),
			onCancel: async () => await reply({ id: request.id, cancelled: true }),
		});
	}
	if (request.method !== "input" && request.method !== "editor") {
		showToast(`Расширение Pi запросило неподдерживаемое действие: ${request.method}`, "error");
	}
}

async function submitRename(title: string): Promise<void> {
	const chat = ui.chats.find((item) => item.id === ui.activeId);
	if (!chat) return;
	try {
		const payload = await api<{ chat?: unknown }>(`/api/chats/${encodeURIComponent(chat.id)}`, {
			method: "PATCH",
			body: JSON.stringify({ title }),
		});
		const next = asChat(payload.chat);
		if (!next) throw new Error("Сервер вернул некорректный чат.");
		updateActiveChat(next);
		renderContext();
	} catch (error) {
		showToast(error instanceof Error ? error.message : "Не удалось переименовать чат.", "error");
	}
}

function renameActiveChat(): void {
	const chat = ui.chats.find((item) => item.id === ui.activeId);
	if (!chat) return;
	showDialog({
		kind: "input",
		title: "Переименовать чат",
		confirmLabel: "Сохранить",
		prefill: chat.title,
		valueLabel: "Название",
		onConfirm: async (value) => {
			if (value.trim()) await submitRename(value.trim());
		},
	});
}

async function removeActiveChat(): Promise<void> {
	const chat = ui.chats.find((item) => item.id === ui.activeId);
	if (!chat) return;
	try {
		await api(`/api/chats/${encodeURIComponent(chat.id)}`, { method: "DELETE" });
		closeEvents();
		ui.chats = ui.chats.filter((item) => item.id !== chat.id);
		ui.activeId = undefined;
		ui.state = undefined;
		ui.messages = [];
		ui.capabilities = undefined;
		ui.streaming = false;
		ui.widgets.clear();
		renderChatList();
		renderMessages();
		renderWidgets();
		renderContext();
		showToast("Чат убран из списка.");
	} catch (error) {
		showToast(error instanceof Error ? error.message : "Не удалось удалить чат.", "error");
	}
}

function deleteActiveChat(): void {
	const chat = ui.chats.find((item) => item.id === ui.activeId);
	if (!chat) return;
	showDialog({
		kind: "confirm",
		title: "Убрать чат из web-списка",
		message: `«${chat.title}» исчезнет только из web-списка. Сессия Pi останется на диске.`,
		confirmLabel: "Убрать чат",
		tone: "danger",
		onConfirm: async () => await removeActiveChat(),
	});
}

async function updateAgentSetting(action: Record<string, unknown>): Promise<void> {
	const result = await runAction(action);
	if (result) await loadCapabilities();
	else renderContext();
}

function bindEvents(): void {
	elements.newChat.addEventListener("click", () => openWorkspaceDialog("new"));
	elements.sidebarFold.addEventListener("click", toggleSidebarFold);
	elements.chatList.addEventListener("click", (event) => {
		const target = (event.target as Element).closest<HTMLElement>("[data-chat-id]");
		if (target?.dataset.chatId) void openChat(target.dataset.chatId);
	});
	elements.prompt.addEventListener("input", autoGrowPrompt);
	elements.prompt.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void sendPrompt();
		}
	});
	elements.sendButton.addEventListener("click", () => void handleComposerSubmit());
	elements.deliveryButton.addEventListener("click", () => {
		ui.delivery = ui.delivery === "steer" ? "follow_up" : "steer";
		renderContext();
		showToast(ui.delivery === "steer" ? "Режим отправки: steer." : "Режим отправки: follow-up.");
	});
	elements.attachButton.addEventListener("click", () => elements.imageInput.click());
	elements.imageInput.addEventListener("change", () => {
		if (elements.imageInput.files) void addFiles(elements.imageInput.files);
		elements.imageInput.value = "";
	});
	elements.prompt.addEventListener("paste", (event) => {
		if (event.clipboardData?.files.length) void addFiles(event.clipboardData.files);
	});
	elements.composer.addEventListener("dragenter", (event) => {
		if (!event.dataTransfer?.types.includes("Files")) return;
		event.preventDefault();
		elements.composer.classList.add("is-dragging");
	});
	elements.composer.addEventListener("dragover", (event) => {
		if (!event.dataTransfer?.types.includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	});
	elements.composer.addEventListener("dragleave", (event) => {
		if (event.relatedTarget instanceof Node && elements.composer.contains(event.relatedTarget)) return;
		elements.composer.classList.remove("is-dragging");
	});
	elements.composer.addEventListener("drop", (event) => {
		event.preventDefault();
		elements.composer.classList.remove("is-dragging");
		if (event.dataTransfer?.files.length) void addFiles(event.dataTransfer.files);
	});
	elements.attachmentStrip.addEventListener("click", (event) => {
		const target = (event.target as Element).closest<HTMLElement>("[data-attachment-index]");
		const index = Number(target?.dataset.attachmentIndex);
		if (Number.isInteger(index)) {
			ui.attachments.splice(index, 1);
			renderAttachments();
		}
	});
	elements.modelButton.addEventListener("click", () => {
		if (ui.modelMenuOpen) {
			ui.modelMenuOpen = false;
			elements.modelMenu.hidden = true;
		} else {
			void loadModels();
		}
	});
	elements.modelMenu.addEventListener("click", (event) => {
		const target = (event.target as Element).closest<HTMLElement>("[data-model-index]");
		const index = Number(target?.dataset.modelIndex);
		if (Number.isInteger(index)) void selectModel(index);
	});
	elements.commandButton.addEventListener("click", () => void openCommandPalette());
	elements.compactButton.addEventListener("click", () => void runPaletteCommand("compact"));
	elements.cloneButton.addEventListener("click", () => void runPaletteCommand("clone"));
	elements.forkButton.addEventListener("click", () => void runPaletteCommand("fork"));
	elements.exportButton.addEventListener("click", () => void runPaletteCommand("export"));
	elements.treeButton.addEventListener("click", () => void runPaletteCommand("tree"));
	elements.thinkingLevel.addEventListener(
		"change",
		() => void updateAgentSetting({ type: "set_thinking_level", level: elements.thinkingLevel.value }),
	);
	elements.steeringMode.addEventListener(
		"change",
		() => void updateAgentSetting({ type: "set_steering_mode", mode: elements.steeringMode.value }),
	);
	elements.followUpMode.addEventListener(
		"change",
		() => void updateAgentSetting({ type: "set_follow_up_mode", mode: elements.followUpMode.value }),
	);
	elements.autoCompact.addEventListener(
		"change",
		() => void updateAgentSetting({ type: "set_auto_compaction", enabled: elements.autoCompact.checked }),
	);
	elements.autoRetry.addEventListener(
		"change",
		() => void updateAgentSetting({ type: "set_auto_retry", enabled: elements.autoRetry.checked }),
	);
	elements.abortButton.addEventListener("click", () => void abortActiveResponse());
	elements.cwdValue.addEventListener("click", async () => {
		const chat = ui.chats.find((item) => item.id === ui.activeId);
		if (!chat) return;
		try {
			await navigator.clipboard.writeText(chat.cwd);
			showToast("Путь скопирован.");
		} catch {
			showToast("Браузер не разрешил скопировать путь.", "error");
		}
	});
	elements.changeWorkspace.addEventListener("click", () => openWorkspaceDialog("change"));
	elements.toggleInspector.addEventListener("click", () => setPanel("inspector", true));
	elements.closeInspector.addEventListener("click", () => setPanel("inspector", false));
	elements.openSidebar.addEventListener("click", () => setPanel("sidebar", true));
	elements.closeSidebar.addEventListener("click", () => setPanel("sidebar", false));
	elements.scrim.addEventListener("click", () => {
		setPanel("sidebar", false);
		setPanel("inspector", false);
	});
	elements.chatTitle.addEventListener("dblclick", renameActiveChat);
	elements.renameChat.addEventListener("click", renameActiveChat);
	elements.deleteChat.addEventListener("click", deleteActiveChat);
	elements.dialogPanel.addEventListener("click", (event) => {
		const target = (event.target as Element).closest<HTMLElement>(
			"[data-dialog-action], [data-command-id], [data-fork-entry], [data-dialog-value]",
		);
		if (!target) return;
		if (target.dataset.dialogAction === "cancel") void cancelDialog();
		if (target.dataset.dialogAction === "confirm") void confirmDialog();
		if (target.dataset.commandId) void runPaletteCommand(target.dataset.commandId);
		if (target.dataset.forkEntry) {
			closeDialog();
			void createBranch(target.dataset.forkEntry);
		}
		if (target.dataset.dialogValue) void selectDialogValue(target.dataset.dialogValue);
	});
	elements.dialogPanel.addEventListener("input", (event) => {
		const input = event.target as HTMLInputElement;
		if (input.id !== "command-filter") return;
		const query = input.value.trim().toLocaleLowerCase("ru-RU");
		elements.dialogPanel.querySelectorAll<HTMLElement>(".palette-command").forEach((command) => {
			command.hidden = Boolean(query) && !command.textContent?.toLocaleLowerCase("ru-RU").includes(query);
		});
	});
	elements.dialogLayer.addEventListener("click", (event) => {
		if (event.target === elements.dialogLayer) void cancelDialog();
	});
	document.addEventListener("keydown", (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
			event.preventDefault();
			openWorkspaceDialog("new");
		}
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
			event.preventDefault();
			void openCommandPalette();
		}
		if (event.key === "Escape") {
			if (ui.dialog) {
				void cancelDialog();
				return;
			}
			ui.modelMenuOpen = false;
			elements.modelMenu.hidden = true;
			setPanel("sidebar", false);
			setPanel("inspector", false);
		}
		if ((event.metaKey || event.ctrlKey) && event.key === "Backspace") void deleteActiveChat();
	});
	document.addEventListener("click", (event) => {
		if (!elements.modelMenu.contains(event.target as Node) && !elements.modelButton.contains(event.target as Node)) {
			ui.modelMenuOpen = false;
			elements.modelMenu.hidden = true;
		}
	});
}

async function initialize(): Promise<void> {
	bindEvents();
	renderSidebarFold();
	renderMessages();
	renderContext();
	try {
		const health = await api<{ name?: string; version?: string }>("/api/health");
		elements.version.textContent = health.version ? `v${health.version}` : "Локальный сервер";
		await refreshChats();
		if (ui.chats[0]) await openChat(ui.chats[0].id);
	} catch (error) {
		elements.version.textContent = "Сервер недоступен";
		showToast(error instanceof Error ? error.message : "Не удалось подключиться к Pi Web Agent.", "error");
	}
}

void initialize();
