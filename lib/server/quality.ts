import { characterCount, scriptText, type Content, type Product } from "../contracts";

export type QualityIssue = {
  code: "absolute_claim" | "guaranteed_effect" | "unsupported_number" | "price_claim" | "health_claim" | "unsupported_comparison" | "purchase_pressure" | "hook_too_slow" | "dropped_condition" | "weak_citation";
  severity: "blocking" | "advisory";
  field: string;
  excerpt: string;
  message: string;
};

export type QualityReport = {
  /** True when no blocking issue remains. Advisory issues are still reported. */
  passed: boolean;
  issues: QualityIssue[];
  /** Estimated reading time. It is a calculation, not a measurement of real narration. */
  speech: { charactersPerSecond: number; hookSeconds: number; totalSeconds: number; hookWithinFiveSeconds: boolean };
  evidence: { cited: number; total: number };
  /** Corrections requested from the model. reviewContent reports 0; generateContent sets the real count. */
  revisions: number;
};

/** Typical clear Chinese narration pace. Used only to estimate whether the hook fits five seconds. */
export const SPEECH_CHARACTERS_PER_SECOND = 5;
const PAUSE_SECONDS = 0.18;
const PUNCTUATION = /[，。、；：！？…—,.;:!?"'（）()《》「」]/g;

/** Estimates spoken seconds: syllable characters at a steady pace plus a short pause per punctuation mark. */
export function estimateSpeechSeconds(text: string): number {
  const pauses = (text.match(PUNCTUATION) || []).length;
  const spoken = Array.from(text.replace(PUNCTUATION, "").replace(/\s/g, "")).length;
  return Math.round((spoken / SPEECH_CHARACTERS_PER_SECOND + pauses * PAUSE_SECONDS) * 10) / 10;
}

type Rule = {
  code: QualityIssue["code"];
  severity: QualityIssue["severity"];
  pattern: RegExp;
  message: string;
  /** When set, the phrase is accepted if the product material itself contains the matched term. */
  needsEvidenceTerm?: boolean;
};

// Each rule targets a claim the product page cannot support. Wording that merely repeats a page
// specification stays allowed, so the checker reduces overstatement without erasing real facts.
const RULES: Rule[] = [
  {
    code: "absolute_claim", severity: "blocking",
    pattern: /百分之百|百分百|100\s*%|全网最\S{0,3}|全球最\S{0,3}|世界第一|行业第一|销量第一|唯一一(?:款|个)|绝对(?:安全|可靠|有效|不)|最强\S{0,3}|无敌|完美无缺|零风险|万能/g,
    message: "属于绝对化表述，页面没有可支持的排名或保证，请改为具体、可核对的说法。",
  },
  {
    code: "guaranteed_effect", severity: "blocking",
    pattern: /保证\S{0,6}(?:有效|不|能)|一定(?:能|会|不)|肯定(?:能|会|不)|绝不会|永不(?:损坏|变形|褪色|漏)|再也不(?:用|会|怕)|彻底(?:解决|消除|摆脱|告别)|完全(?:解决|消除|避免)|从此(?:不|告别)/g,
    message: "属于效果承诺，页面信息无法保证结果，请改为“有助于”“可以”等标称式表述。",
  },
  {
    code: "guaranteed_effect", severity: "blocking",
    pattern: /(?:久坐|坐久了|长时间(?:坐|站|使用|佩戴))[^，。；！？]{0,10}(?:也?不累|不痛|不酸|不疲劳|无压力|无负担)|(?:不会|不再|不用担心)(?:累|疲劳|酸痛|闷热|异味|漏水|变形|发烫)/g,
    message: "把页面的舒适性标称说成了不会疲劳或不会出问题，请保留“据页面标称”的程度。",
  },
  {
    code: "unsupported_comparison", severity: "blocking",
    pattern: /比(?:其他|同类|同价位|市面上?|别的)\S{0,6}(?:都|更|好|强)|优于(?:同类|其他|同价位)|吊打|碾压|超越(?:同类|其他)|领先(?:同类|行业)|同类最\S{0,3}/g,
    message: "本次没有采集竞品数据，不能做同类对比，请删除比较级结论。",
  },
  {
    code: "health_claim", severity: "blocking", needsEvidenceTerm: true,
    pattern: /治疗|疗效|治愈|根治|消炎|杀菌|抗菌|除螨|降(?:血压|血糖|血脂)|减肥|瘦身|防癌|抗癌|药用|护肝|助眠/g,
    message: "属于健康或功效宣称，页面材料中没有对应依据，请删除。",
  },
  {
    code: "purchase_pressure", severity: "advisory",
    pattern: /立刻(?:购买|下单|抢)|赶紧(?:买|下单|抢)|马上抢|限时|错过就|不买就|手慢无|冲就完事/g,
    message: "属于催促购买的表述，短视频口播中容易显得夸张，建议改为客观说明。",
  },
];

const FIELD_GROUPS: { key: keyof Pick<Content, "audiences" | "scenarios" | "painPoints" | "sellingPoints">; label: string }[] = [
  { key: "audiences", label: "目标人群" },
  { key: "scenarios", label: "使用场景" },
  { key: "painPoints", label: "用户痛点" },
  { key: "sellingPoints", label: "核心卖点" },
];

function digitsIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)?/g) || []).filter((value) => value.replace(/\D/g, "").length > 0);
}

