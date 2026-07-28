// backend/services/embeddings.service.js
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// text-embedding-3-small: 1536 dims, a small fraction of the cost of any
// chat model — cheap enough to call on every search without worrying about it.
const EMBED_MODEL = "text-embedding-3-small";

export async function embedText(text) {
    const res = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
    return res.data[0].embedding;
}