// scripts/ask.ts
import { connect } from "../src/db/client.ts";
import { fail } from "../src/cli.ts";
import { EMBEDDING_MODEL, EmbeddingFailedError, ollamaEmbedder } from "../src/embed/provider.ts";
import { topK } from "../src/retrieve/search.ts";
import { AGENT_MODEL, ClassifyFailedError, ollamaClassifier } from "../src/agent/classifier.ts";
import { buildGraph } from "../src/agent/graph.ts";

const K = 5;

const question = process.argv.slice(2).join(" ").trim();
if (question === "") {
  fail(`usage: npm run ask "How do I make a query parameter optional?"`);
}

const client = await connect();
try {
  const embedder = ollamaEmbedder();
  const graph = buildGraph({
    classifier: ollamaClassifier(),
    retrieve: async (q) => {
      const vector = await embedder.embedQuery(q);
      const hits = await topK(client, vector, K, EMBEDDING_MODEL);
      return hits.map((h) => ({ id: h.id, score: h.score }));
    },
  });

  const state = await graph.invoke({ question, label: null, sections: [] });

  console.log(`\n${question}`);
  console.log(`  classify: ${state.label}`);

  if (state.sections.length === 0) {
    // Not an abstention message — the graph simply never routed to retrieve.
    console.log(`  out of scope for this corpus, so nothing was retrieved.`);
  } else {
    console.log(`  top ${state.sections.length}:`);
    for (const [i, section] of state.sections.entries()) {
      console.log(`    ${i + 1}. ${section.score.toFixed(3)}  ${section.id}`);
    }
    console.log(`\n  This prints where the answer lives. It does not answer — that is chunk 4.`);
  }
} catch (error) {
  if (error instanceof ClassifyFailedError || error instanceof EmbeddingFailedError) {
    // Not fail(): process.exit() would skip the finally below and leave the
    // Postgres client unclosed. Setting exitCode lets cleanup run and still
    // exits non-zero.
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await client.end();
}
