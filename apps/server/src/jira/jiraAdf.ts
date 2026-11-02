/**
 * Jira Cloud's rich text is Atlassian Document Format (ADF), a JSON tree. Comments
 * are written as plain text and sent as ADF; descriptions and comments are read
 * back as Markdown, which the app already renders safely.
 */

import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

interface AdfMark {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

interface AdfNode {
  readonly type: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly marks?: ReadonlyArray<AdfMark>;
  readonly content?: ReadonlyArray<AdfNode>;
}

export interface AdfDocument {
  readonly version: 1;
  readonly type: "doc";
  readonly content: ReadonlyArray<AdfNode>;
}

const MAX_MARKDOWN_LENGTH = 100_000;
const MAX_DEPTH = 24;
const WEB_ADDRESS_PATTERN = /https?:\/\/[^\s<>"]+/gu;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)\]}'"]+$/u;

const textNode = (text: string, marks?: ReadonlyArray<AdfMark>): AdfNode =>
  marks === undefined ? { type: "text", text } : { type: "text", text, marks };

function inlineNodes(line: string): ReadonlyArray<AdfNode> {
  const nodes: AdfNode[] = [];
  let cursor = 0;
  for (const match of line.matchAll(WEB_ADDRESS_PATTERN)) {
    const raw = match[0];
    const trailing = TRAILING_PUNCTUATION_PATTERN.exec(raw)?.[0] ?? "";
    const address = trailing.length > 0 ? raw.slice(0, raw.length - trailing.length) : raw;
    if (!URL.canParse(address)) continue;
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(textNode(line.slice(cursor, start)));
    nodes.push(textNode(address, [{ type: "link", attrs: { href: address } }]));
    cursor = start + address.length;
  }
  if (cursor < line.length) nodes.push(textNode(line.slice(cursor)));
  return nodes;
}

/**
 * Paragraphs follow blank lines, a single line break stays a line break, and web
 * addresses become links. Nothing else is read as formatting.
 */
export function plainTextToAdf(text: string): AdfDocument {
  const paragraphs = text
    .replace(/\r\n?/gu, "\n")
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.split("\n").filter((line) => line.trim().length > 0))
    .filter((lines) => lines.length > 0);
  return {
    version: 1,
    type: "doc",
    content: paragraphs.map((lines) => ({
      type: "paragraph",
      content: lines.flatMap((line, index) => [
        ...(index > 0 ? [{ type: "hardBreak" }] : []),
        ...inlineNodes(line),
      ]),
    })),
  };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function asNode(value: unknown): AdfNode | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  return value as unknown as AdfNode;
}

const children = (node: AdfNode): ReadonlyArray<AdfNode> =>
  Array.isArray(node.content)
    ? node.content.flatMap((child) => {
        const parsed = asNode(child);
        return parsed === null ? [] : [parsed];
      })
    : [];

