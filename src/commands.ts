export type FeedbackSentiment = "good" | "fix";

export type PrefCommand =
  | { action: "dashboard" }
  | { action: "remember"; group?: string; rule: string }
  | {
      action: "feedback";
      group?: string;
      sentiment?: FeedbackSentiment;
      reason?: string;
    };

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = pattern.exec(input)) !== null) {
    if (input.slice(consumed, match.index).trim()) {
      throw new Error("invalid /pref syntax");
    }
    tokens.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"'])/g, "$1"));
    consumed = pattern.lastIndex;
  }
  if (input.slice(consumed).trim()) throw new Error("invalid /pref syntax");
  return tokens;
}

interface ParsedOptions {
  group?: string;
  rest: string[];
}

function parseOptions(tokens: string[], action: string): ParsedOptions {
  let group: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--group") {
      if (group !== undefined) throw new Error(`${action} --group can appear only once`);
      const value = tokens[++index];
      if (!value || value.startsWith("--")) throw new Error(`${action} --group requires a value`);
      group = value;
      continue;
    }
    if (token.startsWith("--")) throw new Error(`unknown ${action} flag: ${token}`);
    rest.push(token);
  }
  return { group, rest };
}

export function parsePrefCommand(input: string): PrefCommand {
  const tokens = tokenize(input.trim());
  const action = tokens.shift();
  if (!action) return { action: "dashboard" };

  if (action === "remember") {
    const options = parseOptions(tokens, action);
    const rule = options.rest.join(" ").trim();
    if (!rule) throw new Error("remember requires a rule");
    return options.group === undefined
      ? { action, rule }
      : { action, group: options.group, rule };
  }

  if (action === "feedback") {
    const options = parseOptions(tokens, action);
    const sentimentToken = options.rest.shift();
    if (!sentimentToken) {
      return options.group === undefined
        ? { action }
        : { action, group: options.group };
    }
    if (sentimentToken !== "good" && sentimentToken !== "fix") {
      throw new Error("feedback expects good or fix");
    }
    const reason = options.rest.join(" ").trim() || undefined;
    if (sentimentToken === "fix" && !reason) throw new Error("feedback fix requires a reason");
    return {
      action,
      ...(options.group === undefined ? {} : { group: options.group }),
      sentiment: sentimentToken,
      ...(reason ? { reason } : {}),
    };
  }

  throw new Error(`unknown /pref action: ${action}`);
}

export const preferenceCommandNames = ["remember", "feedback"] as const;
