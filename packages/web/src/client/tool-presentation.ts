interface ToolContent {
	data?: unknown;
	mimeType?: unknown;
	text?: unknown;
	type?: unknown;
}

interface ToolResultInput {
	content: string | ToolContent[];
	isError?: boolean;
	path?: string;
	toolName?: string;
}

export interface ToolCallPresentation {
	id?: string;
	output?: string;
	state?: "active" | "complete" | "error";
}

interface ToolMeta {
	action: string;
	label: string;
	result: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function normalizedToolName(value: unknown): string {
	return typeof value === "string" && value.trim() ? value.trim().toLocaleLowerCase("en-US") : "tool";
}

function metaFor(name: string): ToolMeta {
	switch (name) {
		case "bash":
		case "shell":
		case "exec":
			return { label: "Bash", action: "Выполняет команду", result: "Команда выполнена" };
		case "read":
		case "read_file":
			return { label: "Read", action: "Читает файл", result: "Файл прочитан" };
		case "write":
		case "write_file":
			return { label: "Write", action: "Создаёт файл", result: "Файл записан" };
		case "edit":
		case "apply_patch":
		case "patch":
			return { label: "Edit", action: "Изменяет файл", result: "Изменение применено" };
		case "grep":
		case "search":
			return { label: "Grep", action: "Ищет в файлах", result: "Поиск завершён" };
		case "find":
		case "glob":
			return { label: "Find", action: "Находит файлы", result: "Файлы найдены" };
		case "ls":
		case "list":
			return { label: "Ls", action: "Просматривает папку", result: "Папка прочитана" };
		case "web_search":
		case "search_web":
			return { label: "Web", action: "Ищет в интернете", result: "Поиск завершён" };
		case "browser":
		case "browser_open":
		case "fetch":
			return { label: "Browser", action: "Работает в браузере", result: "Браузер вернул результат" };
		default:
			return {
				label: name === "tool" ? "Инструмент" : name,
				action: "Использует инструмент",
				result: "Инструмент выполнен",
			};
	}
}

function stringArgument(argumentsValue: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = argumentsValue[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function numberArgument(argumentsValue: Record<string, unknown>, key: string): number | undefined {
	const value = argumentsValue[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textStats(value: string): string {
	const lines = value ? value.split("\n").length : 0;
	return `${lines} ${lines === 1 ? "строка" : "строк"} · ${value.length.toLocaleString("ru-RU")} символов`;
}

function pathMarkup(path: string | undefined): string {
	return path ? `<code class="tool-path">${escapeHtml(path)}</code>` : "";
}

export function toolFilePath(argumentsValue: unknown): string | undefined {
	return isObject(argumentsValue)
		? stringArgument(argumentsValue, "path", "file_path", "filePath", "directory")
		: undefined;
}

function fileName(path: string): string {
	const segments = path.split(/[\\/]/);
	return segments[segments.length - 1] || path;
}

function languageForPath(path: string | undefined): string {
	const extension = path?.split(".").pop()?.toLocaleLowerCase("en-US");
	switch (extension) {
		case "html":
		case "htm":
		case "svg":
		case "xml":
			return "markup";
		case "css":
		case "scss":
		case "sass":
			return "css";
		case "ts":
		case "tsx":
			return "typescript";
		case "js":
		case "jsx":
		case "mjs":
		case "cjs":
			return "javascript";
		case "json":
			return "json";
		case "md":
		case "mdx":
			return "markdown";
		case "sh":
		case "bash":
		case "zsh":
			return "shell";
		case "py":
			return "python";
		case "go":
			return "go";
		case "rs":
			return "rust";
		default:
			return "text";
	}
}

function highlightSource(value: string, language: string): string {
	const matcher =
		language === "markup"
			? /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g
			: language === "python" || language === "shell" || language === "markdown"
				? /#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:def|return|if|else|for|while|class|import|from|async|await|in|match|case|break|continue|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b/g
				: /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|class|interface|type|import|from|export|async|await|new|true|false|null|undefined|in|match|case|switch|break|continue|package|func|struct|pub|impl)\b|\b\d+(?:\.\d+)?\b/g;
	let cursor = 0;
	let output = "";
	for (const match of value.matchAll(matcher)) {
		const token = match[0];
		const index = match.index ?? cursor;
		output += escapeHtml(value.slice(cursor, index));
		const className =
			token.startsWith("//") || token.startsWith("/*") || token.startsWith("<!--") || token.startsWith("#")
				? "syntax-comment"
				: token.startsWith('"') || token.startsWith("'") || token.startsWith("`")
					? "syntax-string"
					: /^\d/.test(token)
						? "syntax-number"
						: language === "markup"
							? "syntax-tag"
							: "syntax-keyword";
		output += `<span class="${className}">${escapeHtml(token)}</span>`;
		cursor = index + token.length;
	}
	return `${output}${escapeHtml(value.slice(cursor))}`;
}

function sourcePreview(path: string | undefined, content: string, active: boolean, title = "Содержимое файла"): string {
	const language = languageForPath(path);
	const name = path ? fileName(path) : title;
	return `<details class="tool-file-preview"${active ? " open" : ""}><summary><span>${escapeHtml(name)}</span><span class="tool-language">${escapeHtml(language)}</span><span class="tool-preview-meta">${escapeHtml(textStats(content))}</span></summary><pre><code class="language-${escapeHtml(language)}">${highlightSource(content, language)}</code></pre></details>`;
}

function editPreview(argumentsValue: Record<string, unknown>, path: string | undefined, active: boolean): string {
	const patch = stringArgument(argumentsValue, "patch");
	if (patch) return sourcePreview(path, patch, active, "Изменение");
	const edits = Array.isArray(argumentsValue.edits) ? argumentsValue.edits : [argumentsValue];
	const changes = edits.flatMap((edit) => {
		if (!isObject(edit)) return [];
		const oldText = stringArgument(edit, "oldText", "old_string", "old");
		const newText = stringArgument(edit, "newText", "new_string", "new");
		if (oldText === undefined && newText === undefined) return [];
		return [
			...(oldText === undefined ? [] : oldText.split("\n").map((line) => `-${line}`)),
			...(newText === undefined ? [] : newText.split("\n").map((line) => `+${line}`)),
		];
	});
	return changes.length ? sourcePreview(path, changes.join("\n"), active, "Изменение") : "";
}

function argumentPreview(argumentsValue: Record<string, unknown>): string {
	const visible = Object.entries(argumentsValue)
		.filter(([key]) => !["content", "command", "edits", "patch", "oldText", "newText"].includes(key))
		.slice(0, 3)
		.flatMap(([key, value]) => {
			if (typeof value === "string") return [`<span><b>${escapeHtml(key)}</b> ${escapeHtml(value)}</span>`];
			if (typeof value === "number" || typeof value === "boolean")
				return [`<span><b>${escapeHtml(key)}</b> ${escapeHtml(String(value))}</span>`];
			if (Array.isArray(value)) return [`<span><b>${escapeHtml(key)}</b> ${value.length} знач.</span>`];
			if (isObject(value)) return [`<span><b>${escapeHtml(key)}</b> ${Object.keys(value).length} полей</span>`];
			return [];
		});
	return visible.length ? `<div class="tool-arguments">${visible.join("")}</div>` : "";
}

function toolCallBody(name: string, argumentsValue: Record<string, unknown>, active: boolean): string {
	const path = toolFilePath(argumentsValue);
	switch (name) {
		case "bash":
		case "shell":
		case "exec": {
			const command = stringArgument(argumentsValue, "command", "cmd", "script");
			return command ? `<pre class="tool-command"><code>${escapeHtml(command)}</code></pre>` : "";
		}
		case "read":
		case "read_file": {
			const offset = numberArgument(argumentsValue, "offset");
			const limit = numberArgument(argumentsValue, "limit");
			const lineRange =
				offset === undefined ? "" : ` · строки ${offset}${limit === undefined ? "" : `–${offset + limit - 1}`}`;
			return `${pathMarkup(path)}${lineRange ? `<span class="tool-detail">${lineRange}</span>` : ""}`;
		}
		case "write":
		case "write_file": {
			const content = stringArgument(argumentsValue, "content");
			return `${pathMarkup(path)}${content === undefined ? "" : `<span class="tool-detail">${textStats(content)}</span>${sourcePreview(path, content, active)}`}`;
		}
		case "edit":
		case "apply_patch":
		case "patch": {
			const edits = Array.isArray(argumentsValue.edits) ? argumentsValue.edits.length : undefined;
			const patch = stringArgument(argumentsValue, "patch");
			const changeCount =
				edits ?? (patch ? patch.split("\n").filter((line) => /^[-+]/.test(line)).length : undefined);
			return `${pathMarkup(path)}${changeCount === undefined ? "" : `<span class="tool-detail">${changeCount} правок</span>`}${editPreview(argumentsValue, path, active)}`;
		}
		case "grep":
		case "search": {
			const pattern = stringArgument(argumentsValue, "pattern", "query", "search");
			const glob = stringArgument(argumentsValue, "glob");
			return `${pattern ? `<code class="tool-pattern">${escapeHtml(pattern)}</code>` : ""}${path ? `<span class="tool-detail">в ${escapeHtml(path)}</span>` : ""}${glob ? `<span class="tool-detail">${escapeHtml(glob)}</span>` : ""}`;
		}
		case "find":
		case "glob": {
			const pattern = stringArgument(argumentsValue, "pattern", "glob", "query");
			return `${pattern ? `<code class="tool-pattern">${escapeHtml(pattern)}</code>` : ""}${path ? `<span class="tool-detail">в ${escapeHtml(path)}</span>` : ""}`;
		}
		case "ls":
		case "list":
			return pathMarkup(path ?? ".");
		case "web_search":
		case "search_web": {
			const query = stringArgument(argumentsValue, "query", "q", "search_query");
			return query ? `<code class="tool-pattern">${escapeHtml(query)}</code>` : argumentPreview(argumentsValue);
		}
		case "browser":
		case "browser_open":
		case "fetch": {
			const target = stringArgument(argumentsValue, "url", "target", "query");
			return target ? `<code class="tool-path">${escapeHtml(target)}</code>` : argumentPreview(argumentsValue);
		}
		default:
			return argumentPreview(argumentsValue);
	}
}

export function toolOutputText(content: unknown): string {
	if (typeof content === "string") return content;
	if (isObject(content) && "content" in content) return toolOutputText(content.content);
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => (isObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

function imagesContent(content: string | ToolContent[]): string {
	if (typeof content === "string") return "";
	return content
		.flatMap((part) => {
			if (
				part.type !== "image" ||
				typeof part.data !== "string" ||
				typeof part.mimeType !== "string" ||
				!part.mimeType.startsWith("image/")
			)
				return [];
			return [
				`<img class="tool-result-image" src="data:${escapeHtml(part.mimeType)};base64,${escapeHtml(part.data)}" alt="Результат инструмента" />`,
			];
		})
		.join("");
}

function outputLabel(name: string): string {
	switch (name) {
		case "bash":
		case "shell":
		case "exec":
			return "Вывод команды";
		case "read":
		case "read_file":
			return "Содержимое файла";
		case "grep":
		case "search":
			return "Совпадения";
		case "find":
		case "glob":
			return "Найденные файлы";
		case "ls":
		case "list":
			return "Содержимое папки";
		default:
			return "Результат";
	}
}

function writeSuccess(text: string): { bytes: string; path: string } | undefined {
	const match = /^Successfully wrote (\d+) bytes to (.+)$/i.exec(text.trim());
	if (!match) return undefined;
	const bytes = Number(match[1]);
	const size = Number.isFinite(bytes) ? `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} КБ` : `${match[1]} байт`;
	return { bytes: size, path: match[2] };
}

export function renderToolCall(
	nameValue: unknown,
	argumentsValue: unknown,
	presentation: ToolCallPresentation = {},
): string {
	const name = normalizedToolName(nameValue);
	const meta = metaFor(name);
	const argumentsRecord = isObject(argumentsValue) ? argumentsValue : {};
	const active = presentation.state === "active";
	const body = toolCallBody(name, argumentsRecord, active);
	const status = active
		? '<span class="tool-live-status"><span></span>выполняется</span>'
		: presentation.state === "error"
			? '<span class="tool-live-status is-error">ошибка</span>'
			: "";
	const liveOutput = presentation.output
		? `<details class="tool-live-output" open><summary>Текущий вывод</summary><pre><code>${escapeHtml(presentation.output)}</code></pre></details>`
		: "";
	const id = presentation.id ? ` data-tool-call-id="${escapeHtml(presentation.id)}"` : "";
	return `<section class="tool-card tool-card-${escapeHtml(name)} ${active ? "is-active" : ""}"${id} data-tool-name="${escapeHtml(name)}"><div class="tool-card-header"><span class="tool-glyph" aria-hidden="true">›_</span><span class="tool-label">${escapeHtml(meta.label)}</span><span class="tool-action">${escapeHtml(meta.action)}</span>${status}</div>${body || liveOutput ? `<div class="tool-card-body">${body}${liveOutput}</div>` : ""}</section>`;
}

export function renderToolResult(input: ToolResultInput): string {
	const name = normalizedToolName(input.toolName);
	const meta = metaFor(name);
	const output = toolOutputText(input.content).trim();
	const media = imagesContent(input.content);
	const error = input.isError === true;
	const write = !error && (name === "write" || name === "write_file") ? writeSuccess(output) : undefined;
	if (write) {
		return `<section class="tool-result-card"><div class="tool-result-summary"><span class="tool-result-status">Готово</span><span class="tool-result-title">${escapeHtml(meta.result)}</span></div><div class="tool-result-note">${escapeHtml(write.bytes)} · ${pathMarkup(write.path)}</div></section>`;
	}
	const noOutput = !output || output === "(no output)";
	const lines = output ? output.split("\n").length : 0;
	const expanded = !noOutput && output.length <= 900 && lines <= 12 ? " open" : "";
	const title = error ? "Ошибка выполнения" : noOutput ? meta.result : outputLabel(name);
	const status = error ? "Ошибка" : "Готово";
	const body = noOutput
		? `<div class="tool-result-empty">${error ? "Инструмент не вернул подробностей." : "Выполнено без текстового вывода."}</div>`
		: `<pre class="tool-output"><code class="language-${escapeHtml(languageForPath(input.path))}">${input.path ? highlightSource(output, languageForPath(input.path)) : escapeHtml(output)}</code></pre>`;
	return `<details class="tool-result-card ${error ? "is-error" : ""}"${expanded}><summary><span class="tool-result-status">${status}</span><span class="tool-result-title">${escapeHtml(title)}</span><span class="tool-result-meta">${noOutput ? "" : `${lines} строк`}</span></summary>${body}${media}</details>`;
}
