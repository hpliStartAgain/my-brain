const DOMAIN_OG_MAP: Record<string, string> = {
  Linux: "/og/linux.png",
  Golang: "/og/golang.png",
  Java: "/og/java.png",
  数据结构与算法: "/og/algo.png",
  中间件: "/og/middleware.png",
  分布式架构: "/og/distributed.png",
  大数据: "/og/bigdata.png",
  云原生: "/og/cloud-native.png",
  可观测: "/og/observability.png",
  SRE: "/og/sre.png",
  LLM: "/og/llm.png",
  译书: "/og/books.png",
}

export function getOgImageForDomain(domain?: string): string {
  if (domain && domain in DOMAIN_OG_MAP) {
    return DOMAIN_OG_MAP[domain]
  }
  return "/og/default.png"
}