// A page often states a capability together with a prerequisite: another device, a separate purchase or
// a subscription. Repeating only the capability turns a conditional feature into an unconditional promise,
// which is the most common factual error in this kind of copy.
// Only unambiguous prerequisite wording is matched. Loose phrasing such as "need a bigger sound?" appears
// in marketing questions and must not be treated as a condition.
const CONDITION_IN_EVIDENCE = /\b(requires?|required|sold separately|not included|subscription required|requires? a subscription|with a compatible [a-z ]{3,30}|compatible \w+ (?:network|device|hub|router|speaker)|additional purchase|separate purchase)\b|需(?:要另|单独|另)购|另行购买|不含[^，。]{0,8}|需订阅|需配合[^，。]{0,10}使用/i;
const CONDITION_IN_CLAIM = /需要|需先|需配合|需另|另购|单独购买|不含|订阅|前提|搭配|兼容的|兼容设备|已有|若已|如果已/;

/** Identity fields are routinely cited for naming the product, so they are not judged for conditions or overlap. */
const IDENTITY_LABELS = new Set(["商品名称", "品牌", "品类", "当前型号", "可选型号数量", "页面价格"]);

/** Extracts comparable terms: CJK bigrams plus latin/number words, used for loose overlap checks. */
function terms(text: string): Set<string> {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const word of lower.match(/[a-z][a-z0-9+.-]{2,}|\d+(?:[.,]\d+)?/g) || []) found.add(word);
  const han = Array.from(lower.match(/\p{Script=Han}+/gu)?.join("") ?? "");
  for (let index = 0; index + 1 < han.length; index++) found.add(han[index] + han[index + 1]);
  return found;
}

const STOP_TERMS = new Set(["the", "and", "for", "with", "you", "your", "this", "that", "amazon", "inch", "more", "can", "will", "all", "new", "one", "use", "used", "using", "from", "into", "out", "not", "our", "its"]);

function overlapCount(claim: Set<string>, evidence: Set<string>): number {
  let count = 0;
  for (const term of claim) if (!STOP_TERMS.has(term) && evidence.has(term)) count++;
  return count;
}

/**
 * Reviews generated text against the collected product material.
 * The checker only judges wording that the material cannot support; it never rewrites the model output.
 */
