import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const EMBED_MODEL = "text-embedding-3-small";

export async function embedTexts(texts) {
    const res = await openai.embeddings.create({ model: EMBED_MODEL, input: texts });
    return res.data.map((d) => d.embedding);
}

export async function embedText(text) {
    const [embedding] = await embedTexts([text]);
    return embedding;
}