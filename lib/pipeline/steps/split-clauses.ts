export interface Clause {
  id: string;
  text: string;
  flags?: string[];
}

const headingRegexes = [
  /^(Article|Section|Clause)\s+\d+/i,
  /^\d+\.\d+[\.\d]*\s/,
  /^제\s*\d+\s*조/,
  /^[A-Z]\.\s/,
  /^\d+\)\s/,
  /^[가-힣]\.\s/,
  /^Part\s+[IVX]+/i,
];

const isHeading = (line: string) =>
  headingRegexes.some((re) => re.test(line.trim()));

function regexSplitClauses(text: string): Clause[] {
  const lines = text.split(/\r?\n/);
  const clauses: Clause[] = [];
  let currentTitle: string | undefined;
  let currentBody: string[] = [];

  const flush = () => {
    if (currentBody.length === 0) return;
    const bodyText = currentBody.join("\n").trim();
    if (!bodyText) {
      currentBody = [];
      return;
    }
    clauses.push({
      id: `clause-${clauses.length + 1}`,
      text: currentTitle ? `${currentTitle}\n${bodyText}` : bodyText,
    });
    currentBody = [];
    currentTitle = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      currentBody.push(rawLine);
      continue;
    }
    if (isHeading(line)) {
      flush();
      currentTitle = line.trim();
    } else {
      currentBody.push(rawLine);
    }
  }
  flush();

  if (clauses.length === 0) {
    return [
      {
        id: "clause-1",
        text: text.trim(),
        flags: ["auto_split", "needs_review"],
      },
    ];
  }

  return clauses;
}

async function gemmaVerifySplit(
  clauses: Clause[]
): Promise<{ verified: boolean; issues?: string }> {
  try {
    const { callGemmaJson } = await import("../../gemini");
    const { canCall } = await import("../../quota-manager");

    if (!(await canCall("gemma12b"))) return { verified: true };

    const summary = clauses
      .slice(0, 10)
      .map((c, i) => `${i + 1}. ${c.text.slice(0, 40)}`)
      .join("\n");

    const result = await callGemmaJson<{
      correct?: boolean;
      issues?: string;
    }>({
      modelKey: "gemma12b",
      prompt: `Verify clause split quality. ${clauses.length} clauses found. First 10 previews below. Reply JSON: {"correct":true/false,"issues":"...or null"}`,
      inputText: summary,
    });

    return {
      verified: result.correct !== false,
      issues: result.issues || undefined,
    };
  } catch {
    return { verified: true };
  }
}

export async function splitClauses(text: string): Promise<Clause[]> {
  const clauses = regexSplitClauses(text);

  if (clauses.length >= 3 && clauses.length <= 500) {
    const verification = await gemmaVerifySplit(clauses);
    if (!verification.verified) {
      for (const clause of clauses) {
        clause.flags = [...(clause.flags ?? []), "gemma_review_suggested"];
      }
    }
  }

  return clauses;
}

export { regexSplitClauses };
