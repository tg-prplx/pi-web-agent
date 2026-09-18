#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { ChatManager, type ChatStreamEvent, type WebAction } from "./chat-manager.ts";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PACKAGE_VERSION = "0.82.1";
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(response: ServerResponse, status: number, payload: unknown): void {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(payload));
}

function error(response: ServerResponse, status: number, message: string): void {
	json(response, status, { error: message });
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) {
			throw new Error("Запрос слишком большой.");
		}
		chunks.push(buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (!raw) {
		return {};
	}
	const value: unknown = JSON.parse(raw);
	if (!isObject(value)) {
		throw new Error("Ожидался JSON-объект.");
	}
	return value;
}

function stringValue(value: unknown, field: string, required = false): string | undefined {
	if (value === undefined && !required) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`Поле ${field} должно быть строкой.`);
	}
	return value;
}

function booleanValue(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`Поле ${field} должно быть true или false.`);
	}
	return value;
}

function modeValue(value: unknown, field: string): "all" | "one-at-a-time" {
	if (value === "all" || value === "one-at-a-time") {
		return value;
	}
	throw new Error(`Поле ${field} должно быть all или one-at-a-time.`);
}

function parseImages(value: unknown): ImageContent[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > MAX_IMAGES) {
		throw new Error(`Можно прикрепить до ${MAX_IMAGES} изображений.`);
	}
	return value.map((candidate) => {
		if (!isObject(candidate) || typeof candidate.data !== "string" || typeof candidate.mimeType !== "string") {
			throw new Error("Некорректное изображение.");
		}
		if (!candidate.mimeType.startsWith("image/") || !/^[a-zA-Z0-9+/]+={0,2}$/.test(candidate.data)) {
			throw new Error("Поддерживаются только изображения в base64.");
		}
		const size = Buffer.from(candidate.data, "base64").byteLength;
		if (size === 0 || size > MAX_IMAGE_BYTES) {
			throw new Error("Размер каждого изображения должен быть не больше 8 МБ.");
		}
		return { type: "image", data: candidate.data, mimeType: candidate.mimeType };
	});
}

function parseAction(value: JsonObject): WebAction {
	const type = stringValue(value.type, "type", true) ?? "";
	switch (type) {
		case "steer":
		case "follow_up": {
			const message = stringValue(value.message, "message", true) ?? "";
			if (!message.trim() && value.images === undefined) {
				throw new Error("Введите сообщение или прикрепите изображение.");
			}
			if (message.length > 120_000) {
				throw new Error("Сообщение слишком длинное.");
			}
			return { type, message, images: parseImages(value.images) };
		}
		case "new_session":
		case "cycle_model":
		case "cycle_thinking_level":
		case "abort_retry":
		case "abort_bash":
		case "get_last_assistant_text":
			return { type };
		case "set_thinking_level":
			return { type, level: stringValue(value.level, "level", true) ?? "" };
		case "set_steering_mode":
		case "set_follow_up_mode":
			return { type, mode: modeValue(value.mode, "mode") };
		case "set_auto_compaction":
		case "set_auto_retry":
			return { type, enabled: booleanValue(value.enabled, "enabled") };
		case "compact": {
			const customInstructions = stringValue(value.customInstructions, "customInstructions");
			if (customInstructions !== undefined && customInstructions.length > 20_000) {
				throw new Error("Инструкции для сжатия слишком длинные.");
			}
			return { type, customInstructions };
		}
		case "bash": {
			const command = stringValue(value.command, "command", true) ?? "";
			if (!command.trim() || command.length > 30_000) {
				throw new Error("Команда должна быть непустой и не длиннее 30 000 символов.");
			}
			return {
				type,
				command,
				excludeFromContext: value.excludeFromContext === true,
			};
		}
		case "export_html":
			return { type, outputPath: stringValue(value.outputPath, "outputPath") };
		case "switch_session":
			return { type, sessionPath: stringValue(value.sessionPath, "sessionPath", true) ?? "" };
		default:
			throw new Error("Неизвестное действие Pi.");
	}
}

function parseExtensionResponse(value: unknown): RpcExtensionUIResponse {
	if (!isObject(value) || typeof value.id !== "string") {
		throw new Error("Некорректный ответ расширению.");
	}
	if (value.cancelled === true) {
		return { type: "extension_ui_response", id: value.id, cancelled: true };
	}
	if (typeof value.value === "string") {
		return { type: "extension_ui_response", id: value.id, value: value.value };
	}
	if (typeof value.confirmed === "boolean") {
		return { type: "extension_ui_response", id: value.id, confirmed: value.confirmed };
	}
	throw new Error("Некорректный ответ расширению.");
}

function contentType(pathname: string): string {
	if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
	if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
	if (pathname.endsWith(".svg")) return "image/svg+xml";
	if (pathname.endsWith(".png")) return "image/png";
	return "text/html; charset=utf-8";
}

function sendEvent(response: ServerResponse, event: ChatStreamEvent): void {
	response.write(`event: pi\ndata: ${JSON.stringify(event)}\n\n`);
}

