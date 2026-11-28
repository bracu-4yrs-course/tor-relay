/**
 * Provider allowlist for tor-relay.
 *
 * The original tor-relay only shipped with chat.z.ai + api.ipify.org.
 * The user asked to "add vertex and other" — so this module grows the
 * allowlist to cover the major AI provider endpoints, plus a few test
 * hosts. Each host is bucketed into a "provider" so the dashboard can
 * group / filter / count by provider.
 *
 * Volcengine Ark / BytePlus ModelArk was added on request ("modelark") so
 * ModelArk API traffic can ride the relay — e.g. from NovaGate deployed on
 * Cloudflare Workers via its relay egress lane.
 */

export type Provider = {
  id: string;
  name: string;
  color: string; // tailwind classes for badges / dots
  description: string;
  hosts: string[];
};

export const PROVIDERS: Provider[] = [
  {
    id: "vertex",
    name: "Vertex AI",
    color:
      "bg-blue-500/15 text-blue-300 border-blue-500/30",
    description:
      "Google Cloud Vertex AI — model streaming, embeddings, and the OAuth exchange endpoint.",
    hosts: [
      "us-central1-aiplatform.googleapis.com",
      "europe-west1-aiplatform.googleapis.com",
      "asia-northeast1-aiplatform.googleapis.com",
      "cloudconsole-pa.clients6.google.com",
    ],
  },
  {
    id: "gemini",
    name: "Gemini API",
    color:
      "bg-amber-500/15 text-amber-300 border-amber-500/30",
    description:
      "Google AI Studio / Gemini Developer API (generativelanguage).",
    hosts: ["generativelanguage.googleapis.com"],
  },
  {
    id: "openai",
    name: "OpenAI",
    color:
      "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    description: "OpenAI public API (Chat, Responses, Embeddings).",
    hosts: ["api.openai.com"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    color:
      "bg-orange-500/15 text-orange-300 border-orange-500/30",
    description: "Anthropic Claude public API.",
    hosts: ["api.anthropic.com"],
  },
  {
    id: "zai",
    name: "Z.ai",
    color:
      "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
    description: "Z.ai chat / GLM API surface.",
    hosts: ["chat.z.ai"],
  },
  {
    id: "chatglm",
    name: "ChatGLM",
    color:
      "bg-sky-500/15 text-sky-300 border-sky-500/30",
    description:
      "Zhipu ChatGLM web-chat surface (chatglm.cn) — the glm2api native upstream. Rides the same fresh-exit-per-request Tor path as every other provider.",
    hosts: ["chatglm.cn"],
  },
  {
    id: "modelark",
    name: "ModelArk",
    color:
      "bg-rose-500/15 text-rose-300 border-rose-500/30",
    description:
      "Volcengine Ark / BytePlus ModelArk — OpenAI-compatible model endpoints (doubao + friends). China: ark.cn-beijing.volces.com, international: ark.ap-southeast.bytepluses.com. Riding the relay gives these API calls a fresh Tor exit per request.",
    hosts: [
      "ark.cn-beijing.volces.com",
      "ark.ap-southeast.bytepluses.com",
    ],
  },
  {
    id: "baidu",
    name: "Baidu Qianfan",
    color:
      "bg-red-500/15 text-red-300 border-red-500/30",
    description:
      "Baidu AI Cloud experience / Qianfan guest lane (cloud.baidu.com/api/qianfan/completions) — the reversed free-tier wire NovaGate rides as its baidu/* provider. Fresh Tor exit per request.",
    hosts: ["cloud.baidu.com"],
  },
  {
    id: "ipify",
    name: "ipify (probe)",
    color:
      "bg-violet-500/15 text-violet-300 border-violet-500/30",
    description:
      "Public echo service used to probe the current Tor exit IP. Always allowed.",
    hosts: ["api.ipify.org"],
  },
  {
    id: "test",
    name: "test",
    color:
      "bg-slate-500/15 text-slate-300 border-slate-500/30",
    description: "Test / canary hosts for traffic generation.",
    hosts: ["example.com", "www.google.com"],
  },
];

export const ALLOWED_HOSTS = new Set<string>(
  PROVIDERS.flatMap((p) => p.hosts.map((h) => h.toLowerCase())),
);

export function providerForHost(host: string | null): Provider | undefined {
  if (!host) return undefined;
  const h = host.toLowerCase();
  return PROVIDERS.find((p) => p.hosts.some((x) => x.toLowerCase() === h));
}

export function isAllowed(host: string | null): boolean {
  if (!host) return false;
  return ALLOWED_HOSTS.has(host.toLowerCase());
}

export function providersSummary(): Array<{
  id: string;
  name: string;
  color: string;
  description: string;
  hostCount: number;
  hosts: string[];
}> {
  return PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    description: p.description,
    hostCount: p.hosts.length,
    hosts: [...p.hosts],
  }));
}
