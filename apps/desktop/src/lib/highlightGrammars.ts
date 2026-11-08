import { refractor } from "refractor/core";
import bash from "refractor/bash";
import c from "refractor/c";
import cpp from "refractor/cpp";
import csharp from "refractor/csharp";
import css from "refractor/css";
import diff from "refractor/diff";
import docker from "refractor/docker";
import go from "refractor/go";
import graphql from "refractor/graphql";
import ini from "refractor/ini";
import java from "refractor/java";
import javascript from "refractor/javascript";
import json from "refractor/json";
import jsx from "refractor/jsx";
import kotlin from "refractor/kotlin";
import markdown from "refractor/markdown";
import markup from "refractor/markup";
import php from "refractor/php";
import python from "refractor/python";
import ruby from "refractor/ruby";
import rust from "refractor/rust";
import scss from "refractor/scss";
import sql from "refractor/sql";
import swift from "refractor/swift";
import toml from "refractor/toml";
import tsx from "refractor/tsx";
import typescript from "refractor/typescript";
import yaml from "refractor/yaml";

/**
 * The syntax highlighter (refractor, Prism's grammars as a tree), with the languages
 * agents write most. This module is loaded lazily, the first time a code block shows.
 */

for (const lang of [
  markup,
  css,
  javascript,
  typescript,
  jsx,
  tsx,
  json,
  bash,
  python,
  rust,
  go,
  c,
  cpp,
  csharp,
  java,
  kotlin,
  swift,
  ruby,
  php,
  sql,
  yaml,
  toml,
  ini,
  diff,
  docker,
  graphql,
  markdown,
  scss,
])
  refractor.register(lang);

const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  terminal: "bash",
  py: "python",
  rs: "rust",
  golang: "go",
  yml: "yaml",
  html: "markup",
  xml: "markup",
  svg: "markup",
  md: "markdown",
  "c++": "cpp",
  cs: "csharp",
  kt: "kotlin",
  rb: "ruby",
  dockerfile: "docker",
  jsonc: "json",
  json5: "json",
  patch: "diff",
};

/** A node of the highlighted tree: text, or a span with Prism's token classes. */
export type HlNode = { type: "text"; value: string } | { type: "element"; className: string[]; children: HlNode[] };

/** The grammar name for a fence's language tag, or null if we don't have one. */
export function grammarFor(lang: string): string | null {
  const l = lang.trim().toLowerCase();
  if (!l) return null;
  const name = ALIASES[l] ?? l;
  return refractor.registered(name) ? name : null;
}

/** The code as highlighted nodes, or null for an unknown language. */
export function highlightCode(code: string, lang: string): HlNode[] | null {
  const name = grammarFor(lang);
  if (!name) return null;
  const convert = (n: unknown): HlNode | null => {
    const node = n as { type: string; value?: string; properties?: { className?: unknown }; children?: unknown[] };
    if (node.type === "text") return { type: "text", value: node.value ?? "" };
    if (node.type === "element") {
      const cls = node.properties?.className;
      return {
        type: "element",
        className: Array.isArray(cls) ? cls.map(String) : [],
        children: (node.children ?? []).map(convert).filter((x): x is HlNode => x !== null),
      };
    }
    return null;
  };
  return refractor
    .highlight(code, name)
    .children.map(convert)
    .filter((x): x is HlNode => x !== null);
}
