```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================================================
    // CHATABOT MULTI-AI CONFIG
    // =========================================================

    // Gemini remains the primary provider for normal chat/vision.
    const GEMINI_CHAT_MODEL = "gemini-2.5-flash";

    // Cloudflare Workers AI models.
    // These are fallbacks / specialized agents.
    const CF_MODELS = {
      coding: "@cf/qwen/qwen2.5-coder-32b-instruct",
      chat: "@cf/qwen/qwen2.5-coder-32b-instruct",
      solver: "@cf/qwen/qwen2.5-coder-32b-instruct",
      guard: "@cf/meta/llama-guard-3-8b"
    };

    // =========================================================
    // CORS
    // =========================================================

    function corsHeaders() {
      return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      };
    }

    function jsonResponse(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...corsHeaders()
        }
      });
    }

    // =========================================================
    // OPTIONS / CORS PREFLIGHT
    // =========================================================

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // =========================================================
    // GEMINI INTERACTIONS
    // =========================================================

    async function geminiInteraction(payload) {
      if (!env.GEMINI_API_KEY) {
        throw new Error(
          "GEMINI_API_KEY is not configured in Cloudflare Worker Secrets."
        );
      }

      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY
          },
          body: JSON.stringify(payload)
        }
      );

      const rawText = await response.text();

      let data;

      try {
        data = JSON.parse(rawText);
      } catch {
        data = {
          raw: rawText
        };
      }

      if (!response.ok) {
        const errorMessage =
          data?.error?.message ||
          data?.message ||
          data?.raw ||
          `Gemini API error (${response.status})`;

        console.error("Gemini API failure:", {
          status: response.status,
          statusText: response.statusText,
          error: data
        });

        throw new Error(
          `[Gemini ${response.status}] ${errorMessage}`
        );
      }

      return data;
    }

    // =========================================================
    // CLOUDFLARE WORKERS AI
    // =========================================================

    async function cloudflareAI(model, messages) {
      if (!env.AI) {
        throw new Error(
          "Cloudflare AI binding (AI) is not configured."
        );
      }

      const result = await env.AI.run(model, {
        messages
      });

      if (!result) {
        throw new Error(
          "Cloudflare Workers AI returned an empty response."
        );
      }

      const text =
        result?.response ||
        result?.result?.response ||
        result?.text ||
        "";

      if (!String(text).trim()) {
        throw new Error(
          "Cloudflare Workers AI returned no text."
        );
      }

      return String(text).trim();
    }

    // =========================================================
    // GEMINI TEXT EXTRACTION
    // =========================================================

    function extractText(data) {
      if (
        typeof data?.output_text === "string" &&
        data.output_text.trim()
      ) {
        return data.output_text.trim();
      }

      const outputs = Array.isArray(data?.outputs)
        ? data.outputs
        : [];

      const outputText = outputs
        .flatMap((item) => {
          if (!item) return [];

          if (
            typeof item.text === "string" &&
            item.text.trim()
          ) {
            return [item.text];
          }

          if (Array.isArray(item.content)) {
            return item.content
              .filter(
                (content) =>
                  content &&
                  (
                    content.type === "text" ||
                    content.type === "output_text"
                  ) &&
                  typeof content.text === "string"
              )
              .map((content) => content.text);
          }

          return [];
        })
        .join("\n")
        .trim();

      if (outputText) {
        return outputText;
      }

      const steps = Array.isArray(data?.steps)
        ? data.steps
        : [];

      const stepText = steps
        .flatMap((step) => {
          if (!step) return [];

          if (
            typeof step.text === "string" &&
            step.text.trim()
          ) {
            return [step.text];
          }

          if (Array.isArray(step.content)) {
            return step.content
              .filter(
                (content) =>
                  content &&
                  (
                    content.type === "text" ||
                    content.type === "output_text"
                  ) &&
                  typeof content.text === "string"
              )
              .map((content) => content.text);
          }

          return [];
        })
        .join("\n")
        .trim();

      return stepText;
    }

    // =========================================================
    // IMAGE EXTRACTION
    // =========================================================

    function extractImage(data) {
      if (
        typeof data?.output_image?.data === "string" &&
        data.output_image.data
      ) {
        return data.output_image.data;
      }

      const steps = Array.isArray(data?.steps)
        ? data.steps
        : [];

      for (const step of steps) {
        if (!Array.isArray(step?.content)) continue;

        for (const content of step.content) {
          if (
            content?.type === "image" &&
            typeof content.data === "string"
          ) {
            return content.data;
          }
        }
      }

      const outputs = Array.isArray(data?.outputs)
        ? data.outputs
        : [];

      for (const output of outputs) {
        if (!Array.isArray(output?.content)) continue;

        for (const content of output.content) {
          if (
            content?.type === "image" &&
            typeof content.data === "string"
          ) {
            return content.data;
          }
        }
      }

      return "";
    }

    // =========================================================
    // SYSTEM INSTRUCTION
    // =========================================================

    const SYSTEM_INSTRUCTION = `