function serveStatic(pathname: string, response: ServerResponse): void {
	const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
	const assetPath = resolve(publicDir, requestedPath);
	const relativePath = relative(publicDir, assetPath);
	if (!requestedPath || relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
		error(response, 404, "Не найдено.");
		return;
	}
	try {
		const body = readFileSync(assetPath);
		response.writeHead(200, {
			"Content-Type": contentType(assetPath),
			"Cache-Control": "no-cache",
			"Content-Security-Policy":
				"default-src 'self'; connect-src 'self'; img-src 'self' data: http: https:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		});
		response.end(body);
	} catch {
		error(response, 404, "Не найдено.");
	}
}

function getFlag(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

function parsePort(value: string | undefined): number {
	const port = Number(value ?? process.env.PI_WEB_PORT ?? "4317");
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("Порт должен быть целым числом от 1 до 65535.");
	}
	return port;
}

function printHelp(): void {
	console.log(
		"Pi Web Agent\n\nUsage:\n  pi-web [--host 127.0.0.1] [--port 4317] [--cwd /project]\n\nBy default the agent is only available from this computer.",
	);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		printHelp();
		return;
	}
	if (args.includes("--version") || args.includes("-v")) {
		console.log(PACKAGE_VERSION);
		return;
	}

	const host = getFlag(args, "--host") ?? "127.0.0.1";
	const port = parsePort(getFlag(args, "--port"));
	const manager = new ChatManager({ defaultCwd: getFlag(args, "--cwd") });
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		const match =
			/^\/api\/chats\/([^/]+)(?:\/(events|messages|abort|compact|model|extension-response|capabilities|actions|branch))?$/.exec(
				url.pathname,
			);

		try {
			if (request.method === "GET" && url.pathname === "/api/health") {
				json(response, 200, {
					name: "Pi Web Agent",
					version: PACKAGE_VERSION,
					localOnly: host === "127.0.0.1" || host === "localhost",
				});
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/chats") {
				json(response, 200, { chats: manager.list() });
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/chats") {
				const body = await readJson(request);
				const snapshot = await manager.create({
					cwd: stringValue(body.cwd, "cwd"),
					title: stringValue(body.title, "title"),
				});
				json(response, 201, snapshot);
				return;
			}
			if (match) {
				const chatId = decodeURIComponent(match[1]);
				const action = match[2];
				if (request.method === "GET" && !action) {
					json(response, 200, await manager.open(chatId));
					return;
				}
				if (request.method === "GET" && action === "events") {
					response.writeHead(200, {
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
						"Content-Type": "text/event-stream",
					});
					response.write("retry: 1000\n\n");
					const unsubscribe = manager.subscribe(chatId, (event) => sendEvent(response, event));
					const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 25_000);
					request.on("close", () => {
						clearInterval(heartbeat);
						unsubscribe();
					});
					return;
				}
				if (request.method === "POST" && action === "messages") {
					const body = await readJson(request);
					const message = stringValue(body.message, "message", true) ?? "";
					if (message.length > 120_000) {
						throw new Error("Сообщение слишком длинное.");
					}
					await manager.prompt(chatId, message, parseImages(body.images));
					json(response, 202, { ok: true });
					return;
				}
				if (request.method === "POST" && action === "abort") {
					await manager.abort(chatId);
					json(response, 200, { ok: true });
					return;
				}
				if (request.method === "POST" && action === "compact") {
					await manager.compact(chatId);
					json(response, 202, { ok: true });
					return;
				}
				if (request.method === "GET" && action === "model") {
					json(response, 200, { models: await manager.getModels(chatId) });
					return;
				}
				if (request.method === "POST" && action === "model") {
					const body = await readJson(request);
					const state = await manager.setModel(
						chatId,
						stringValue(body.provider, "provider", true) ?? "",
						stringValue(body.modelId, "modelId", true) ?? "",
					);
					json(response, 200, { state });
					return;
				}
				if (request.method === "POST" && action === "extension-response") {
					await manager.answerExtensionRequest(chatId, parseExtensionResponse(await readJson(request)));
					json(response, 200, { ok: true });
					return;
				}
				if (request.method === "GET" && action === "capabilities") {
					json(response, 200, await manager.getCapabilities(chatId));
					return;
				}
				if (request.method === "POST" && action === "actions") {
					json(response, 200, await manager.runAction(chatId, parseAction(await readJson(request))));
					return;
				}
				if (request.method === "POST" && action === "branch") {
					const body = await readJson(request);
					const entryId = stringValue(body.entryId, "entryId");
					const snapshot = entryId ? await manager.fork(chatId, entryId) : await manager.clone(chatId);
					json(response, 201, snapshot);
					return;
				}
				if (request.method === "PATCH" && !action) {
					const body = await readJson(request);
					json(response, 200, {
						chat: await manager.rename(chatId, stringValue(body.title, "title", true) ?? ""),
					});
					return;
				}
				if (request.method === "DELETE" && !action) {
					await manager.delete(chatId);
					response.writeHead(204).end();
					return;
				}
			}
			if (request.method === "GET") {
				serveStatic(url.pathname, response);
				return;
			}
			error(response, 404, "Не найдено.");
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : "Неизвестная ошибка сервера.";
			console.error(message);
			error(response, 400, message);
		}
	});

	let shuttingDown = false;
	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		await manager.shutdown();
		await new Promise<void>((done) => server.close(() => done()));
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	await new Promise<void>((resolveServer) => server.listen(port, host, resolveServer));
	console.log(`Pi Web Agent is running at http://${host}:${port}`);
}

await main();
