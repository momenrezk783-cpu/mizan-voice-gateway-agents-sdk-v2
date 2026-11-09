export type CallerGender = "male" | "female" | "unknown";

export interface PersonTitleContext {
  role?: "caller" | "manager";
  callerName?: string | null;
  callerTitle?: string | null;
  callerGender?: CallerGender;
}

export interface ConversationTurn {
  idx: number;
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export interface ConversationState {
  callId: string;
  tenantId: string;
  caller: {
    phone: string;
    name?: string;
    title?: string;
    gender: CallerGender;
    isReturning: boolean;
  };
  transcript: ConversationTurn[];
  outcome?: "completed" | "caller_hung_up" | "error";
}

const TITLES = [
  "دكتورة", "دكتوره", "دكتور", "باشمهندسة", "باشمهندسه",
  "باشمهندس", "مهندسة", "مهندسه", "مهندس", "أستاذة",
  "أستاذه", "استاذة", "استاذه", "أستاذ", "استاذ", "مستر",
  "كابتن", "شيخ"
] as const;

function canonicalTitle(value: string | null | undefined): string | null {
  const title = String(value ?? "").trim().replace(/^ال/u, "");
  if (/^دكتورة?$|^دكتوره$/u.test(title)) return title.includes("ة") || title === "دكتوره" ? "دكتورة" : "دكتور";
  if (/^(باش)?مهندس$/u.test(title)) return title.startsWith("باش") ? "باشمهندس" : "مهندس";
  if (/^(باش)?مهندسة$|^(باش)?مهندسه$/u.test(title)) return title.startsWith("باش") ? "باشمهندسة" : "مهندسة";
  if (/^(أستاذة|أستاذه|استاذة|استاذه)$/u.test(title)) return "أستاذة";
  if (/^(أستاذ|استاذ)$/u.test(title)) return "أستاذ";
  if (title === "مستر" || title === "كابتن" || title === "شيخ") return title;
  return null;
}

function inferGender(title: string | null, fallback: CallerGender = "unknown"): CallerGender {
  if (title && /دكتورة|مهندسة|أستاذة/u.test(title)) return "female";
  if (title && /دكتور|مهندس|أستاذ|مستر|كابتن|شيخ/u.test(title)) return "male";
  return fallback;
}

export function extractCallerTitleAndName(
  utterance: string,
  existing: PersonTitleContext = {}
): { title: string | null; name: string | null; gender: CallerGender } {
  const result = {
    title: existing.callerTitle ?? null,
    name: existing.callerName ?? null,
    gender: existing.callerGender ?? "unknown" as CallerGender
  };
  const text = String(utterance ?? "").trim();
  if (!text) return result;

  const titles = TITLES.join("|");
  const match = text.match(new RegExp(
    String.raw`(?:^|\s)(?:أنا|انا|معاك|معاكي|كلامك مع|بتكلمك)\s+(?:ال)?(${titles})(?:\s+([\u0621-\u064A]{2,18}))?`,
    "u"
  ));
  if (match) {
    const title = canonicalTitle(match[1]);
    const name = match[2]?.replace(/[،,.\\s!?؟]+/gu, "") || null;
    if (title) result.title = title;
    if (name && !/^(في|من|على|عن|العيادة|الشركة|المكتب)$/u.test(name)) result.name ||= name;
    result.gender = inferGender(result.title, result.gender);
  }
  return result;
}

export function resolvePersonAddressPolicy(context: PersonTitleContext = {}): {
  gender: CallerGender;
  preferredAddress: string;
  canonicalTitle: string | null;
  firstName: string | null;
} {
  const firstName = String(context.callerName ?? "").trim().split(/\s+/)[0] || null;
  const title = canonicalTitle(context.callerTitle);
  const gender = inferGender(title, context.callerGender ?? "unknown");
  const preferredAddress = context.role === "manager"
    ? `يا مستر ${firstName || "مؤمن"}`
    : title && firstName
      ? `يا ${title} ${firstName}`
      : title
        ? `يا ${title}`
        : firstName
          ? `يا ${firstName}`
          : gender === "female"
            ? "ضمير المخاطب المباشر (إنتي / معاكي / ليكي) بدون ألقاب"
            : "ضمير المخاطب المباشر (إنت / معاك / ليك) بدون ألقاب";
  return { gender, preferredAddress, canonicalTitle: title, firstName };
}

const BANNED_PATTERNS = [
  /يا\s*فندم/gu, /يا\s*أفندم/gu, /يا\s*افندم/gu,
  /(?:^|[\s،,.!؟])(?:فندم|أفندم|افندم)(?=$|[\s،,.!؟])/gu,
  /حضرتك/gu, /سيادتك/gu, /سعادتك/gu,
  /يا\s*(?:باشا|بيه|بك|هانم|معلم|زعيم|غالي|ريس)(?=$|[\s،,.!؟])/gu,
  /طال\s*عمرك/gu, /تحت\s*أمرك/gu, /أؤمرني/gu
];

const NON_EGYPTIAN_MARKERS = [
  "شلونك", "وش تبي", "ابتغي", "هلا والله", "يعطيك العافية",
  "تكرم عينك", "شو بدك", "كيفك", "هلق", "هلأ", "حياك الله",
  "طال عمرك", "ماذا تريد", "كيف يمكنني مساعدتك", "يرجى الانتظار",
  "سوف أقوم", "حسناً"
];

export function containsBannedAddress(text: string, context: PersonTitleContext = {}): boolean {
  const value = String(text ?? "");
  if (BANNED_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(value))) return true;