const attrString = (node: AdfNode, name: string): string | undefined => {
  const value = node.attrs?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const isSafeLink = (href: string): boolean => /^(?:https?:|mailto:)/iu.test(href);

const escapeMarkdown = (text: string): string => text.replace(/([\\`*_[\]<>~|])/gu, "\\$1");

// A paragraph that begins like a list item, heading or quote would be read as one.
const escapeLineStarts = (text: string): string =>
  text.replace(/^(\s*)([#+-]|\d+[.)])(?=\s)/gmu, "$1\\$2");

function formatDate(timestamp: unknown): string {
  const milliseconds = typeof timestamp === "string" ? Number(timestamp) : timestamp;
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) return "";
  return Option.match(DateTime.make(milliseconds), {
    onNone: () => "",
    onSome: (date) => DateTime.formatIso(date).slice(0, 10),
  });
}

function markedText(node: AdfNode): string {
  const text = node.text ?? "";
  if (text.length === 0) return "";
  const marks = node.marks ?? [];
  const has = (type: string) => marks.some((mark) => mark.type === type);
  const escaped = has("code") ? `\`${text.replaceAll("`", "'")}\`` : escapeMarkdown(text);
  // Markers hug the words: "**bold **" does not render.
  const leading = /^\s*/u.exec(escaped)?.[0] ?? "";
  const trailing = /\s*$/u.exec(escaped)?.[0] ?? "";
  const core = escaped.slice(leading.length, escaped.length - trailing.length);
  if (core.length === 0) return escaped;
  let wrapped = core;
  if (has("strong")) wrapped = `**${wrapped}**`;
  if (has("em")) wrapped = `_${wrapped}_`;
  if (has("strike")) wrapped = `~~${wrapped}~~`;
  const link = marks.find((mark) => mark.type === "link");
  const href = typeof link?.attrs?.href === "string" ? link.attrs.href : undefined;
  if (href !== undefined && isSafeLink(href)) wrapped = `[${wrapped}](${href})`;
  return `${leading}${wrapped}${trailing}`;
}

function renderInline(nodes: ReadonlyArray<AdfNode>, depth: number): string {
  return nodes
    .map((node): string => {
      switch (node.type) {
        case "text":
          return markedText(node);
        case "hardBreak":
          return "  \n";
        case "mention":
          return escapeMarkdown(attrString(node, "text") ?? "@someone");
        case "emoji":
          return attrString(node, "text") ?? attrString(node, "shortName") ?? "";
        case "date":
          return formatDate(node.attrs?.timestamp);
        case "status":
          return `[${escapeMarkdown(attrString(node, "text") ?? "status")}]`;
        case "inlineCard": {
          const url = attrString(node, "url");
          return url !== undefined && isSafeLink(url) ? `<${url}>` : "";
        }
        case "media":
        case "mediaInline":
          return "[attachment]";
        default:
          if (node.text !== undefined) return markedText(node);
          return depth < MAX_DEPTH ? renderInline(children(node), depth + 1) : "";
      }
    })
    .join("");
}

const indent = (text: string, prefix: string): string =>
  text
    .split("\n")
    .map((line, index) => (index === 0 || line.length === 0 ? line : `${prefix}${line}`))
    .join("\n");

function renderListItem(item: AdfNode, marker: string, depth: number): string {
  const body = renderBlocks(children(item), depth + 1).join("\n");
  return `${marker}${indent(body, " ".repeat(marker.length))}`;
}

function renderTable(table: AdfNode, depth: number): string {
  const rows = children(table)
    .filter((row) => row.type === "tableRow")
    .map((row) =>
      children(row).map((cell) =>
        renderBlocks(children(cell), depth + 1)
          .join(" ")
          .replace(/\s*\n\s*/gu, " ")
          // Text is already escaped; a code span's pipe is not.
          .replace(/(?<!\\)\|/gu, "\\|")
          .trim(),
      ),
    );
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (rows.length === 0 || width === 0) return "";
  const line = (row: ReadonlyArray<string>) =>
    `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
  const [header, ...body] = rows;
  return [
    line(header!),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

const PANEL_LABELS: Readonly<Record<string, string>> = {
  info: "Info",
  note: "Note",
  warning: "Warning",
  error: "Error",
  success: "Success",
  tip: "Tip",
};

function renderBlock(node: AdfNode, depth: number): string {
  if (depth > MAX_DEPTH) return "";
  switch (node.type) {
    case "paragraph":
      return escapeLineStarts(renderInline(children(node), depth)).trim();
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `${"#".repeat(level)} ${renderInline(children(node), depth).trim()}`;
    }
    case "bulletList":
      return children(node)
        .map((item) => renderListItem(item, "- ", depth))
        .join("\n");
    case "orderedList": {
      const first = Number(node.attrs?.order);
      const start = Number.isInteger(first) && first >= 0 ? first : 1;
      return children(node)
        .map((item, index) => renderListItem(item, `${start + index}. `, depth))
        .join("\n");
    }
    case "taskList":
      return children(node)
        .map((item) =>
          renderListItem(item, item.attrs?.state === "DONE" ? "- [x] " : "- [ ] ", depth),
        )
        .join("\n");
    case "decisionList":
      return children(node)
        .map((item) => renderListItem(item, "- ", depth))
        .join("\n");
    case "codeBlock": {
      const language = attrString(node, "language") ?? "";
      const code = children(node)
        .map((child) => child.text ?? "")
        .join("");
      const fence = code.includes("```") ? "~~~~" : "```";
      return `${fence}${language}\n${code}\n${fence}`;
    }
    case "blockquote":
      return renderBlocks(children(node), depth + 1)
        .join("\n\n")
        .split("\n")
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n");
    case "panel": {
      const label = PANEL_LABELS[attrString(node, "panelType") ?? "info"] ?? "Note";
      return [`**${label}**`, ...renderBlocks(children(node), depth + 1)]
        .join("\n\n")
        .split("\n")
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n");
    }
    case "rule":
      return "---";
    case "table":
      return renderTable(node, depth);
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "_[attachment]_";
    case "expand":
    case "nestedExpand": {
      const title = attrString(node, "title");
      return [
        ...(title === undefined ? [] : [`**${escapeMarkdown(title)}**`]),
        ...renderBlocks(children(node), depth + 1),
      ].join("\n\n");
    }
    case "blockCard":
    case "embedCard": {
      const url = attrString(node, "url");
      return url !== undefined && isSafeLink(url) ? `<${url}>` : "";
    }
    case "text":
    case "hardBreak":
    case "mention":
    case "emoji":
    case "date":
    case "status":
    case "inlineCard":
      return renderInline([node], depth);
    default: {
      const nested = children(node);
      if (nested.length === 0) return node.text === undefined ? "" : escapeMarkdown(node.text);
      return renderBlocks(nested, depth + 1).join("\n\n");
    }
  }
}

function renderBlocks(nodes: ReadonlyArray<AdfNode>, depth: number): string[] {
  return nodes.map((node) => renderBlock(node, depth)).filter((block) => block.length > 0);
}

/**
 * Markdown for an ADF value. A string passes through as written (Jira's older
 * API shape), and anything that is not a document reads as empty.
 */
export function adfToMarkdown(value: unknown): string {
  if (typeof value === "string") return value.slice(0, MAX_MARKDOWN_LENGTH);
  const root = asNode(value);
  if (root === null) return "";
  const markdown = renderBlocks(root.type === "doc" ? children(root) : [root], 0).join("\n\n");
  return markdown.length > MAX_MARKDOWN_LENGTH
    ? `${markdown.slice(0, MAX_MARKDOWN_LENGTH)}\n\n_[truncated]_`
    : markdown;
}
