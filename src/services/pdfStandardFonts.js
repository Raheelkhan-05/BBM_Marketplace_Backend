// backend/services/fileImport/pdfStandardFonts.js
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// pdfjs-dist ships its standard (base14) font metrics as a folder of
// files separate from the main package — without pointing at it, pdf.js
// falls back to approximate glyph widths for PDFs that reference base14
// fonts without embedding them. That's a silent accuracy hit on exactly
// the x-position data our row-clustering and column logic depends on.
const pdfDistPackageJson = require.resolve("pdfjs-dist/package.json");
export const STANDARD_FONT_DATA_URL = pdfDistPackageJson.replace(/package\.json$/, "standard_fonts/");