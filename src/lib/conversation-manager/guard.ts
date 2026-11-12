// ============================================================================
// Mizan Conversation Manager — Output Guard, Title Policy & Speech Chunker
// ============================================================================
// Deterministic safeguard between the LLM and ElevenLabs TTS.
// Combines Mizan Voice Gateway's caller title/gender policy with the archive's
// diacritic-insensitive honorific sanitizer, MSA detector, SpeechChunker, and
// unconfirmed-action claim blocker. Pure TypeScript (no Workers runtime APIs).
// ============================================================================

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
  state?: string;
  interrupted?: boolean;
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
  outcome?: "completed" | "caller_hung_up" | "handoff" | "error";
  intentId?: string | null;
  intentResolved?: boolean;
  handedOff?: boolean;
  honorificHits?: number;
  msaHits?: number;
  llmErrors?: number;
}

export interface SanitizeResult {
  text: string;
  violations: string[];
}

// Arabic letters only (excludes punctuation like ، U+060C, harakat, digits).
// \b does not work for Arabic, so we use explicit Arabic letter lookarounds.
const AR = "\\u0621-\\u063A\\u0641-\\u064A\\u0671-\\u06D3";
const L = `(?<![${AR}])`;
const R = `(?![${AR}])`;
const re = (src: string) => new RegExp(src, "gu");

const MARKS = /[\u064B-\u065F\u0670\u0640]/gu; // harakat + tatweel
export const stripMarks = (s: string): string => String(s ?? "").replace(MARKS, "");

