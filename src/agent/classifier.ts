import { generateObject, type LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { z } from "zod";
import { GOLDEN_TYPES, type GoldenType } from "../evals/golden.ts";
import { ollamaUrl } from "../embed/provider.ts";
import { renderSystem } from "./prompt.ts";

// Pinned by scripts/smoke-classify.ts and recorded in the spec's amendment.
// Never read from the environment: the model is part of what a recorded
// number means, and a number whose model came from an unset variable cannot
// be compared to anything.
export const AGENT_MODEL = "qwen3:8b";
export const TEMPERATURE = 0;

// The labels come from the golden set's own type. A second list here could
// drift from it, and the eval would then report a classification error where
// the defect is a constant.
const schema = z.object({ label: z.enum(GOLDEN_TYPES) });

export class ClassifyFailedError extends Error {}

export interface Classifier {
  readonly model: string;
  classify(question: string): Promise<GoldenType>;
}

// The model is a parameter so the prompt seam is testable without Ollama: a
// stub records the exact messages each call handed the SDK. Same shape as
// embedderWith, which is what closed the prefix hole in chunk 2b.
export function classifierWith(model: LanguageModel): Classifier {
  return {
    model: AGENT_MODEL,

    async classify(question: string): Promise<GoldenType> {
      let last: unknown;
      // One retry, then abort. A model that cannot hold a three-value enum is
      // a model-selection problem to surface, not a datapoint to average away.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const { object } = await generateObject({
            model,
            schema,
            system: renderSystem(),
            prompt: question,
            temperature: TEMPERATURE,
          });
          return object.label;
        } catch (error) {
          last = error;
        }
      }
      const reason = last instanceof Error ? last.message : String(last);
      throw new ClassifyFailedError(
        `Classification failed after 2 attempts for: ${question}\n  ${reason}`,
        { cause: last },
      );
    },
  };
}

export function ollamaClassifier(): Classifier {
  // baseURL needs the /api suffix; OLLAMA_URL does not carry it.
  const provider = createOllama({ baseURL: `${ollamaUrl()}/api` });
  return classifierWith(provider(AGENT_MODEL));
}