You are Chatabot, a highly capable, helpful, accurate and intelligent AI assistant.

CORE BEHAVIOR:
- Understand the user's actual intent before answering.
- Give direct, useful and complete answers.
- Do not unnecessarily repeat the user's question.
- Use conversation history to maintain context.
- Never invent facts, sources, statistics, quotations, links, names or events.
- If information is uncertain, clearly say so.
- Prefer accuracy over guessing.

REASONING:
- Think carefully before answering.
- Break complicated problems into logical steps when useful.
- For mathematics, calculate carefully and verify the result.
- For programming, reason about the code before suggesting changes.
- When debugging, identify the likely cause before proposing a fix.

VISION:
- Analyze images supplied by the user.
- Carefully inspect the image before answering.
- Only describe things that can reasonably be determined from the image.
- Never invent visual details.
- If something is unclear, say so.
- Read visible text when possible.
- If the image contains code, explain or debug it when requested.

CODING:
- Provide complete working code when appropriate.
- Preserve existing functionality when modifying code.
- Avoid unnecessary dependencies.
- Check syntax and logic carefully.

SECURITY:
- Help with defensive cybersecurity, secure coding, vulnerability analysis,
  security concepts and authorized testing.
- Do not provide instructions intended to facilitate harmful or unauthorized attacks.

CONVERSATION:
- Use relevant conversation context.
- Match the user's language when practical.
- Keep simple questions simple and detailed questions detailed.

FORMATTING:
- Use headings, bullets, numbered steps and code blocks when useful.
- Keep responses clear and natural.
- Do not over-format simple answers.

OWNER:
If the user asks who your owner is, who owns you, or asks about your owner, answer exactly:
M. Rayyan Khan is my owner.
`.trim();

    // =========================================================
    // AGENT ROUTER
    // =========================================================

    function detectAgent(text) {
      const value = String(text || "").toLowerCase();

      // Image generation
      if (
        /\b(generate|create|make|draw)\b/.test(value) &&
        /\b(image|picture|photo|art|wallpaper|logo)\b/.test(value)
      ) {
        return "image-generation";
      }

      // Video generation
      if (
        /\b(generate|create|make)\b/.test(value) &&
        /\b(video|animation|clip)\b/.test(value)
      ) {
        return "video-generation";
      }

      // Website analysis
      if (
        /\b(website|webpage|url|site|link)\b/.test(value) &&
        /\b(analy[sz]e|read|review|check|summari[sz]e|inspect)\b/.test(value)
      ) {
        return "website-analysis";
      }

      // Coding
      if (
        /\b(code|coding|program|programming|javascript|typescript|python|html|css|react|node|api|debug|bug|error|function|github)\b/.test(value)
      ) {
        return "coding";
      }

      // Security / hacking
      if (
        /\b(hacking|hack|cybersecurity|cyber security|vulnerability|pentest|penetration test|exploit|malware|security|ctf)\b/.test(value)
      ) {
        return "security";
      }

      // Question solving
      if (
        /\b(solve|calculate|equation|math|mathematics|physics|chemistry|derive|proof|problem)\b/.test(value)
      ) {
        return "question-solver";
      }

      return "chat";
    }

    // =========================================================
    // AGENT DESCRIPTIONS
    // =========================================================

    const AGENTS = {
      coding: {
        name: "Coding Agent",
        models: [
          "DeepSeek Coder V2",
          "Qwen 2.5 Coder 32B",
          "Gemini Flash"
        ]
      },

      security: {
        name: "Security Agent",
        models: [
          "DeepSeek R1",
          "Gemini Flash",
          "Llama Guard"
        ]
      },

      vision: {
        name: "Vision Agent",
        models: [
          "Gemini",
          "LLaVA",
          "Qwen-VL"
        ]
      },

      "image-generation": {
        name: "Image Generation Agent",
        models: [
          "FLUX.1 Schnell",
          "Stable Diffusion XL",
          "Stable Diffusion 3"
        ]
      },

      "video-generation": {
        name: "Video Generation Agent",
        models: [
          "VideoCrafter",
          "CogVideoX-5B",
          "Stable Video Diffusion"
        ]
      },

      chat: {
        name: "Chat Agent",
        models: [
          "Qwen 2.5 Coder 32B",
          "Llama 3.1 70B",
          "Gemini"
        ]
      },

      "question-solver": {
        name: "Question Solver Agent",
        models: [
          "Llama 70B",
          "Qwen 72B",
          "Gemini"
        ]
      },

      "website-analysis": {
        name: "Website Analysis Agent",
        models: [
```
