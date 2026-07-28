// backend/utils/resolveLogger.js
import { randomUUID } from "crypto";

export function createResolveLogger(term = "") {
    const id = randomUUID().slice(0, 8);
    const tag = `[catalog-resolve:${id}]${term ? ` "${term}"` : ""}`;
    return {
        id,
        info: (...args) => console.log(tag, ...args),
        warn: (...args) => console.warn(tag, "⚠️", ...args),
        error: (...args) => console.error(tag, "❌", ...args),
    };
}