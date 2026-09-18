import { Marked, type RendererObject } from "marked";

function escapeAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function safeUrl(value: string, allowRelative: boolean): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (allowRelative && (/^(?:[./#]|\?)/.test(trimmed) || trimmed.startsWith("../"))) return trimmed;
	try {
		const url = new URL(trimmed, "https://pi.local");
		if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return url.href;
	} catch {
		return undefined;
	}
	return undefined;
}

const renderer: RendererObject = {
	code({ text, lang }) {
		const language = lang?.trim();
		const label = language ? `<span class="code-language">${escapeAttribute(language)}</span>` : "";
		return `<pre>${label}<code>${escapeAttribute(text)}</code></pre>`;
	},
	html({ raw }) {
		return escapeAttribute(raw);
	},
	image({ href, title, text }) {
		const source = safeUrl(href, false);
		if (!source) return escapeAttribute(text);
		const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : "";
		return `<img class="markdown-image" src="${escapeAttribute(source)}" alt="${escapeAttribute(text)}" loading="lazy"${titleAttribute} />`;
	},
	link({ href, title, tokens }) {
		const content = this.parser.parseInline(tokens);
		const target = safeUrl(href, true);
		if (!target) return content;
		const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : "";
		return `<a href="${escapeAttribute(target)}" target="_blank" rel="noreferrer noopener"${titleAttribute}>${content}</a>`;
	},
};

const markdown = new Marked({ async: false, breaks: true, gfm: true, renderer });

export function renderMarkdown(value: string): string {
	return markdown.parse(value, { async: false });
}
