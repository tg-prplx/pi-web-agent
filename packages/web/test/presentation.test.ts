import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/client/markdown.ts";
import { renderToolCall, renderToolResult } from "../src/client/tool-presentation.ts";

describe("web message presentation", () => {
	it("renders GitHub-flavored markdown without accepting raw HTML", () => {
		const output = renderMarkdown(
			"## План\n\n- **первый**\n- второй\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>",
		);
		expect(output).toContain("<h2>План</h2>");
		expect(output).toContain("<ul>");
		expect(output).toContain("<table>");
		expect(output).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(output).not.toContain("<script>");
	});

	it("presents bash calls and write results as structured UI", () => {
		const call = renderToolCall("bash", { command: "rg --files packages/web" });
		const result = renderToolResult({
			toolName: "write",
			content: [{ type: "text", text: "Successfully wrote 2048 bytes to /tmp/example.ts" }],
		});
		expect(call).toContain("Выполняет команду");
		expect(call).toContain("rg --files packages/web");
		expect(call).not.toContain('{"command"');
		expect(result).toContain("Файл записан");
		expect(result).toContain("2.0 КБ");
	});

	it("shows live source previews and highlights file content by extension", () => {
		const write = renderToolCall(
			"write",
			{ path: "/tmp/example.ts", content: 'const answer = "ready";' },
			{ id: "call-1", state: "active" },
		);
		const read = renderToolResult({
			toolName: "read",
			path: "/tmp/example.ts",
			content: [{ type: "text", text: "const answer = 42;" }],
		});
		expect(write).toContain('data-tool-call-id="call-1"');
		expect(write).toContain("выполняется");
		expect(write).toContain("language-typescript");
		expect(write).toContain("syntax-keyword");
		expect(read).toContain("language-typescript");
		expect(read).toContain("syntax-number");
	});

	it("does not treat CSS hex colors as comments", () => {
		const output = renderToolCall(
			"write",
			{ path: "/tmp/theme.css", content: ".button { color: #d9ff70; }" },
			{ id: "call-css", state: "active" },
		);
		expect(output).toContain("#d9ff70");
		expect(output).not.toContain('<span class="syntax-comment">#d9ff70; }</span>');
	});

	it("blocks executable markdown links and images", () => {
		const output = renderMarkdown("[bad](javascript:alert(1)) ![bad](data:text/html;base64,PHNjcmlwdD4=)");
		expect(output).not.toContain("javascript:");
		expect(output).not.toContain("data:text/html");
	});
});