export function reviewContent(content: Content, product: Product): QualityReport {
  const issues: QualityIssue[] = [];
  const material = [product.title, ...product.evidence.map((fact) => `${fact.label} ${fact.value}`)].join("\n");
  const materialLower = material.toLowerCase();
  const materialDigits = new Set(digitsIn(material));
  const byId = new Map(product.evidence.map((fact) => [fact.id, fact]));

  const scan = (field: string, text: string) => {
    for (const rule of RULES) {
      for (const match of text.match(rule.pattern) || []) {
        if (rule.needsEvidenceTerm && materialLower.includes(match.toLowerCase())) continue;
        issues.push({ code: rule.code, severity: rule.severity, field, excerpt: match, message: rule.message });
      }
    }
    for (const number of digitsIn(text)) {
      if (!materialDigits.has(number)) {
        issues.push({
          code: "unsupported_number", severity: "blocking", field, excerpt: number,
          message: "这个数字没有出现在本次采集的商品材料中，请删除或改用材料中的原始数值。",
        });
      }
    }
    if (!product.price && /[$￥€£]|价格|售价|多少钱|优惠|折扣|便宜|性价比|划算|预算内|不到\d/.test(text)) {
      issues.push({
        code: "price_claim", severity: "blocking", field,
        excerpt: text.match(/[$￥€£]|价格|售价|多少钱|优惠|折扣|便宜|性价比|划算|预算内/)?.[0] || "价格",
        message: "本次未取得页面价格，不能提及价格、优惠或性价比结论。",
      });
    }
  };

  /** Checks a claim against the evidence it cites: dropped prerequisites and wholly unrelated citations. */
  const reportedConditions = new Set<string>();
  const checkCitations = (field: string, text: string, evidenceIds: string[]) => {
    const claimTerms = terms(text);
    const cited = evidenceIds.map((id) => byId.get(id)).filter((fact): fact is NonNullable<typeof fact> => Boolean(fact));
    const judged = cited.filter((fact) => !IDENTITY_LABELS.has(fact.label));
    for (const fact of judged) {
      const condition = fact.value.match(CONDITION_IN_EVIDENCE)?.[0]?.trim();
      if (condition && !CONDITION_IN_CLAIM.test(text) && !reportedConditions.has(`${fact.id}|${condition}`)) {
        reportedConditions.add(`${fact.id}|${condition}`);
        issues.push({
          code: "dropped_condition", severity: "blocking", field, excerpt: condition,
          message: `依据 ${fact.id} 里这项能力带有前提条件，文案没有体现，会让人以为无条件可用。请补上条件或改写这句。`,
        });
      }
    }
    // Chinese copy legitimately paraphrases English page text, so a single non-overlapping citation proves
    // nothing. Only a claim whose every citation shares no term at all is worth questioning.
    if (judged.length > 0 && judged.every((fact) => overlapCount(claimTerms, terms(`${fact.label} ${fact.value}`)) === 0)) {
      issues.push({
        code: "weak_citation", severity: "advisory", field, excerpt: judged.map((fact) => fact.id).join(" "),
        message: "这句话与它引用的全部依据都没有可对应的共同内容，请确认引用编号是否正确。",
      });
    }
  };

  for (const group of FIELD_GROUPS) {
    content[group.key].forEach((point, index) => {
      scan(`${group.label} ${index + 1} · 标题`, point.title);
      scan(`${group.label} ${index + 1} · 说明`, point.description);
      checkCitations(`${group.label} ${index + 1}`, `${point.title} ${point.description}`, point.evidenceIds);
    });
  }
  scan("口播 · 钩子", content.script.hook);
  scan("口播 · 正文", content.script.body);
  checkCitations("口播", scriptText(content.script), content.script.evidenceIds);

  const hookSeconds = estimateSpeechSeconds(content.script.hook);
  const totalSeconds = estimateSpeechSeconds(scriptText(content.script));
  if (hookSeconds > 5) {
    issues.push({
      code: "hook_too_slow", severity: "advisory", field: "口播 · 钩子", excerpt: `约 ${hookSeconds} 秒`,
      message: `按每秒 ${SPEECH_CHARACTERS_PER_SECOND} 字估算，钩子超过 5 秒，建议再精简；实际时长以真人语速为准。`,
    });
  }

  const cited = new Set([
    ...FIELD_GROUPS.flatMap((group) => content[group.key].flatMap((point) => point.evidenceIds)),
    ...content.script.evidenceIds,
  ]);
  return {
    passed: !issues.some((issue) => issue.severity === "blocking"),
    issues,
    speech: { charactersPerSecond: SPEECH_CHARACTERS_PER_SECOND, hookSeconds, totalSeconds, hookWithinFiveSeconds: hookSeconds <= 5 },
    evidence: { cited: cited.size, total: product.evidence.length },
    revisions: 0,
  };
}

/** Builds a correction request that names each blocking issue without suggesting new facts. */
export function blockingIssueInstruction(report: QualityReport, content: Content): string {
  const blocking = report.issues.filter((issue) => issue.severity === "blocking").slice(0, 8);
  const lines = blocking.map((issue) => `- ${issue.field}：“${issue.excerpt}” ${issue.message}`).join("\n");
  return `上次输出通过了结构校验，但内容质量检查发现以下问题：\n${lines}\n`
    + `请只修改这些表述，保留其余内容、原有事实与证据编号，不要添加新事实或新数字。`
    + `钩子仍需 20 字以内，钩子加正文合计不超过 150 个字符（当前 ${characterCount(scriptText(content.script))} 字）。返回完整 JSON。`;
}