const norm = (s: string): string =>
  stripMarks(s)
    .replace(/[أإآ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ة/gu, "ه");

const TITLES = [
  "دكتورة", "دكتوره", "دكتور", "باشمهندسة", "باشمهندسه",
  "باشمهندس", "مهندسة", "مهندسه", "مهندس", "أستاذة",
  "أستاذه", "استاذة", "استاذه", "أستاذ", "استاذ", "مستر",
  "كابتن", "شيخ"
] as const;

// Procedural / filler words that must never be mistaken for a caller's name (REG-03 / REG-04)
const NON_NAME_WORDS = new Set([
  "في", "من", "على", "عن", "العيادة", "الشركة", "المكتب", "معاك", "معاكي",
  "عايز", "عايزة", "عاوز", "عاوزة", "محتاج", "محتاجة", "بحجز", "احجز",
  "أحجز", "اكتبهم", "أكتبهم", "اقولهم", "أقولهم", "سامعني", "سامعاني",
  "الو", "آلو", "ألو", "ايوه", "أيوه", "تمام", "ماشي", "طيب", "شكرا", "شكراً",
  "عندي", "عندنا", "شغال", "شغالة", "موجود", "موجودة", "كويس", "كويسة",
  "مش", "بس", "كنت", "عاوزه", "هنا", "بقول", "بكلمك", "حابب", "حابة", "اسمي", "إسمي",
  "معاكم", "معاكو", "معانا", "اسمى", "اسمك", "الخير", "أهلا", "اهلا", "بيك", "يا", "ميزان", "المساعد", "اتفضل", "تفضل", "نعم", "لا", "حلو", "إزيك", "ازيك", "أنا", "انا", "حضرتك",
  "unknown", "undefined", "null", "caller", "user", "hello", "hi", "yes", "okay", "ok"
]);
const ORDINARY_VOCATIVES=new Set(["ريت","سلام","رب","ترى"]);

/** A context field is not evidence that a greeting/filler word is a name. */
function verifiedFirstName(value: unknown): string | null {
  const word=stripMarks(typeof value === "string" ? value : "").trim().split(/\s+/u)[0];
  return word && /^[\p{L}][\p{L}'’-]{1,39}$/u.test(word) && !NON_NAME_WORDS.has(word.toLowerCase()) && !canonicalTitle(word) ? word : null;
}

export function isProceduralPhrase(text: string): boolean {
  const cleaned = stripMarks(String(text ?? "")).trim();
  if (!cleaned) return true;
  if (/(?:اكتبهم\s+ولا\s+[أا]قولهم|[أا]قولهم\s+ولا\s+اكتبهم|سامعني|سامعاني|الصوت\s+واضح|ألو\s+ألو|آلو\s+سامعني)/iu.test(cleaned)) {
    return true;
  }
  if (/^(?:(?:okay|ok|go ahead|hello|hi|yes|no|sure|test|testing)[\s.!?,]*)+$/iu.test(cleaned)) {
    return true;
  }
  if (/[؟?]/u.test(cleaned)) {
    return true;
  }
  return false;
}

function canonicalTitle(value: string | null | undefined): string | null {
  const title = stripMarks(String(value ?? "")).trim().replace(/^ال/u, "");
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
  existing: PersonTitleContext = {},
  nameRequested = false
): { title: string | null; name: string | null; gender: CallerGender } {
  const result = {
    title: existing.callerTitle ?? null,
    name: verifiedFirstName(existing.callerName),
    gender: existing.callerGender ?? ("unknown" as CallerGender)
  };
  const text = stripMarks(String(utterance ?? "")).trim();
  if (!text) return result;

  // Detect explicit gender markers in caller self-reference
  if (result.gender === "unknown") {
    if (/(?:^|\s)(?:أنا|انا)\s+(?:عايزة|عاوزة|محتاجة|كنت\s+عايزة)/u.test(text)) {
      result.gender = "female";
    } else if (/(?:^|\s)(?:أنا|انا)\s+(?:عايز|عاوز|محتاج|كنت\s+عايز)/u.test(text)) {
      result.gender = "male";
    }
  }

  const titles = TITLES.join("|");
  const titleMatch = text.match(new RegExp(
    String.raw`(?:^|\s)(?:أنا|انا|معاك|معاكي|كلامك مع|بتكلمك|اسمي)\s+(?:ال)?(${titles})(?:\s+([\u0621-\u064A]{2,18})(?:\s+([\u0621-\u064A]{2,18}))?)?`,
    "u"
  ));
  if (titleMatch) {
    const title = canonicalTitle(titleMatch[1]);
    const first = titleMatch[2]?.replace(/[،,.\s!?؟]+/gu, "") || null;
    if (title) result.title = title;
    if (first && !NON_NAME_WORDS.has(first)) {
      result.name = first;
    }
    result.gender = inferGender(result.title, result.gender);
    return result;
  }

  // Explicit introductions and corrections replace an earlier name. A bare
  // response is identity only after the assistant actually requested a name.
  const nameMatch = text.match(/(?:^|\s)(?:أنا\s+اسمي|انا\s+اسمي|اسمي|إسمي)\s+([\u0621-\u064A]{2,18})/u)
    ?? text.match(/(?:^|\s)(?:أنا|انا|معاك|معاكي)\s+([\u0621-\u064A]{2,18})/u);
  if (nameMatch) {
    const first = nameMatch[1]?.replace(/[،,.\s!?؟]+/gu, "") || null;
    if (first && !NON_NAME_WORDS.has(first)) {
      result.name = first;
    }
  } else if (nameRequested && !isProceduralPhrase(text)) {
    const bare = text.replace(/[،,.!]+$/gu, "").trim();
    const words = bare.split(/\s+/u);
    if (words.length <= 3 && words.every(word => /^[\u0621-\u064A]{2,18}$/u.test(word) && !NON_NAME_WORDS.has(word))) {
      result.name = words[0];
    }
  }

  return result;
}

export function resolvePersonAddressPolicy(context: PersonTitleContext = {}): {
  gender: CallerGender;
  preferredAddress: string;
  canonicalTitle: string | null;
  firstName: string | null;
} {
  const firstName = verifiedFirstName(context.callerName);
  const title = canonicalTitle(context.callerTitle);
  const gender = inferGender(title, context.callerGender ?? "unknown");
  const preferredAddress = title && firstName
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
  re(`${L}يا\\s*(?:أ|ا)?فندم${R}`),
  re(`${L}(?:أ|ا)?فندم${R}`),
  re(`${L}([وف]?)حضرتك(?:م)?${R}`),
  re(`${L}[لب]حضرتك(?:م)?${R}`),
  re(`${L}([وف]?)(?:سيادتك|سعادتك|سيادتكم|سعادتكم)${R}`),
  re(`${L}يا\\s*(?:باشا|بيه|بك|هانم|معلم|زعيم|غالي|ريس)${R}`),
  /طال\s*عمرك/u,
  /تحت\s*أمرك/u,
  /أؤمرني/u
];

const NON_EGYPTIAN_PHRASES = [
  "شلونك", "وش تبي", "ابتغي", "هلا والله", "يعطيك العافية",
  "تكرم عينك", "شو بدك", "كيفك", "هلق", "هلأ", "حياك الله",
  "طال عمرك", "ماذا تريد", "كيف يمكنني مساعدتك", "يرجى الانتظار",
  "سوف أقوم", "حسناً", "لا تتردد"
];

const MSA_WORDS = [
  "ماذا", "لماذا", "كيف", "سوف", "الآن", "أريد", "تريد", "أستطيع", "يمكنني", "بالطبع",
  "يسعدني", "هل", "ليس", "نعم", "عزيزي", "عزيزتي"
];
const MSA_RX: Array<[string, RegExp]> = MSA_WORDS.map((w) => [w, new RegExp(`${L}${norm(w)}${R}`, "u")]);

export function containsBannedAddress(text: string, context: PersonTitleContext = {}): boolean {
  const value = stripMarks(String(text ?? ""));
  if (BANNED_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(value))) {
    return true;
  }

  const allowed = resolvePersonAddressPolicy(context);
  const titles = TITLES.join("|");
  const vocative = new RegExp(`${L}يا\\s+(${titles})(?:\\s+([\\u0621-\\u064A]{2,18}))?${R}`, "gu");
  for (const match of value.matchAll(vocative)) {
    const normalized = canonicalTitle(match[1]);
    if (!allowed.canonicalTitle || normalized !== allowed.canonicalTitle) return true;
    if (match[2] && match[2] !== allowed.firstName) return true;
  }
  for(const match of value.matchAll(new RegExp(`${L}يا\\s+([\\p{L}'’-]{2,40})${R}`,"gu"))){
    const word=match[1];
    if(!ORDINARY_VOCATIVES.has(word) && word !== allowed.firstName && !(allowed.canonicalTitle && canonicalTitle(word) === allowed.canonicalTitle))return true;
  }
  return false;
}

export function detectNonEgyptian(text: string): string[] {
  const raw = stripMarks(String(text ?? ""));
  const normalized = norm(raw);
  const found = new Set<string>();

  for (const marker of NON_EGYPTIAN_PHRASES) {
    if (raw.includes(marker) || normalized.includes(norm(marker))) {
      found.add(marker);
    }
  }
  for (const [word, rx] of MSA_RX) {
    if (rx.test(normalized)) {
      found.add(word);
    }
  }
  return [...found];
}

/**
 * Sanitize agent text for speech and return both the cleaned string and the list of
 * rule labels that fired (used by CallMetrics.honorificHits and tests).
 */
export function sanitizeForSpeechWithViolations(
  raw: string,
  context: PersonTitleContext = {}
): SanitizeResult {
  let value = stripMarks(String(raw ?? ""));
  if (!value) return { text: "", violations: [] };

  const policy = resolvePersonAddressPolicy(context);
  const feminine = policy.gender === "female";
  const violations: string[] = [];

  value = value
    .replace(/\*([^*]*)\*/gu, "$1")
    .replace(/\[[^\]]*\]/gu, "")
    .replace(/\([^)]*(?:ضحك|تنهد|صمت|نبرة|بهدوء|بحماس|pause|laugh|sigh)[^)]*\)/giu, "")
    .replace(/[#_`~>]/gu, "");

  const applyRule = (label: string, rx: RegExp, replacer: string | ((...args: any[]) => string)) => {
    const next = typeof replacer === "function" ? value.replace(rx, replacer) : value.replace(rx, replacer);
    if (next !== value) violations.push(label);
    value = next;
  };

  let usedPreferredAddress = false;
  applyRule("ya_fandem", re(`${L}يا\\s*(?:أ|ا)?فندم([،,]?)${R}`), (_match: string, punctuation: string) => {
    if (policy.firstName && !usedPreferredAddress) {
      usedPreferredAddress = true;
      return policy.preferredAddress + (punctuation || "");
    }
    return "";
  });

  applyRule("fandem", re(`${L}(?:أ|ا)?فندم${R}`), "");
  applyRule("hadretak_me3ak", re(`مع\\s+حضرتك`), feminine ? "معاكي" : "معاك");
  applyRule("hadretak_3ndak", re(`عند\\s+حضرتك`), feminine ? "عندك" : "عندك");
  applyRule("hadretak_mennak", re(`من\\s+حضرتك`), "منك");
  applyRule("hadretak_3annak", re(`عن\\s+حضرتك`), "عنك");
  applyRule("hadretak_lak", re(`${L}لحضرتك${R}`), feminine ? "ليكي" : "ليك");
  applyRule("hadretak_bak", re(`${L}بحضرتك${R}`), feminine ? "بيكي" : "بيك");
  applyRule("hadretak_om", re(`${L}حضرتكم${R}`), "إنتو");
  applyRule("hadretak_base", re(`${L}([وف]?)حضرتك${R}`), `$1${feminine ? "إنتي" : "إنت"}`);
  applyRule("sayadtak_pl", re(`${L}(?:سيادتكم|سعادتكم)${R}`), "إنتو");
  applyRule("sayadtak_sg", re(`${L}([وف]?)(?:سيادتك|سعادتك)${R}`), `$1${feminine ? "إنتي" : "إنت"}`);
  applyRule("servile_phrase", /طال\s*عمرك|تحت\s*أمرك|أؤمرني|أمرك\s*يا/gu, "");
  applyRule("vocative_slang", re(`${L}يا\\s*(?:باشا|بيه|بك|هانم|معلم|زعيم|غالي|ريس)${R}`), "");

  const vocative = new RegExp(
    `${L}يا\\s+(دكتورة|دكتوره|دكتور|باشمهندسة|باشمهندسه|باشمهندس|مهندسة|مهندسه|مهندس|أستاذة|أستاذه|استاذة|استاذه|أستاذ|استاذ|مستر|كابتن|شيخ)(?:\\s+([\\u0621-\\u064A]{2,18}))?${R}`,
    "gu"
  );
  const beforeVocative = value;
  value = value.replace(vocative, (_match, rawTitle: string, rawName?: string) => {
    const title = canonicalTitle(rawTitle);
    const titleMatches = title && policy.canonicalTitle === title;
    const nameMatches = !rawName || Boolean(policy.firstName && rawName === policy.firstName);
    if (titleMatches && nameMatches) return `يا ${title}${rawName ? ` ${rawName}` : ""}`;
    if (titleMatches) return `يا ${title}`;
    if (rawName && policy.firstName && rawName === policy.firstName) return `يا ${rawName}`;
    return "";
  });
  if (value !== beforeVocative) violations.push("vocative_title");

  // Bare personal addresses need the same explicit evidence as titled addresses.
  // Keep ordinary Egyptian expressions such as "يا ريت" and "يا سلام".
  applyRule("unverified_caller_name",new RegExp(`${L}يا\\s+([\\p{L}'’-]{2,40})${R}`,"gu"),(_match:string,word:string)=>{
    if(ORDINARY_VOCATIVES.has(word) || word === policy.firstName || canonicalTitle(word) === policy.canonicalTitle && Boolean(policy.canonicalTitle))return `يا ${word}`;
    return "";
  });
  applyRule("unverified_greeting_name",/(صباح الخير|مساء الخير|أهلا|اهلا)\s+([\p{L}'’-]{2,40})(?=[،,.!?؟]|$)/gu,(match:string,greeting:string,word:string)=>{
    if(word === policy.firstName || NON_NAME_WORDS.has(word))return match;
    return greeting;
  });

  value = value
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\s+([،,.!?؟؛])/gu, "$1")
    .replace(/^[\s،,]+/gu, "")
    .trim();

  return { text: value, violations };
}

/**
 * Backward-compatible string sanitizer used by existing voice agent & test suite.
 */
export function sanitizeForSpeech(raw: string, context: PersonTitleContext = {}): string {
  return sanitizeForSpeechWithViolations(raw, context).text;
}

/**
 * Prevents the model from claiming a business action (booking/registration/ticket) succeeded
 * when `actionConfirmed` is false (REG-01 / REG-02 and state machine action guard).
 */
export function guardUnconfirmedActionClaim(
  speech: string,
  opts: {
    actionConfirmed: boolean;
    hasValidPhone: boolean;
    awaitingConfirmationLabels?: string[];
    missingSlotLabels?: string[];
    informational?: boolean;
  }
): { text: string; blockedClaim: boolean } {
  const cleaned = String(speech ?? "").trim();
  if (!cleaned) return { text: "", blockedClaim: false };
  if (opts.actionConfirmed && opts.hasValidPhone) {
    return { text: cleaned, blockedClaim: false };
  }

  const falseCompletionPattern =
    /(?:تم\s+(?:تسجيل|تأكيد|حجز)|اتسجل(?:ت|ك)?|اتحجز(?:لك|ت)?|(?:سجلت|حجزت|أكدت)لك|أكدت\s+الحجز|الحجز\s+اتأكد)/u;

  if (!falseCompletionPattern.test(cleaned)) {
    return { text: cleaned, blockedClaim: false };
  }

  if (opts.informational) {
    // Explaining a hypothetical workflow is not a request for the listener's
    // phone number. Still block an unqualified claim that we performed an action.
    const hypothetical = /(?:مثال|مثلا|سيناريو|افترض|لو\s)/u.test(cleaned);
    const callerSpecificClaim = /(?:تم\s+(?:تسجيل|تأكيد|حجز)\s+(?:طلبك|موعدك|حجزك|شكواك)|(?:سجلت|حجزت|أكدت)\s*(?:لك|طلبك|حجزك)|(?:طلبك|حجزك|موعدك|شكواك)\s+(?:اتسجل|اتأكد|اتحجز)|اتحجزلك|اتسجل(?:ت|ك)?\s+(?:طلبك|حجزك|شكواك))/u.test(cleaned);
    return hypothetical || !callerSpecificClaim
      ? { text: cleaned, blockedClaim: false }
      : { text: "للتوضيح، مفيش طلب اتنفذ في المكالمة دي.", blockedClaim: true };
  }

  if (!opts.hasValidPhone) {
    return {
      text: "عشان أسجل الطلب بشكل صحيح، محتاج رقم الموبايل المكون من حداشر رقم الأول.",
      blockedClaim: true
    };
  }

  if (opts.missingSlotLabels && opts.missingSlotLabels.length > 0) {
    return {
      text: `لسه محتاج أعرف ${opts.missingSlotLabels[0]} عشان أكمل التسجيل.`,
      blockedClaim: true
    };
  }

  if (opts.awaitingConfirmationLabels && opts.awaitingConfirmationLabels.length > 0) {
    return {
      text: `قبل ما أأكد التسجيل، البيانات دي مظبوطة كده صح؟`,
      blockedClaim: true
    };
  }

  return {
    text: "ثواني أراجع البيانات وأأكدلك الطلب.",
    blockedClaim: true
  };
}

/** Prevent false definitive booking claims when the request is only locally recorded. */
export function guardUnconfirmedBookingClaim(speech: string, bookingConfirmed: boolean): string {
  if (bookingConfirmed) return speech;
  if (/(?:اتحجز(?:لك|ت)?|الحجز\s+اتأكد|موعدك\s+اتأكد|أكدت\s+الحجز|تم\s+(?:تأكيد|حجز)\s*(?:ال?موعد|الحجز)?)/u.test(speech)) {
    return "طلب الموعد اتسجل، ولسه محتاج تأكيد من المنشأة.";
  }
  return speech;
}

/**
 * Buffers streamed LLM deltas and releases them at natural prosodic boundaries so TTS
 * receives complete phrases while multi-word banned expressions never split across chunks.
 */
export class SpeechChunker {
  #buf = "";

  constructor(private readonly onChunk: (text: string) => void) {}

  push(delta: string): void {
    this.#buf += delta;
    for (;;) {
      const cut = this.#findCut();
      if (cut < 0) return;
      const piece = this.#buf.slice(0, cut + 1);
      this.#buf = this.#buf.slice(cut + 1);
      if (piece.trim()) this.onChunk(piece);
    }
  }

  flush(): void {
    const rest = this.#buf;
    this.#buf = "";
    if (rest.trim()) this.onChunk(rest);
  }

  discard(): void {
    this.#buf = "";
  }

  #findCut(): number {
    const b = this.#buf;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c === "!" || c === "?" || c === "؟" || c === "\n") return i;
      if (c === "." && i + 1 < b.length && /\s/.test(b[i + 1])) return i;
      if ((c === "،" || c === "," || c === "؛") && i >= 45) return i;
    }
    return -1;
  }
}