  const allowed = resolvePersonAddressPolicy(context);
  const titles = TITLES.join("|");
  const vocative = new RegExp(`يا\\s+(${titles})(?:\\s+([\\u0621-\\u064A]{2,18}))?`, "gu");
  for (const match of value.matchAll(vocative)) {
    const normalized = canonicalTitle(match[1]);
    if (!allowed.canonicalTitle || normalized !== allowed.canonicalTitle) return true;
    if (allowed.firstName && match[2] && match[2] !== allowed.firstName) return true;
  }
  return false;
}

export function detectNonEgyptian(text: string): string[] {
  const value = String(text ?? "");
  return NON_EGYPTIAN_MARKERS.filter((marker) => value.includes(marker));
}

export function sanitizeForSpeech(raw: string, context: PersonTitleContext = {}): string {
  let value = String(raw ?? "");
  if (!value) return "";

  const policy = resolvePersonAddressPolicy(context);
  const feminine = policy.gender === "female";
  value = value
    .replace(/\*([^*]*)\*/gu, "$1")
    .replace(/\[[^\]]*\]/gu, "")
    .replace(/\([^)]*(?:ضحك|تنهد|صمت|نبرة|بهدوء|بحماس|pause|laugh|sigh)[^)]*\)/giu, "")
    .replace(/[#_`~>]/gu, "");

  let usedPreferredAddress = false;
  value = value.replace(/يا\s*(?:فندم|أفندم|افندم)([،,]?)/gu, (_match, punctuation: string) => {
    if (policy.firstName && !usedPreferredAddress) {
      usedPreferredAddress = true;
      return policy.preferredAddress + (punctuation || "");
    }
    return "";
  });
  value = value
    .replace(/مع\s+حضرتك/gu, feminine ? "معاكي" : "معاك")
    .replace(/لحضرتك/gu, feminine ? "ليكي" : "ليك")
    .replace(/بحضرتك/gu, feminine ? "بيكي" : "بيك")
    .replace(/عن\s+حضرتك/gu, "عنك")
    .replace(/من\s+حضرتك/gu, "منك")
    .replace(/حضرتك/gu, feminine ? "إنتي" : "إنت")
    .replace(/سيادتك|سعادتك/gu, feminine ? "إنتي" : "إنت")
    .replace(/(?:^|[\s،,.!؟])(?:فندم|أفندم|افندم)\s*[،,]?/gu, " ");

  const vocative = new RegExp(`يا\\s+(دكتورة|دكتوره|دكتور|باشمهندسة|باشمهندسه|باشمهندس|مهندسة|مهندسه|مهندس|أستاذة|أستاذه|استاذة|استاذه|أستاذ|استاذ|مستر|كابتن|شيخ)(?:\\s+([\\u0621-\\u064A]{2,18}))?`, "gu");
  value = value.replace(vocative, (_match, rawTitle: string, rawName?: string) => {
    const title = canonicalTitle(rawTitle);
    const titleMatches = title && policy.canonicalTitle === title;
    const nameMatches = !policy.firstName || !rawName || rawName === policy.firstName;
    if (titleMatches && nameMatches) return `يا ${title}${rawName ? ` ${rawName}` : ""}`;
    if (rawName && (!policy.firstName || rawName === policy.firstName)) return `يا ${rawName}`;
    return "";
  });

  return value.replace(/[ \\t]{2,}/gu, " ").replace(/\\s+([،,.!?؟])/gu, "$1").trim();
}
