import fs from "node:fs"
import path from "node:path"
import { Resvg } from "@resvg/resvg-js"

const ROOT = process.cwd()
const OUT_DIR = path.join(ROOT, "public", "og")
fs.mkdirSync(OUT_DIR, { recursive: true })

export const DOMAIN_OG_SPECS = [
  {
    key: "default",
    domain: "",
    eyebrow: "SYSTEMS ENGINEERING · DIGITAL GARDEN",
    title: "汀的知识碎片",
    subtitle: "Linux 内核与性能工程 · 分布式系统 · 云原生 · 可观测性 · AI 沙箱",
    accent: "#c96442",
  },
  {
    key: "linux",
    domain: "Linux",
    eyebrow: "OS & SYSTEMS PERFORMANCE",
    title: "操作系统与底层原理",
    subtitle: "进程调度、虚拟内存、VFS 与 Page Cache、TCP/IP 协议栈与 KVM 性能工程",
    accent: "#c96442",
  },
  {
    key: "golang",
    domain: "Golang",
    eyebrow: "GO RUNTIME & CONCURRENCY",
    title: "Golang 运行时与并发",
    subtitle: "GMP 调度模型、内存分配器、三色 GC、Channel 与语言核心语义",
    accent: "#527a9c",
  },
  {
    key: "java",
    domain: "Java",
    eyebrow: "JVM & CONCURRENT ENGINEERING",
    title: "Java 与 JVM 原理",
    subtitle: "JVM 内存模型、垃圾收集器、AQS 并发原语与 Netty 高性能网络",
    accent: "#bf842e",
  },
  {
    key: "algo",
    domain: "数据结构与算法",
    eyebrow: "ALGORITHMS & PROBLEM SOLVING",
    title: "数据结构与算法",
    subtitle: "数组链表、双指针与滑窗、二叉树遍历、动态规划与图论思维",
    accent: "#5c8c66",
  },
  {
    key: "middleware",
    domain: "中间件",
    eyebrow: "STORAGE & MIDDLEWARE ENGINES",
    title: "中间件与存储引擎",
    subtitle: "MySQL InnoDB、Redis、Kafka、etcd、Ceph、ClickHouse 与 Doris",
    accent: "#c96442",
  },
  {
    key: "distributed",
    domain: "分布式架构",
    eyebrow: "DISTRIBUTED PROTOCOLS & TRADE-OFFS",
    title: "分布式系统与架构",
    subtitle: "Paxos、Raft、ZAB、分布式锁、事务模型与数据密集型系统实战",
    accent: "#7d6ba3",
  },
  {
    key: "bigdata",
    domain: "大数据",
    eyebrow: "COMPUTE ENGINES & LAKEHOUSE",
    title: "大数据与数据湖",
    subtitle: "Spark 内核、Flink 流处理、HDFS/YARN、HBase 与 Iceberg/Paimon",
    accent: "#527a9c",
  },
  {
    key: "cloud-native",
    domain: "云原生",
    eyebrow: "KUBERNETES & CLOUD NETWORKING",
    title: "云原生与容器编排",
    subtitle: "Kubernetes 架构、API Server、调度控制面、CNI 网络与服务网格",
    accent: "#5c8c66",
  },
  {
    key: "observability",
    domain: "可观测",
    eyebrow: "METRICS · LOGS · TRACES · PROFILES",
    title: "可观测性体系",
    subtitle: "VictoriaMetrics、Grafana Loki、SkyWalking、eBPF Profiler 与 AIOps",
    accent: "#bf842e",
  },
  {
    key: "sre",
    domain: "SRE",
    eyebrow: "RELIABILITY & INCIDENT REVIEW",
    title: "SRE 与可靠性工程",
    subtitle: "CVM 集群稳定性工程、大规模生产故障排查与根因复盘方法论",
    accent: "#c45a4b",
  },
  {
    key: "llm",
    domain: "LLM",
    eyebrow: "AI INFRASTRUCTURE & SANDBOXES",
    title: "LLM 与 Agent 基础设施",
    subtitle: "大模型原理、Coding Agent 运行范式、Hermes 与安全沙箱隔离技术",
    accent: "#7d6ba3",
  },
  {
    key: "books",
    domain: "译书",
    eyebrow: "TECHNICAL BOOKS TRANSLATION",
    title: "英文经典译书与精读",
    subtitle: "Systems Performance · DDIA 2nd · Mastering Kubernetes · Software Architecture",
    accent: "#c96442",
  },
]

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function buildOgSvg(spec) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.2" fill="#d3cfc0" opacity="0.65"/>
    </pattern>
    <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#faf9f5"/>
      <stop offset="100%" stop-color="#f2efe5"/>
    </linearGradient>
    <linearGradient id="clayGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ec9677"/>
      <stop offset="100%" stop-color="#c96442"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#dots)"/>

  <!-- Editorial inner frame -->
  <rect x="44" y="44" width="1112" height="542" rx="22" fill="#fdfcf9" fill-opacity="0.88" stroke="#e2dfd3" stroke-width="2"/>
  <rect x="44" y="44" width="1112" height="8" rx="4" fill="${spec.accent}"/>

  <!-- Brand mark top-left -->
  <g transform="translate(96, 102)">
    <rect width="58" height="58" rx="14" fill="#1b1a18"/>
    <rect x="13" y="16.5" width="20" height="5.5" rx="2.75" fill="#faf9f5"/>
    <rect x="20.2" y="20" width="5.5" height="18.5" rx="2.75" fill="#faf9f5"/>
    <rect x="37" y="12" width="8.5" height="8.5" rx="2" transform="rotate(45 41.25 16.25)" fill="url(#clayGrad)"/>
    <path d="M14 44.5 Q29 40.2 44 44.5" stroke="#e58866" stroke-width="2.8" stroke-linecap="round" fill="none"/>
    <text x="76" y="26" font-family="PingFang SC, Hiragino Sans GB, Noto Sans SC, sans-serif" font-size="22" font-weight="700" fill="#141413">汀的知识碎片</text>
    <text x="76" y="50" font-family="Menlo, Monaco, monospace" font-size="15" fill="#6e6c64">ting.is-a.dev</text>
  </g>

  <!-- Eyebrow pill -->
  <g transform="translate(96, 218)">
    <rect width="460" height="34" rx="17" fill="${spec.accent}" fill-opacity="0.12"/>
    <text x="18" y="22" font-family="Menlo, Monaco, sans-serif" font-size="14" font-weight="600" letter-spacing="1.2" fill="${spec.accent}">${esc(spec.eyebrow)}</text>
  </g>

  <!-- Main Title -->
  <text x="96" y="330" font-family="PingFang SC, Songti SC, Hiragino Sans GB, sans-serif" font-size="64" font-weight="700" fill="#141413">${esc(spec.title)}</text>

  <!-- Subtitle -->
  <text x="96" y="395" font-family="PingFang SC, Hiragino Sans GB, sans-serif" font-size="25" fill="#5b5952">${esc(spec.subtitle)}</text>

  <!-- Footer bar -->
  <line x1="96" y1="490" x2="1104" y2="490" stroke="#e7e4d9" stroke-width="1.5"/>
  <text x="96" y="534" font-family="PingFang SC, Hiragino Sans GB, sans-serif" font-size="20" fill="#6e6c64">李浩鹏（汀） · 系统底层原理与生产级工程实践</text>
  <text x="1104" y="534" text-anchor="end" font-family="Menlo, Monaco, sans-serif" font-size="18" fill="${spec.accent}">Astro 5 · Pagefind · Obsidian Vault</text>
</svg>`
}

for (const spec of DOMAIN_OG_SPECS) {
  const svg = buildOgSvg(spec)
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: "PingFang SC",
    },
  })
  const pngBuffer = resvg.render().asPng()
  const outPath = path.join(OUT_DIR, `${spec.key}.png`)
  fs.writeFileSync(outPath, pngBuffer)
}

console.log(`[generate-og] Generated ${DOMAIN_OG_SPECS.length} OG PNGs in public/og/`)
