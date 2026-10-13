import type { ToolDef } from "./registry.js";
import { ToolInputError } from "./profile.js";
import { verifyFileRef } from "../../files/signing.js";
import { resolveFileRef } from "../../files/download.js";
import { UNTRUSTED_NOTE } from "../untrusted.js";

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "tex", "ipynb", "py", "csv", "json", "r", "m", "c",
  "cpp", "java", "js", "ts", "html", "xml", "yml", "yaml", "bib",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function b64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export const fileTools: ToolDef[] = [
  {
    name: "get_file",
    description:
      "Read a Moodle-hosted file by its signed `ref` (from get_course_contents). Text files come " +
      "back as text, PDFs and images as readable attachments; large files return a link only. " +
      "Every result includes a short-lived download link.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "The signed file reference from get_course_contents." },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const token = typeof args["ref"] === "string" ? args["ref"] : "";
      if (!token) throw new ToolInputError("ref is required.");

      const verdict = await verifyFileRef(ctx.env, token);
      if (!verdict.ok) {
        throw new ToolInputError(
          verdict.reason === "expired"
            ? "This file link has expired; fetch course contents again for a fresh one."
            : "Invalid file reference.",
        );
      }

      const resolved = await resolveFileRef(ctx.moodle, verdict.ref);
      const origin = new URL(ctx.request.url).origin;
      const link = `${origin}/files/${token}`;
      const cap = Number(ctx.env.INLINE_FILE_CAP_BYTES) || 10_485_760;

      const header = `File: ${resolved.filename} (${resolved.filesize} bytes)\nDownload link (valid ~15 min): ${link}\n${UNTRUSTED_NOTE}`;

      if (resolved.filesize > cap) {
        return {
          _mcpContent: [
            {
              type: "text",
              text: `${header}\n\nThis file is larger than the inline limit, so only the link is provided.`,
            },
          ],
        };
      }

      const upstream = await ctx.moodle.fetchPluginFile(resolved.path);
      const bytes = new Uint8Array(await upstream.arrayBuffer());
      const ext = extensionOf(resolved.filename);

      if (TEXT_EXTENSIONS.has(ext)) {
        const text = new TextDecoder().decode(bytes);
        return {
          _mcpContent: [{ type: "text", text: `${header}\n\n---\n${text}` }],
        };
      }

      const mime = resolved.mimetype || upstream.headers.get("content-type") || "application/octet-stream";
      return {
        _mcpContent: [
          { type: "text", text: header },
          {
            type: "resource",
            resource: { uri: `moodle://file/${encodeURIComponent(resolved.filename)}`, mimeType: mime, blob: b64(bytes) },
          },
        ],
      };
    },
  },
];
