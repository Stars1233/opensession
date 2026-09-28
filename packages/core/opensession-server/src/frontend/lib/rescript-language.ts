import type { LanguageRegistration } from "shiki/core";
import { z } from "zod";
import rescriptGrammar from "./rescript.tmLanguage.json";

// Shiki does not bundle ReScript, so both the transcript highlighter and the
// diff viewer register this vendored TextMate grammar themselves.

type GrammarRule = LanguageRegistration["patterns"][number];

const grammarRuleSchema: z.ZodType<GrammarRule> = z.lazy(() =>
  z.looseObject({
    include: z.string().optional(),
    name: z.string().optional(),
    contentName: z.string().optional(),
    match: z.union([z.string(), z.instanceof(RegExp)]).optional(),
    captures: z.record(z.string(), grammarRuleSchema).optional(),
    begin: z.union([z.string(), z.instanceof(RegExp)]).optional(),
    beginCaptures: z.record(z.string(), grammarRuleSchema).optional(),
    end: z.union([z.string(), z.instanceof(RegExp)]).optional(),
    endCaptures: z.record(z.string(), grammarRuleSchema).optional(),
    while: z.union([z.string(), z.instanceof(RegExp)]).optional(),
    whileCaptures: z.record(z.string(), grammarRuleSchema).optional(),
    patterns: z.array(grammarRuleSchema).optional(),
    repository: z.record(z.string(), grammarRuleSchema).optional(),
    applyEndPatternLast: z.boolean().optional(),
  }),
);

const languageRegistrationSchema: z.ZodType<LanguageRegistration> =
  z.looseObject({
    name: z.string(),
    scopeName: z.string(),
    patterns: z.array(grammarRuleSchema),
    repository: z.record(z.string(), grammarRuleSchema),
  });

export const rescript = languageRegistrationSchema.parse({
  ...rescriptGrammar,
  name: "rescript",
});
